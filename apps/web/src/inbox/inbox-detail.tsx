import type { ThreadId, WorkspaceId } from "@gram/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { AlarmClock, X } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { useApi } from "@/api/context";
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { formatRelative } from "@/lib/time";
import { cn } from "@/lib/utils";
import { ThreadMachineMarker } from "@/thread/machine-marker";
import { holdAnswer, type SendAction } from "@/orchestration/ask-answer";
import {
  answerKey,
  clock,
  keyedByShortcut,
  SETTLE_MS,
  shortcutOptionAt,
  types,
} from "@/orchestration/ask-keys";
import {
  otherIndex,
  replyAction,
  replyId,
  type ApprovalShortcut,
  type Ask,
  type AskOption,
} from "@/orchestration/ask-model";
import { AskItem } from "@/orchestration/ask-stack";
import { useAskStackStore } from "@/orchestration/ask-stack-store";
import { FailureRowView } from "@/orchestration/failures-card";
import { itemText, type NeedsYouItem } from "@/orchestration/needs-you-items";
import { useDerivedAsks } from "@/orchestration/needs-you-store";
import { canDismiss, kindOf, useNeedsYouActions } from "@/orchestration/needs-you-row";
import { memoryQuestionCard, workerQuestionCard } from "@/orchestration/question-card-model";
import {
  OpenQuestion,
  useMemoryQuestionAnswer,
  useWorkerQuestionActions,
} from "@/orchestration/question-entry";
import { useThreadsStore } from "@/stores/threads";
import { AlwaysPreviewRequestCards, RequestCards, SheetRequestCards } from "@/thread/request-cards";
import { WaitingItemRow } from "@/thread/waiting-tray";

import { InboxContext } from "./inbox-context";

// The Inbox's detail pane: the item picked in its list, with everything it takes to answer it. An
// ask answered in place (an approval's verbs, a question's choices or a reply) is drawn as the Asks
// dock drew it, under the one answer rule: a click or 1–9 picks, Send answer or ⌘⏎ sends, and an
// approval's verbs act on a click; the answer waits out Undo before it goes. An ask read in full (a
// plan, a long request, an open or forwarded question) is its own card, as its thread draws it. A
// wait has Done, Copy or Open; a failure its next step. Each has Open thread, Later and, where it
// applies, Dismiss. Under it, what its thread said last and what it changed (`InboxContext`).

/** The Inbox's dialog: the pane's keys answer only from inside it. */
const INBOX = '[data-testid="inbox"]';

/**
 * Hands every key pressed inside the Inbox to `take` before the Inbox's own keys see it, while
 * mounted; a key `take` answers goes no further.
 */
function useInboxKeys(take: (event: KeyboardEvent) => boolean, enabled = true) {
  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (!enabled) return;
    if (event.defaultPrevented || event.isComposing || event.repeat) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(INBOX) == null) return;
    if (!take(event)) return;
    event.preventDefault();
    event.stopPropagation();
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKey(event);
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, []);
}

/** The buttons of an approval card's verbs, by the shortcut that presses them. */
const APPROVAL_VERBS: Readonly<Record<ApprovalShortcut, string>> = {
  "approval.allow": "approval-allow",
  "approval.always": "approval-always",
  "approval.deny": "approval-deny",
};

/**
 * The enabled verb button of the approval card in `root` that `event` presses by its shortcut, as
 * the thread's card is answered; none while focus types.
 */
const approvalVerbPressed = (
  event: KeyboardEvent,
  root: Element,
): HTMLButtonElement | undefined => {
  const target = event.target instanceof Element ? event.target : null;
  if (target !== null && types(target)) return undefined;
  for (const [shortcut, testId] of Object.entries(APPROVAL_VERBS)) {
    if (shortcutOptionAt([{ shortcut: shortcut as ApprovalShortcut }], event) < 0) continue;
    const button = root.querySelector<HTMLButtonElement>(
      `[data-testid="approval-card"] [data-testid="${testId}"]`,
    );
    return button === null || button.disabled ? undefined : button;
  }
  return undefined;
};

