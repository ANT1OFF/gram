import {
  RECAP_DISMISSED_FAST_MS,
  helperOn,
  latestWrapUp,
  liveWrapUpButtons,
  planProgress,
  recapFacts,
  type RecapView,
  type GramUIMessage,
  type ThreadId,
  type ThreadSummary,
  type WrapUpButton,
  type WrapUpData,
} from "@gram/contracts";
import { History, ListChecks, TextCursorInput, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { useWindowAttended } from "@/desktop/use-window-attended";
import { CreatePrDialog } from "@/components/create-pr-dialog";
import { Hint } from "@/components/hint";
import { usePushBranch } from "@/components/push-button";
import { Button } from "@/components/ui/button";
import { agoText } from "@/lib/time";
import { cn } from "@/lib/utils";
import { ExpandPresence, Shimmer } from "@/motion";
import { feedLoaded, feedMessages, useThreadFeed } from "@/stores/feeds";
import { useServerSettings } from "@/settings-sync/store";
import { typeIntoField } from "@/composer/ghost";
import { useDraftStore } from "@/stores/drafts";
import { useLayoutStore, type RightPanelTab } from "@/stores/layout";
import { useSuggestionsStore } from "@/stores/suggestions";
import { useThreadsStore } from "@/stores/threads";

import { useTallerThanPaneShare } from "./pane-height";

/**
 * The share of the pane a recap's text may take before it folds to its first sentence: a grid pane
 * can be short enough that the whole of it pushes the composer out of sight.
 */
const RECAP_SHARE = 0.25;

/** How long an open waits on the server before saying a recap is on its way. */
const SKELETON_AFTER_MS = 300;

const BUSY = new Set<ThreadSummary["status"]>([
  "starting",
  "running",
  "needsApproval",
  "needsInput",
]);

/** When the transcript's last user message was sent; 0 without one. */
const lastSentAt = (messages: readonly GramUIMessage[]): number =>
  messages.findLast((m) => m.role === "user")?.metadata?.createdAt ?? 0;

/** The recap up to the end of its first sentence, for when a request card has the room. */
export const firstSentence = (text: string): string => text.split(/(?<=[.!?])\s+/)[0] ?? text;

/**
 * The panel a recap fact opens: the changed files their diff, the PR its tab; the rest only say.
 * `recapFacts` puts the changed files first when there are any, and the PR as `#N state`.
 */
export const factPanel = (
  fact: string,
  index: number,
  git: ThreadSummary["git"],
): RightPanelTab | undefined => {
  if (index === 0 && (git?.changedFiles ?? 0) > 0) return "diff";
  if (git?.pr !== undefined && fact.startsWith(`#${git.pr.number} `)) return "pr";
  return undefined;
};

/**
 * What to type at the end of a draft for `withNextStep`'s result: `next` on a line of its own, or in
 * place of a draft that is only whitespace (`selectEnd` selects all of that one).
 */
export const nextStepInsert = (draft: string, next: string): string =>
  draft.trim() === "" || draft.endsWith("\n") ? next : `\n${next}`;

/** `field` with the caret at its end, or all of it selected while it is only whitespace. */
const selectEnd = (field: HTMLTextAreaElement): HTMLTextAreaElement => {
  const end = field.value.length;
  field.focus();
  field.setSelectionRange(field.value.trim() === "" ? 0 : end, end);
  return field;
};

/** The composer's text with `next` after it, on a line of its own; never sent. */
export const withNextStep = (draft: string, next: string): string =>
  draft.trim() === "" ? next : `${draft.replace(/\s+$/, "")}\n${next}`;

/**
 * Whether a recap still describes the thread: nothing happened since it was made, and no turn is
 * running. Sending a message is something happening, so the card goes once you send.
 */
const recapCurrent = (view: RecapView, summary: ThreadSummary | undefined): boolean =>
  summary !== undefined &&
  !BUSY.has(summary.status) &&
  summary.thread.lastActivityAt <= view.lastActiveAt;

/**
 * "Where you left off": what happened in a thread you're coming back to, what's next, and facts from
 * git and GitHub. Asked for each time the pane comes into focus; the server decides whether the
 * thread deserves one (`recapDue`). A pending request has precedence, and folds it to its first
 * sentence, as does a pane too short for the whole of it, with a way to read the rest. Once a turn
 * starts it's spent: what it described is no longer where you left off.
 */
export function RecapCard({
  threadId,
  focused: paneFocused,
}: {
  threadId: ThreadId;
  focused: boolean;
}) {
  const api = useApi();
  // Coming back to the app counts as coming back to the pane it left focused.
  const attended = useWindowAttended();
  const focused = paneFocused && attended;
  const summary = useThreadsStore((s) => s.byId[threadId]);
  const [card, setCard] = useState<{
    readonly view: RecapView;
    /** Epoch ms after which a message sent means the thread has moved on from the recap. */
    readonly since: number;
    readonly gone?: boolean;
  }>();
  const since = card?.since;
  const sentSince = useThreadFeed(
    threadId,
    (s) => since !== undefined && lastSentAt(s.messages) > since,
  );
  /**
   * The request whose answer is late enough to say so. Each one, when it settles, clears its own
   * and any older request's, never a newer one's.
   */
  const [waiting, setWaiting] = useState<number>();
  // The request of this spell of focus, if one was made: cleared when the pane loses focus, so
  // coming back asks again, and only the latest request's answer and spinner count.
  const asked = useRef<{ readonly id: number; readonly threadId: ThreadId } | undefined>(undefined);
  const requests = useRef(0);
  // Turns started in this thread since the card mounted: an answer to a request made before the
  // latest one started is about a thread that has since moved on, whether or not a card was up.
  const turns = useRef(0);

  useEffect(() => {
    if (!focused) {
      asked.current = undefined;
      return;
    }
    if (asked.current?.threadId === threadId) return;
    const request = { id: ++requests.current, threadId };
    asked.current = request;
    const turnsAtAsk = turns.current;
    // Before the transcript is in, what's sent can only be told apart once the answer comes.
    const sentAtAsk = feedLoaded(threadId) ? lastSentAt(feedMessages(threadId)) : undefined;
    const latest = () => asked.current?.id === request.id;
    // Not cancelled on cleanup: a second run of the effect in the same spell doesn't ask again, so
    // its answer has to land whenever it comes, unless a later request replaced it meanwhile.
    const skeleton = setTimeout(() => latest() && setWaiting(request.id), SKELETON_AFTER_MS);
    api
      .threadRecap(threadId)
      .then((next) => {
        if (!latest()) return;
        const status = useThreadsStore.getState().byId[threadId]?.status;
        // A turn that started while the server was making it has already moved on.
        const moved = turns.current !== turnsAtAsk || (status !== undefined && BUSY.has(status));
        setCard(
          next === null
            ? undefined
            : {
                view: next,
                // A message sent while the server was making it counts as sent after it.
                since: Math.max(next.lastActiveAt, sentAtAsk ?? lastSentAt(feedMessages(threadId))),
                gone: moved,
              },
        );
        // The recap's call also suggested what to say next, for the turn it covers.
        const settings = useServerSettings.getState().settings;
        const suggestOn = settings !== undefined && helperOn(settings, "suggest");
        // None is no answer: the server leaves them out when the plan moved during the call, and
        // offering that would take away replies already made for the new one.
        if (next?.turnId !== undefined && !moved && suggestOn && next.recap.replies.length > 0) {
          const { turnId, recap } = next;
          useSuggestionsStore.getState().offer({ threadId, turnId, replies: recap.replies });
        }
      })
      .catch((error: unknown) => console.warn("recap", error))
      .finally(() => {
        clearTimeout(skeleton);
        // An older request's line goes too: the newer answer is the one that counts.
        setWaiting((w) => (w !== undefined && w <= request.id ? undefined : w));
      });
  }, [api, focused, threadId]);

  // The renderer isn't told every turn's new `lastActivityAt`, so a turn starting is what ends it,
  // and a message landing in the transcript after it, which no quick turn can slip past.
  useEffect(
    () =>
      useThreadsStore.subscribe((s, previous) => {
        const status = s.byId[threadId]?.status;
        const before = previous.byId[threadId]?.status;
        if (status === undefined || !BUSY.has(status)) return;
        if (before === undefined || !BUSY.has(before)) turns.current += 1;
        setCard((c) => (c === undefined || c.gone ? c : { ...c, gone: true }));
      }),
    [threadId],
  );

  const shown = card?.view.threadId === threadId ? card.view : undefined;
  const current =
    shown !== undefined && card?.gone !== true && !sentSince && recapCurrent(shown, summary);
  // The agent's own box for the turn that just ended, straight from the transcript: it needs no
  // request, and no helper. `thread.recap` hands back the same one when the thread is opened later.
  const fromFeed = useThreadFeed(threadId, (s) => latestWrapUp(s.messages));
  const wrapUp = fromFeed ?? (current ? shown?.wrapUp : undefined);
  const [dismissedBox, setDismissedBox] = useState<string>();
  const boxOn =
    wrapUp !== undefined &&
    summary !== undefined &&
    !BUSY.has(summary.status) &&
    dismissedBox !== wrapUp.id;
  /** When the recap on screen first showed, for telling a quick dismissal from a considered one. */
  const shownAt = useRef<{ readonly view: RecapView; readonly at: number } | undefined>(undefined);
  useEffect(() => {
    // The helper's counts are about the helper's recaps; the agent's box is none of them.
    if (!current || shown === undefined || shown.wrapUp !== undefined) return;
    if (shownAt.current?.view === shown) return;
    shownAt.current = { view: shown, at: Date.now() };
    void api
      .recordHelperEvent({ kind: "recap", event: "shown" })
      .catch((error: unknown) => console.warn("recap", error));
  }, [api, current, shown]);

  const dismiss = () => {
    const at = shownAt.current?.at;
    const fast = at !== undefined && Date.now() - at < RECAP_DISMISSED_FAST_MS;
    setCard((c) => (c === undefined ? c : { ...c, gone: true }));
    void api
      .recordHelperEvent({ kind: "recap", event: fast ? "dismissedFast" : "dismissed" })
      .catch((error: unknown) => console.warn("recap", error));
  };

  const progress = summary?.plan === undefined ? undefined : planProgress(summary.plan);
  const folded = (summary?.pendingRequests.length ?? 0) > 0;
  const [fullText, setFullText] = useState<HTMLParagraphElement | null>(null);
  const long = useTallerThanPaneShare(fullText, RECAP_SHARE);
  const [readMore, setReadMore] = useState<RecapView>();
  const more = shown !== undefined && readMore === shown;
  const facts = recapFacts(summary?.git);

  return (
    <>
      {waiting !== undefined && focused && shown === undefined && !boxOn && (
        <div
          data-testid="recap-pending"
          className="my-2 flex items-center gap-2 px-3.5 py-1 text-xs text-muted-foreground"
        >
          <History aria-hidden className="size-3.5 text-primary" />
          <Shimmer>Where you left off…</Shimmer>
        </div>
      )}
      <ExpandPresence open={boxOn}>
        {wrapUp !== undefined && (
          <WrapUpBox
            threadId={threadId}
            wrapUp={wrapUp}
            // Opened after a break, the box is where you left off; at the turn's end, its recap.
            leftOff={current && shown?.wrapUp?.id === wrapUp.id ? shown.lastActiveAt : undefined}
            onDismiss={() => setDismissedBox(wrapUp.id)}
          />
        )}
      </ExpandPresence>
      <ExpandPresence open={current && wrapUp === undefined}>
        {shown !== undefined && (
          <section
            data-testid="recap"
            aria-label="Where you left off"
            // However it folds, the card as a whole keeps to a share of the pane: in a grid quarter
            // the plan strip and the header take their own rows, and the composer must still fit.
            className="my-2 max-h-[calc(var(--pane-height,100vh)*0.4)] overflow-y-auto rounded-(--radius-md) border border-primary/30 bg-primary/5 px-3.5 py-2.5 text-sm"
          >
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <History aria-hidden className="size-3.5 shrink-0 text-primary" />
              <span className="font-medium text-foreground">Where you left off</span>
              <span className="min-w-0 truncate">· Last active {agoText(shown.lastActiveAt)}</span>
              {progress !== undefined && progress.total > 0 && (
                <span data-testid="recap-progress" className="flex shrink-0 items-center gap-1">
                  · <ProgressRing {...progress} /> {progress.done} of {progress.total}
                </span>
              )}
              <Hint
                label="Dismiss"
                render={
                  <button
                    type="button"
                    aria-label="Dismiss the recap"
                    className="-my-1 ml-auto grid size-6 shrink-0 place-items-center rounded-sm hover:bg-accent hover:text-foreground"
                    onClick={dismiss}
                  />
                }
              >
                <X aria-hidden className="size-3.5" />
              </Hint>
            </div>
            <RecapText
              text={shown.recap.recap}
              folded={folded}
              long={long}
              more={more}
              measureRef={setFullText}
              onMore={(next) => setReadMore(next ? shown : undefined)}
            />
            {!folded && (shown.recap.next !== null || facts.length > 0) && (
              <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                {shown.recap.next !== null && (
                  <NextStep threadId={threadId} next={shown.recap.next} />
                )}
                {facts.length > 0 && (
                  <ul
                    aria-label="Facts"
                    className="ml-auto flex flex-wrap items-center text-muted-foreground"
                  >
                    {facts.map((fact, index) => {
                      const panel = factPanel(fact, index, summary?.git);
                      return (
                        <li
                          key={fact}
                          className="flex items-center before:px-1 before:content-['·'] first:before:hidden"
                        >
                          {panel === undefined ? (
                            fact
                          ) : (
                            <button
                              type="button"
                              data-testid="recap-fact-link"
                              title={panel === "diff" ? "Open the diff" : "Open the PR"}
                              onClick={() => useLayoutStore.getState().revealPanel(panel)}
                              className="rounded-sm text-link underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              {fact}
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}
          </section>
        )}
      </ExpandPresence>
    </>
  );
}

/**
 * The recap itself: in full, or its first sentence while a request waits or while the whole would
 * take more of the pane than `RECAP_SHARE`, then with More to read the rest in place. The hidden
 * copy is what says how tall the whole would be, however much of it shows.
 */
function RecapText({
  text,
  folded,
  long,
  more,
  measureRef,
  onMore,
}: {
  text: string;
  folded: boolean;
  long: boolean;
  more: boolean;
  measureRef: (el: HTMLParagraphElement | null) => void;
  onMore: (more: boolean) => void;
}) {
  const lead = firstSentence(text);
  const brief = !folded && long && !more && lead !== text;
  return (
    <div className="mt-1.5">
      {!folded && (
        <div aria-hidden className="invisible h-0 overflow-hidden">
          <p ref={measureRef} className="leading-relaxed">
            {text}
          </p>
        </div>
      )}
      <p
        data-testid="recap-text"
        className={cn(
          "overflow-y-auto leading-relaxed text-foreground/90",
          more
            ? "max-h-[calc(var(--pane-height,100vh)*0.45)]"
            : "max-h-[calc(var(--pane-height,100vh)*0.25)]",
        )}
      >
        {folded || brief ? lead : text}
        {(brief || (more && long)) && (
          <>
            {" "}
            <button
              type="button"
              data-testid="recap-more"
              aria-expanded={more}
              onClick={() => onMore(!more)}
              className="rounded-sm text-xs text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              {more ? "Less" : "More"}
            </button>
          </>
        )}
      </p>
    </div>
  );
}

/** A ring filled to the share of the plan's steps done. */
function ProgressRing({ done, total }: { done: number; total: number }) {
  const r = 5;
  const length = 2 * Math.PI * r;
  return (
    <svg aria-hidden viewBox="0 0 12 12" className="size-3 -rotate-90">
      <circle cx="6" cy="6" r={r} fill="none" strokeWidth="1.5" className="stroke-border" />
      <circle
        cx="6"
        cy="6"
        r={r}
        fill="none"
        strokeWidth="1.5"
        strokeDasharray={`${(length * done) / total} ${length}`}
        className="stroke-primary"
      />
    </svg>
  );
}

/**
 * The recap's next step, and a button that puts it in this thread's composer to edit and send; it is
 * never sent on its own.
 */
function NextStep({ threadId, next }: { threadId: ThreadId; next: string }) {
  const use = (button: HTMLElement) => {
    const composer = button
      .closest("[data-pane-index]")
      ?.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
    // Typed in where it can be, so ⌘Z takes the step back out, as an accepted suggestion does.
    if (composer && typeIntoField(selectEnd(composer), nextStepInsert(composer.value, next)))
      return;
    const drafts = useDraftStore.getState();
    drafts.setText(threadId, withNextStep(drafts.text[threadId] ?? "", next));
    requestAnimationFrame(() => {
      composer?.focus();
      composer?.setSelectionRange(composer.value.length, composer.value.length);
    });
  };
  return (
    <>
      <span className="text-muted-foreground">Next:</span>
      <span data-testid="recap-next" className="font-medium">
        {next}
      </span>
      <Hint
        label="Put in the composer"
        render={
          <button
            type="button"
            aria-label="Put the next step in the composer"
            data-testid="recap-next-use"
            className="-my-1 grid size-6 shrink-0 place-items-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            onClick={(event) => use(event.currentTarget)}
          />
        }
      >
        <TextCursorInput aria-hidden className="size-3.5" />
      </Hint>
    </>
  );
}

const notify = (kind: "info" | "error", title: string, body: string) =>
  useThreadsStore.getState().applyEvent({ type: "notify", kind, title, body });

/**
 * The agent's `wrap_up` box: its recap of the turn, and, when the next move is yours, its one
 * question with the buttons that answer it, its pick first. A reply sends its message as yours; an
 * app action is the control the thread's header has, so Create PR opens its dialog and merging
 * opens the PR panel, whose Merge asks first. A button whose control has nothing left to do goes.
 */
function WrapUpBox({
  threadId,
  wrapUp,
  leftOff,
  onDismiss,
}: {
  threadId: ThreadId;
  wrapUp: WrapUpData;
  /** When the thread was last active, when the box is shown as where you left off. */
  leftOff: number | undefined;
  onDismiss: () => void;
}) {
  const api = useApi();
  const git = useThreadsStore((s) => s.byId[threadId]?.git);
  const buttons = wrapUp.ask === undefined ? [] : liveWrapUpButtons(wrapUp, git);
  // One answer per box: while a reply is on its way, neither button sends another.
  const [sending, setSending] = useState(false);
  const reply = async (message: string) => {
    if (sending) return;
    setSending(true);
    try {
      await api.send(threadId, { text: message });
    } catch (error) {
      notify("error", "Couldn't send", errorMessage(error));
      setSending(false);
    }
  };
  return (
    <section
      data-testid="wrap-up"
      aria-label={leftOff === undefined ? "Turn recap" : "Where you left off"}
      className="my-2 max-h-[calc(var(--pane-height,100vh)*0.4)] overflow-y-auto rounded-(--radius-md) border border-primary/30 bg-primary/5 px-3.5 py-2.5 text-sm"
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {leftOff === undefined ? (
          <ListChecks aria-hidden className="size-3.5 shrink-0 text-primary" />
        ) : (
          <History aria-hidden className="size-3.5 shrink-0 text-primary" />
        )}
        <span className="font-medium text-foreground">
          {leftOff === undefined ? "Recap" : "Where you left off"}
        </span>
        {leftOff !== undefined && (
          <span className="min-w-0 truncate">· Last active {agoText(leftOff)}</span>
        )}
        <Hint
          label="Dismiss"
          render={
            <button
              type="button"
              aria-label="Dismiss the recap"
              className="-my-1 ml-auto grid size-6 shrink-0 place-items-center rounded-sm hover:bg-accent hover:text-foreground"
              onClick={onDismiss}
            />
          }
        >
          <X aria-hidden className="size-3.5" />
        </Hint>
      </div>
      <p data-testid="wrap-up-recap" className="mt-1.5 leading-relaxed text-foreground/90">
        {wrapUp.recap}
      </p>
      {wrapUp.ask !== undefined && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <p data-testid="wrap-up-ask" className="mr-auto font-medium">
            {wrapUp.ask}
          </p>
          {buttons.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              {buttons.map((button, index) => (
                <WrapUpAction
                  key={button.kind === "app" ? `app:${button.action}` : `reply:${button.label}`}
                  threadId={threadId}
                  button={button}
                  primary={index === 0}
                  sending={sending}
                  onReply={(message) => void reply(message)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * One of the box's buttons. A reply whose message says more than its label shows the message on
 * hover and to a screen reader, so what is sent in your name is never hidden behind its label.
 */
function WrapUpAction({
  threadId,
  button,
  primary,
  sending,
  onReply,
}: {
  threadId: ThreadId;
  button: WrapUpButton;
  primary: boolean;
  sending: boolean;
  onReply: (message: string) => void;
}) {
  const pushing = usePushBranch(threadId);
  const [creating, setCreating] = useState(false);
  const variant = primary ? "default" : "outline";

  const props = { type: "button", size: "xs", variant, "data-testid": "wrap-up-action" } as const;
  if (button.kind === "reply") {
    const { label, message } = button;
    const send = (
      <Button
        {...props}
        disabled={sending}
        aria-description={message === label ? undefined : `Sends: ${message}`}
        onClick={() => onReply(message)}
      />
    );
    return message === label ? (
      <Button {...props} disabled={sending} onClick={() => onReply(message)}>
        {label}
      </Button>
    ) : (
      <Hint label={`Sends: ${message}`} render={send}>
        {label}
      </Hint>
    );
  }
  switch (button.action) {
    case "push":
      return (
        <Button {...props} disabled={pushing.pending} onClick={() => void pushing.push()}>
          {(pushing.pending ? pushing.pendingLabel : pushing.label) ?? "Push"}
        </Button>
      );
    case "create_pr":
      return (
        <>
          <Button {...props} onClick={() => setCreating(true)}>
            Create PR
          </Button>
          {creating && <CreatePrDialog threadId={threadId} onClose={() => setCreating(false)} />}
        </>
      );
    case "merge":
      return (
        <Button {...props} onClick={() => useLayoutStore.getState().revealPanel("pr")}>
          Review and merge
        </Button>
      );
  }
}
