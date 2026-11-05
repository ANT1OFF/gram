import type { ThreadId, WorkspaceId } from "@gram/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { AlarmClock, SquareArrowOutUpRight, X } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { useApi } from "@/api/context";
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { formatRelative } from "@/lib/time";
import { cn } from "@/lib/utils";
import { holdAnswer, type SendAction } from "@/orchestration/ask-answer";
import { answerKey, clock, SETTLE_MS, types } from "@/orchestration/ask-keys";
import { replyAnswer, type Ask, type AskOption } from "@/orchestration/ask-model";
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
import { RequestCards, SheetRequestCards } from "@/thread/request-cards";
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
function useInboxKeys(take: (event: KeyboardEvent) => boolean) {
  const onKey = useEffectEvent((event: KeyboardEvent) => {
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
function AskInFull({ ask, orchestratorId }: { ask: Ask; orchestratorId: ThreadId | undefined }) {
  if (ask.memory !== undefined) {
    return <MemoryQuestionFull memory={ask.memory} orchestratorId={orchestratorId} />;
  }
  if (ask.worker !== undefined) return <WorkerQuestionFull worker={ask.worker} />;
  // A request is answered by its own card, the one its thread shows.
  const first = ask.group?.entries[0];
  if (first === undefined) return null;
  return (
    <SheetRequestCards>
      <RequestCards threadId={first.threadId} requests={[first.request]} focused={false} />
    </SheetRequestCards>
  );
}

/**
 * An ask answered in place, under the one answer rule. Its keys answer it wherever focus is in the
 * Inbox, except in a field that types: 1–9 pick, ⌘⏎ sends the pick.
 */
function AskInPlace({
  ask,
  onFull,
}: {
  ask: Ask;
  /** An option that opens the ask in full: the pane draws its card instead. */
  onFull: () => void;
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
    if (action.kind === "open" || action.kind === "board") return onFull();
    setPicked(undefined);
    send(option.done, action);
  };
  const reply = (text: string) => {
    if (ask.freeForm === undefined) return;
    send(
      "Replied",
      ask.worker !== undefined
        ? { kind: "worker", answer: text }
        : ask.memory === undefined
          ? { kind: "answer", answer: replyAnswer(ask.freeForm.question, text) }
          : { kind: "memory", answer: text },
    );
  };
  useInboxKeys((event) => {
    const target = event.target instanceof Element ? event.target : null;
    const mod = event.metaKey || event.ctrlKey;
    let pick: number | undefined;
    let sending = false;
    if (!mod && !event.altKey && !event.shiftKey && /^[1-9]$/.test(event.key)) {
      if (target !== null && types(target)) return false;
      pick = Number(event.key) - 1;
    } else if (mod && !event.altKey && !event.shiftKey && event.key === "Enter") {
      sending = true;
    } else return false;
    const index = pick ?? picked;
    const option = index === undefined ? undefined : ask.options[index];
    if (option === undefined || index === undefined) return false;
    if (clock() - since.current < SETTLE_MS) return true;
    if (sending) choose(option);
    else setPicked(index);
    return true;
  });
  const problem = ask.ids.map((id) => problems[id]).find((each) => each !== undefined);
  return (
    <AskItem
      ask={ask}
      current
      hints="plain"
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
function AskDetail({ item }: { item: NeedsYouItem }) {
  const ask = item.ask!;
  const [full, setFull] = useState(() => answersInFull(ask));
  const root = useRef<HTMLDivElement>(null);
  const orchestratorId = useDerivedAsks(
    (s) => s.asks.find((w) => w.workspaceId === item.workspaceId)?.orchestratorThreadId,
  );
  // Read in full, the card's own answer rule: a number picks its choice, ⌘⏎ its Send answer.
  useInboxKeys((event) => full && root.current !== null && answerKey(event, root.current));
  return (
    <div ref={root} data-testid="inbox-ask" data-full={full || undefined}>
      {full ? (
        <AskInFull ask={ask} orchestratorId={orchestratorId} />
      ) : (
        <>
          <AskInPlace ask={ask} onFull={() => setFull(true)} />
          {/* A question's own card: an answer in words too ("Other…"), and its answer row kept in
              sight however long it runs. */}
          {(ask.memory !== undefined || ask.worker !== undefined) && ask.options.length > 0 && (
            <Button
              size="xs"
              variant="ghost"
              data-testid="inbox-read-full"
              className="ml-8.5 text-muted-foreground"
              onClick={() => setFull(true)}
            >
              Write your own answer
            </Button>
          )}
        </>
      )}
    </div>
  );
}

/** The selected item in full, with its answers, Open thread, Later and Dismiss. */
export function InboxDetail({
  item,
  now,
  onOpenThread,
}: {
  item: NeedsYouItem;
  now: number;
  onOpenThread: (item: NeedsYouItem) => void;
}) {
  const actions = useNeedsYouActions();
  const kind = kindOf(item);
  const where = [item.workspace, item.where === "" ? undefined : item.where]
    .filter((part) => part !== undefined)
    .join(" · ");
  return (
    <section
      aria-label={kind.label}
      data-testid="inbox-detail"
      data-key={item.key}
      data-kind={item.kind}
      className="flex min-h-0 flex-1 flex-col"
    >
      <header className="flex shrink-0 items-start gap-2 border-b border-border px-4 py-3">
        <kind.icon
          aria-hidden
          className={cn(
            "mt-0.5 size-4 shrink-0",
            item.kind === "failure" ? "text-destructive" : "text-status-needs-mark",
          )}
        />
        <div className="min-w-0 flex-1">
          <h2 className="text-body-strong">{kind.label}</h2>
          <p
            data-testid="inbox-detail-where"
            className={cn("text-meta break-words text-muted-foreground", !item.owned && "italic")}
          >
            {[where, item.at === undefined ? undefined : formatRelative(item.at, now)]
              .filter((part) => part !== undefined && part !== "")
              .join(" · ")}
          </p>
        </div>
        <Button
          size="xs"
          variant="ghost"
          data-testid="inbox-open-thread"
          disabled={item.threadId === undefined}
          title={item.threadId === undefined ? "No thread to open" : `Open ${item.where} at it`}
          onClick={() => onOpenThread(item)}
        >
          Open thread
          <SquareArrowOutUpRight aria-hidden data-icon="inline-end" />
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
      </header>
      <div data-testid="inbox-detail-body" className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        {item.ask !== undefined ? (
          // A new ask starts afresh: nothing picked, read in place unless it must be read in full.
          <AskDetail key={item.key} item={item} />
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
        ) : item.failure !== undefined ? (
          <ul>
            <FailureRowView item={item.failure} />
          </ul>
        ) : null}
        {/* A thread gone with its worker has nothing to read. */}
        {item.threadId !== undefined && item.owned && (
          <InboxContext key={item.threadId} threadId={item.threadId} />
        )}
      </div>
    </section>
  );
}