/**
 * Whether an ask is read in full before it is answered: every option it offers opens it. Any other
 * is answered in place, as the Asks dock answered it; a question's own card is a click away.
 */
export const answersInFull = (ask: Pick<Ask, "options">): boolean =>
  ask.options.length > 0 &&
  ask.options.every((option) => option.action.kind === "open" || option.action.kind === "board");

function MemoryQuestionFull({
  memory,
  orchestratorId,
}: {
  memory: NonNullable<Ask["memory"]>;
  orchestratorId: ThreadId | undefined;
}) {
  const answer = useMemoryQuestionAnswer(memory.workspaceId);
  return (
    <OpenQuestion
      card={memoryQuestionCard(memory.question, 0, orchestratorId)}
      compact={false}
      sheet
      unavailable={
        orchestratorId === undefined
          ? "Open the orchestrator first: the answer is a message to it"
          : undefined
      }
      onAnswer={answer(memory.question)}
    />
  );
}

function WorkerQuestionFull({ worker }: { worker: NonNullable<Ask["worker"]> }) {
  const actions = useWorkerQuestionActions(worker.workspaceId);
  return (
    <OpenQuestion
      card={workerQuestionCard(worker.question)}
      compact={false}
      sheet
      onAnswer={actions.answer(worker.question)}
      onDismiss={actions.dismiss(worker.question)}
    />
  );
}

/** An ask read in full: its own card, answered through its own path. */
function AskInFull({
  ask,
  orchestratorId,
  always,
}: {
  ask: Ask;
  orchestratorId: ThreadId | undefined;
  /** Opened by "Always allow this rule…": the card starts on what it would keep. */
  always: boolean;
}) {
  if (ask.memory !== undefined) {
    return <MemoryQuestionFull memory={ask.memory} orchestratorId={orchestratorId} />;
  }
  if (ask.worker !== undefined) return <WorkerQuestionFull worker={ask.worker} />;
  // A request is answered by its own card, the one its thread shows.
  const first = ask.group?.entries[0];
  if (first === undefined) return null;
  const cards = (
    <SheetRequestCards>
      <RequestCards threadId={first.threadId} requests={[first.request]} focused={false} />
    </SheetRequestCards>
  );
  return always ? <AlwaysPreviewRequestCards>{cards}</AlwaysPreviewRequestCards> : cards;
}

/**
 * An ask answered in place, under the one answer rule. Its keys answer it wherever focus is in the
 * Inbox, except in a field that types: 1–9 pick, ⌘⏎ sends the pick. An approval's verbs are keyed
 * as on the thread's card instead (1 Allow once, 2 Always allow this rule…, 3 Deny), and act on the
 * press, held for Undo as a click is.
 */
