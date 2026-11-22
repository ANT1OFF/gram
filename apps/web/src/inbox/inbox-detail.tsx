import type { ThreadId, WorkspaceId } from "@gram/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { AlarmClock, X } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { useApi } from "@/api/context";
import { openContentUrl } from "@/api/open-external";
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { formatRelative } from "@/lib/time";
import { cn } from "@/lib/utils";
import { ThreadMachineMarker } from "@/thread/machine-marker";
import { askFingerprint } from "@/orchestration/ask-actions";
import { holdAnswer, holdOneAnswer, type SendAction } from "@/orchestration/ask-answer";
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
import { BRANCH_TARGET } from "@/panels/turn-diff";
import { useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";
import { AlwaysPreviewRequestCards, RequestCards, SheetRequestCards } from "@/thread/request-cards";
import { waitLinkOf } from "@/thread/waiting-model";
import { WaitingItemRow } from "@/thread/waiting-tray";

import { InboxContext } from "./inbox-context";
import { InboxPublish } from "./inbox-publish";
import { publishesBranch } from "./inbox-publish-model";

const INBOX = '[data-testid="inbox"]';

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

const APPROVAL_VERBS: Readonly<Record<ApprovalShortcut, string>> = {
  "approval.allow": "approval-allow",
  "approval.always": "approval-always",
  "approval.deny": "approval-deny",
};

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

function AskInFull({
  ask,
  orchestratorId,
  always,
}: {
  ask: Ask;
  orchestratorId: ThreadId | undefined;
  always: boolean;
}) {
  if (ask.memory !== undefined) {
    return <MemoryQuestionFull memory={ask.memory} orchestratorId={orchestratorId} />;
  }
  if (ask.worker !== undefined) return <WorkerQuestionFull worker={ask.worker} />;
  const first = ask.group?.entries[0];
  if (first === undefined) return null;
  const cards = (
    <SheetRequestCards>
      <RequestCards threadId={first.threadId} requests={[first.request]} focused={false} />
    </SheetRequestCards>
  );
  return always ? <AlwaysPreviewRequestCards>{cards}</AlwaysPreviewRequestCards> : cards;
}

function AskInPlace({
  ask,
  onFull,
  card,
}: {
  ask: Ask;
  onFull: (option: AskOption) => void;
  card: boolean;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const problems = useAskStackStore((s) => s.problems);
  const [picked, setPicked] = useState<number>();
  const replyRef = useRef<HTMLInputElement | null>(null);
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

function AskDetail({ item, card }: { item: NeedsYouItem; card: boolean }) {
  const ask = item.ask!;
  const [full, setFull] = useState(() => answersInFull(ask));
  const [always, setAlways] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const orchestratorId = useDerivedAsks(
    (s) => s.asks.find((w) => w.workspaceId === item.workspaceId)?.orchestratorThreadId,
  );
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
  const api = useApi();
  const actions = useNeedsYouActions();
  const kind = kindOf(item);
  const link = item.wait === undefined ? undefined : waitLinkOf(item.wait.item);
  const where = [item.workspace, item.where === "" ? undefined : item.where]
    .filter((part) => part !== undefined)
    .join(" · ");
  const inPlace = !card || answersOnCard(item);
  const opens = !inPlace && item.threadId !== undefined;
  const publishing = item.ask?.group?.entries.filter((entry) => publishesBranch(entry.request));
  const reviewChanges = (threadId: ThreadId) => {
    onOpenThread(
      threadId === item.threadId
        ? item
        : { ...item, threadId, ask: undefined, messageId: undefined },
    );
    const layout = useLayoutStore.getState();
    layout.requestPanel({ threadId, panel: "diff", target: BRANCH_TARGET }, threadId);
    layout.revealPanel("diff", { thread: true });
  };
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
            {link !== undefined && (
              <Button
                size="xs"
                variant="outline"
                data-testid="inbox-open-link"
                title={link.url}
                onClick={() =>
                  void openContentUrl(api, link.url).catch((error: unknown) =>
                    console.error("inbox: open the link", error),
                  )
                }
              >
                Open {link.host}
              </Button>
            )}
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
          <AskDetail key={askFingerprint(item.ask)} item={item} card={card} />
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
        {!card && publishing !== undefined && publishing.length > 0 && (
          <InboxPublish
            entries={publishing}
            onReview={reviewChanges}
            onDecide={(entry, decision) => holdOneAnswer(api, entry, decision)}
          />
        )}
        {!card && item.threadId !== undefined && item.owned && (
          <InboxContext key={item.threadId} threadId={item.threadId} />
        )}
      </div>
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