function AskInPlace({
  ask,
  onFull,
  card,
}: {
  ask: Ask;
  /** An option that opens the ask in full: the pane draws its card instead. */
  onFull: (option: AskOption) => void;
  /** One card of the phone's column: answered by touch, with no keys and no key hints. */
  card: boolean;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const problems = useAskStackStore((s) => s.problems);
  const [picked, setPicked] = useState<number>();
  const replyRef = useRef<HTMLInputElement | null>(null);
  // A key within a moment of the ask arriving here is a slip, not an answer. A new ask mounts anew.
  const since = useRef(0);
  useEffect(() => {
    since.current = clock();
  }, []);
  const onMemory = (workspaceId: WorkspaceId) => {
    void queryClient.invalidateQueries({ queryKey: ["memory", workspaceId] });
    void queryClient.invalidateQueries({ queryKey: ["orchestratorLedger", workspaceId] });
  };
  const send = (done: string, action: SendAction) => holdAnswer(api, ask, done, action, onMemory);
  const choose = (option: AskOption) => {
    const { action } = option;
    if (action.kind === "open" || action.kind === "board") return onFull(option);
    setPicked(undefined);
    send(option.done, action);
  };
  const reply = (text: string) => {
    const action = replyAction(ask, text);
    if (action === undefined) return;
    setPicked(undefined);
    useAskStackStore.getState().setReply(replyId(ask), "");
    send("Replied", action);
  };
  useInboxKeys((event) => {
    const target = event.target instanceof Element ? event.target : null;
    const mod = event.metaKey || event.ctrlKey;
    let pick: number | undefined;
    let sending = false;
    const verb = shortcutOptionAt(ask.options, event);
    if (verb >= 0) {
      if (target !== null && types(target)) return false;
      const option = ask.options[verb]!;
      if (clock() - since.current < SETTLE_MS) return true;
      choose(option);
      return true;
    }
    if (keyedByShortcut(ask.options) && !mod) return false;
    if (!mod && !event.altKey && !event.shiftKey && /^[1-9]$/.test(event.key)) {
      if (target !== null && types(target)) return false;
      pick = Number(event.key) - 1;
    } else if (mod && !event.altKey && !event.shiftKey && event.key === "Enter") {
      sending = true;
    } else return false;
    const index = pick ?? picked;
    if (index !== undefined && index === otherIndex(ask)) {
      // "Other…": its number picks it and puts the cursor in its field, ⌘⏎ sends what is typed.
      if (clock() - since.current < SETTLE_MS) return true;
      if (!sending) {
        setPicked(index);
        replyRef.current?.focus();
        return true;
      }
      const text = (useAskStackStore.getState().replies[replyId(ask)] ?? "").trim();
      if (text === "") return false;
      reply(text);
      return true;
    }
    const option = index === undefined ? undefined : ask.options[index];
    if (option === undefined || index === undefined) return false;
    if (clock() - since.current < SETTLE_MS) return true;
    if (sending) choose(option);
    else setPicked(index);
    return true;
  }, !card);
  const problem = ask.ids.map((id) => problems[id]).find((each) => each !== undefined);
  return (
    <AskItem
      ask={ask}
      current
      hints={card ? undefined : "plain"}
      arrived={false}
      problem={problem}
      picked={picked}
      onPick={setPicked}
      onChoose={choose}
      onReply={reply}
      replyRef={(element) => {
        replyRef.current = element;
      }}
    />
  );
}

/** An ask: in place, or its card when it is read in full first. */
function AskDetail({ item, card }: { item: NeedsYouItem; card: boolean }) {
  const ask = item.ask!;
  const [full, setFull] = useState(() => answersInFull(ask));
  const [always, setAlways] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const orchestratorId = useDerivedAsks(
    (s) => s.asks.find((w) => w.workspaceId === item.workspaceId)?.orchestratorThreadId,
  );
  // Read in full, the card's own answer rule: a number picks its choice, ⌘⏎ its Send answer; an
  // approval's verbs, its card's keys, as in the thread. A key within a moment of the card opening
  // is a slip: the press that opened "Always allow this rule…" never also saves it.
  const fullSince = useRef(0);
  useEffect(() => {
    if (full) fullSince.current = clock();
  }, [full]);
  useInboxKeys((event) => {
    if (!full || root.current === null) return false;
    const verb = approvalVerbPressed(event, root.current);
    if (verb !== undefined) {
      if (clock() - fullSince.current >= SETTLE_MS) verb.click();
      return true;
    }
    return answerKey(event, root.current);
  }, !card);
  return (
    <div ref={root} data-testid="inbox-ask" data-full={full || undefined}>
      {full ? (
        <AskInFull ask={ask} orchestratorId={orchestratorId} always={always} />
      ) : (
        <>
          <AskInPlace
            ask={ask}
            card={card}
            onFull={(option) => {
              setAlways(option.action.kind === "open" && option.action.always === true);
              setFull(true);
            }}
          />
          {/* A question's own card: its whole text with the answer row kept in sight however
              long it runs, the orchestrator's note, and Dismiss. Its own words are answered here
              already, in "Other…". */}
          {(ask.memory !== undefined || ask.worker !== undefined) && ask.options.length > 0 && (
            <Button
              size="xs"
              variant="ghost"
              data-testid="inbox-read-full"
              className="ml-8.5 text-muted-foreground"
              onClick={() => setFull(true)}
            >
              Read in full
            </Button>
          )}
        </>
      )}
    </div>
  );
}

/**
 * A stopped Watch PR, read in full: what stopped the watch, in plain words, and a one-click Resume
 * that turns Watch PR back on. Not a failure — the watch ended, it didn't fail; where the PR is gone
 * (merged or closed) there is nothing to resume, so it only says so.
 */
function WatchStoppedBody({ item, onResume }: { item: NeedsYouItem; onResume: () => void }) {
  const babysit = useThreadsStore((s) =>
    item.threadId === undefined ? undefined : s.byId[item.threadId]?.thread.babysit,
  );
  const reason = babysit?.stopReason;
  const gone = reason === "prMerged" || reason === "prClosed";
  return (
    <div data-testid="inbox-watch-stopped" className="flex flex-col gap-3 px-2">
      <p className="text-body break-words">
        {item.title}. Watch PR hands the merge to you; it does not merge on its own.
      </p>
      {!gone && (
        <div>
          <Button
            size="xs"
            variant="outline"
            data-testid="inbox-watch-resume"
            disabled={item.threadId === undefined}
            onClick={onResume}
          >
            Resume watching
          </Button>
        </div>
      )}
    </div>
  );
}

/** Whether a phone card answers its item in place; one that doesn't opens its thread on a tap. */
export const answersOnCard = (item: NeedsYouItem): boolean =>
  item.ask !== undefined
    ? !answersInFull(item.ask)
    : item.wait !== undefined
      ? item.threadId !== undefined
      : item.kind === "watch" || item.failure !== undefined;

/** What a tap on a card lands on that is a control of its own, not the card. */
const CONTROL = "button, a, input, textarea, select, label, [role='radio'], [role='checkbox']";

/**
 * The selected item in full, with its answers, Open thread, Later and Dismiss. On a phone, `card`:
 * one card of the Needs you column, the same answers by touch, without its thread's context; one
 * with nothing to answer in place (a plan, a long request) says what it asks, and a tap opens it.
 */
export function InboxDetail({
  item,
  now,
  card = false,
  onOpenThread,
}: {
  item: NeedsYouItem;
  now: number;
  card?: boolean;
  onOpenThread: (item: NeedsYouItem) => void;
}) {
  const actions = useNeedsYouActions();
  const kind = kindOf(item);
  const where = [item.workspace, item.where === "" ? undefined : item.where]
    .filter((part) => part !== undefined)
    .join(" · ");
  const inPlace = !card || answersOnCard(item);
  const opens = !inPlace && item.threadId !== undefined;
  return (
    <section
      aria-label={kind.label}
      data-testid={card ? "inbox-card" : "inbox-detail"}
      data-key={item.key}
      data-kind={item.kind}
      data-opens={opens || undefined}
      onClick={
        opens
          ? (event) => {
              if (event.target instanceof Element && event.target.closest(CONTROL) !== null) return;
              onOpenThread(item);
            }
          : undefined
      }
      className={
        card
          ? "flex flex-col rounded-xl border border-border bg-surface-3 pb-2"
          : "flex min-h-0 flex-1 flex-col"
      }
    >
      {/* A quiet line over the request: its kind, where it is from and when, and what else can be
          done with it. The request itself, under it, is what the pane leads with. */}
      <header className="flex shrink-0 items-start gap-2 px-4 pt-3 pb-1">
        <div className="min-w-0 flex-1">
          <h2 className="text-meta font-medium text-foreground">{kind.label}</h2>
          <p
            data-testid="inbox-detail-where"
            className={cn("text-meta break-words text-muted-foreground", !item.owned && "italic")}
          >
            {[where, item.at === undefined ? undefined : formatRelative(item.at, now)]
              .filter((part) => part !== undefined && part !== "")
              .join(" · ")}
            {/* The other machine its thread runs on, if any, after where it is from. */}
            {item.threadId !== undefined && (
              <ThreadMachineMarker
                threadId={item.threadId}
                testId="inbox-detail-machine"
                side="bottom"
                className="ml-1.5 inline-flex align-bottom not-italic"
              />
            )}
          </p>
        </div>
        {!card && (
          <>
            <Button
              size="xs"
              variant="ghost"
              data-testid="inbox-open-thread"
              disabled={item.threadId === undefined}
              title={
                item.threadId === undefined ? "No thread to open" : `Open ${item.where} at it (⏎)`
              }
              onClick={() => onOpenThread(item)}
            >
              {card ? "Open" : "Open thread"}
            </Button>
            <Hint
              label="Later (1 hour)"
              side="bottom"
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Later: ${itemText(item)}`}
                  data-testid="inbox-later"
                  onClick={() => actions.later(item)}
                />
              }
            >
              <AlarmClock aria-hidden />
            </Hint>
            {canDismiss(item) && (
              <Hint
                label={item.kind === "failure" ? "Dismiss until it fails again" : "Dismiss"}
                side="bottom"
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Dismiss: ${itemText(item)}`}
                    data-testid="inbox-dismiss"
                    onClick={() => actions.dismiss(item)}
                  />
                }
              >
                <X aria-hidden />
              </Hint>
            )}
          </>
        )}
      </header>
      <div
        data-testid="inbox-detail-body"
        className={card ? "px-2 pt-1" : "min-h-0 flex-1 overflow-y-auto px-2 pt-1 pb-3"}
      >
        {!inPlace ? (
          // What it asks, where its kind (the line above) doesn't already say it.
          item.title !== kind.label && (
            <p data-testid="inbox-card-summary" className="px-2 pb-1 text-reading break-words">
              {item.title}
              {item.command !== undefined && (
                <>
                  {" "}
                  <code className="font-mono text-body break-all">{item.command}</code>
                </>
              )}
            </p>
          )
        ) : item.ask !== undefined ? (
          // A new ask starts afresh: nothing picked, read in place unless it must be read in full.
          <AskDetail key={item.key} item={item} card={card} />
        ) : item.wait !== undefined && item.threadId !== undefined ? (
          <ul className="px-2">
            <WaitingItemRow
              key={item.key}
              threadId={item.threadId}
              view={item.wait.view}
              item={item.wait.item}
              now={now}
              elsewhere
              defaultExpanded
              onDone={() => actions.done(item)}
            />
          </ul>
        ) : item.kind === "watch" ? (
          <WatchStoppedBody item={item} onResume={() => actions.resume(item)} />
        ) : item.failure !== undefined ? (
          <ul>
            <FailureRowView item={item.failure} />
          </ul>
        ) : null}
        {/* A thread gone with its worker has nothing to read; a card leaves it to its thread. */}
        {!card && item.threadId !== undefined && item.owned && (
          <InboxContext key={item.threadId} threadId={item.threadId} />
        )}
      </div>
      {/* A phone card's actions in words, at the card's foot where a thumb is: a glyph alone in
          the corner was a 28 px guess. */}
      {card && (
        <footer data-testid="inbox-card-actions" className="flex items-center gap-1 px-2 pt-1">
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Later: ${itemText(item)}`}
            data-testid="inbox-later"
            onClick={() => actions.later(item)}
          >
            <AlarmClock aria-hidden />
            Later
          </Button>
          {canDismiss(item) && (
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Dismiss: ${itemText(item)}`}
              data-testid="inbox-dismiss"
              onClick={() => actions.dismiss(item)}
            >
              <X aria-hidden />
              Dismiss
            </Button>
          )}
          {item.threadId !== undefined && (
            <Button
              size="sm"
              variant="outline"
              className="ml-auto"
              data-testid="inbox-open-thread"
              onClick={() => onOpenThread(item)}
            >
              Open
            </Button>
          )}
        </footer>
      )}
    </section>
  );
}
