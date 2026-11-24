import {
  DISMISS_REASON_MAX,
  questionStatusLine,
  type ThreadId,
  type WorkerQuestion,
  type WorkspaceId,
} from "@gram/contracts";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowRightLeft,
  Bot,
  CircleCheck,
  CircleX,
  MessageCircleQuestion,
  type LucideIcon,
} from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { formatKeys } from "@/keyboard/registry";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { ExpandPresence, PresenceItem, PresenceList } from "@/motion";
import { NO_CHOICE, choiceAnswer, typeOther, type Choice } from "@/thread/choice-model";
import { OptionGallery } from "@/thread/mock-visuals";
import { ChoiceList } from "@/thread/request-cards";

import { showInbox, showInboxAsk } from "@/inbox/inbox-store";
import { useLayoutStore } from "@/stores/layout";

import type { MemoryQuestion } from "./memory-model";
import { SendAnswer } from "./ask-choices";
import { memoryId, workerQuestionId } from "./ask-model";
import { useDerivedAsks } from "./needs-you-store";
import {
  memoryQuestionCard,
  questionHolder,
  questionKind,
  questionOutcome,
  workerQuestionCard,
  type QuestionCard,
} from "./question-card-model";
import { useFocusOnOpen } from "./use-focus-on-open";

const INPUT =
  "rounded-md border border-input bg-transparent px-2 text-reading outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50";

function IdChip({ id }: { id: string }) {
  const kind = questionKind(id);
  return (
    <Hint
      label={`${kind} ${id}`}
      render={
        <span
          aria-label={`${kind} ${id}`}
          className="mt-0.5 shrink-0 rounded-sm border border-border px-1 font-mono text-caption text-muted-foreground"
        />
      }
    >
      {id}
    </Hint>
  );
}

function FreeAnswer({
  labelledBy,
  value,
  placeholder,
  onChange,
}: {
  labelledBy: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  const focus = useFocusOnOpen<HTMLTextAreaElement>();
  return (
    <textarea
      aria-labelledby={labelledBy}
      ref={focus}
      rows={2}
      className={cn(INPUT, "resize-y py-1")}
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function DismissReason({
  labelledBy,
  value,
  onChange,
}: {
  labelledBy: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const focus = useFocusOnOpen<HTMLInputElement>();
  return (
    <input
      aria-labelledby={labelledBy}
      aria-label="Reason (optional)"
      ref={focus}
      data-testid="question-dismiss-reason"
      className={cn(INPUT, "h-7")}
      value={value}
      maxLength={DISMISS_REASON_MAX}
      placeholder="Why, if you like: the worker is told either way"
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function AskedBy({ asker }: { asker: NonNullable<QuestionCard["asker"]> }) {
  return (
    <>
      <Link
        to="/t/$threadId"
        params={{ threadId: asker.threadId }}
        onClick={() => useLayoutStore.getState().openThread(asker.threadId)}
        className="font-medium hover:text-foreground hover:underline"
      >
        {asker.title}
      </Link>
      {asker.feature !== "" && <span> · {asker.feature}</span>}
    </>
  );
}

/**
 * One open question. In the Inbox's detail pane (`sheet`) it is answered: its choices when it offers
 * some, a text box when not, then Send answer; a number key picks and ⌘⏎ sends. Anywhere else (a
 * feature's sheet, Memory) it is only shown, and Answer takes it to the Inbox (`onOpen`), so no two
 * forms ask the same thing at once. A worker's
 * question has Dismiss, with an optional reason, in both. The words are the asker's, exactly.
 */
export function OpenQuestion({
  card,
  compact,
  sheet = false,
  unavailable,
  holder,
  onAnswer,
  onDismiss,
  onOpen,
  answering = false,
  initialChoice = NO_CHOICE,
  startAnswering = false,
  sendLabel,
  onCancel,
}: {
  card: QuestionCard;
  compact: boolean;
  /**
   * Drawn in the ask sheet: open to answer from the start, its whole text in the sheet's scroll and
   * its answer row stuck to the sheet's bottom edge, so a choice is never out of reach.
   */
  sheet?: boolean;
  /** Why it can't be answered right now; the Answer button says so. */
  unavailable?: string | undefined;
  /** Who holds it and what answering does, said above its answer: the card in a thread's. */
  holder?: ReactNode;
  /** Sends the answer: the sheet's, or the card's own where Answer opens nowhere else. */
  onAnswer?: ((answer: string) => Promise<unknown>) | undefined;
  onDismiss?: ((reason: string | undefined) => Promise<unknown>) | undefined;
  /** Where Answer goes outside the sheet: the Asks dock turned to it, or the ask sheet. */
  onOpen?: (() => void) | undefined;
  /** The Asks dock has it open now: it says so rather than offer Answer again. */
  answering?: boolean;
  /** What is picked as it opens: the answer given before, when it is being changed. */
  initialChoice?: Choice;
  /** Opens answering in place, as Update answer does, rather than behind an Answer button. */
  startAnswering?: boolean;
  /** The send button's words, "Send answer" unless given. */
  sendLabel?: string | undefined;
  /** Where Cancel goes instead of back to the Answer button: the answered card, for a change. */
  onCancel?: (() => void) | undefined;
}) {
  const [mode, setMode] = useState<"idle" | "answering" | "dismissing">(
    sheet || startAnswering ? "answering" : "idle",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [choice, setChoice] = useState<Choice>(initialChoice);
  const [reason, setReason] = useState("");
  const answer = choiceAnswer(choice).join("; ");
  const questionId = useId();
  const worker = card.to === "worker";
  const inPlace = sheet || (onOpen === undefined && onAnswer !== undefined);

  const run = (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    action()
      .then(() => setBusy(false))
      .catch((e: unknown) => {
        setError(errorMessage(e));
        setBusy(false);
      });
  };
  const send = () => {
    if (unavailable !== undefined || answer === "" || onAnswer === undefined) return;
    run(() => onAnswer(answer));
  };
  const answerFormId = useId();
  const answerRow = sheet
    ? "sticky bottom-0 -mx-4 mt-1 border-t border-edge bg-popover px-4 py-2.5"
    : undefined;
  const dismiss = () => {
    if (onDismiss === undefined) return;
    const why = reason.trim();
    run(() => onDismiss(why === "" ? undefined : why));
  };
  return (
    <div
      data-testid={worker ? "worker-question" : "memory-question"}
      data-question={card.id}
      data-answering={answering || undefined}
      className={cn(
        "flex flex-col gap-1",
        compact && "rounded-(--radius-md) border bg-card p-2",
        compact && (answering ? "border-primary/60" : "border-border"),
      )}
    >
      {card.asker !== undefined && (
        <p
          data-testid="question-asker"
          className="flex min-w-0 items-center gap-1 text-meta text-muted-foreground"
        >
          <MessageCircleQuestion
            aria-hidden
            className="size-icon-row shrink-0 text-status-needs-mark"
          />
          <span className="min-w-0 flex-1 truncate">
            <AskedBy asker={card.asker} />
          </span>
          {card.status !== undefined && (
            <span data-testid="question-status" className="shrink-0 tabular-nums">
              {card.status}
            </span>
          )}
        </p>
      )}
      <div className="flex min-w-0 items-start gap-2">
        {card.id !== undefined && <IdChip id={card.id} />}
        <p id={questionId} className="min-w-0 flex-1 text-reading break-words">
          {card.text}
        </p>
        {mode === "idle" && (
          <div className="flex shrink-0 items-center gap-1">
            {answering ? (
              <span
                data-testid="question-answering"
                className="inline-flex h-6 items-center gap-1 px-1 text-meta text-muted-foreground"
              >
                <ArrowDown aria-hidden className="size-icon-row" />
                In Asks
              </span>
            ) : (
              <Button
                size="xs"
                variant="outline"
                data-testid="question-answer"
                disabled={
                  unavailable !== undefined || (onOpen === undefined && onAnswer === undefined)
                }
                title={unavailable}
                onClick={() => (onOpen === undefined ? setMode("answering") : onOpen())}
              >
                Answer
              </Button>
            )}
            {card.dismissable && onDismiss !== undefined && (
              <Button
                size="xs"
                variant="ghost"
                data-testid="question-dismiss"
                onClick={() => setMode("dismissing")}
              >
                Dismiss
              </Button>
            )}
          </div>
        )}
      </div>
      {card.detail !== undefined && (
        <p className="text-meta whitespace-pre-wrap text-muted-foreground">{card.detail}</p>
      )}
      {card.seenFrom !== undefined && (
        <OptionGallery
          threadId={card.seenFrom}
          options={card.options}
          recommended={card.recommended}
          mock={card.mock}
          className="pt-0.5"
        />
      )}
      {card.recommendation !== undefined && (
        <p data-testid="question-recommendation" className="text-meta text-muted-foreground">
          <span className="font-medium text-foreground">Recommends:</span> {card.recommendation}
        </p>
      )}
      {card.note !== undefined && (
        <p
          data-testid="question-note"
          className="flex items-start gap-1 text-meta text-muted-foreground"
        >
          <Bot aria-hidden className="mt-px size-icon-row shrink-0" />
          <span>
            <span className="font-medium text-foreground">Orchestrator:</span> {card.note}
          </span>
        </p>
      )}
      {holder}
      <ExpandPresence open={inPlace && mode === "answering"}>
        <form
          id={answerFormId}
          className="flex flex-col gap-1.5 pt-1 text-reading"
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
        >
          {card.options.length === 0 ? (
            <FreeAnswer
              labelledBy={questionId}
              value={choice.other}
              placeholder={
                worker
                  ? "Sent straight to the worker; the orchestrator gets a copy"
                  : "Sent to the orchestrator, and the question closed"
              }
              onChange={(text) => setChoice(typeOther(choice, text, false))}
            />
          ) : (
            <fieldset aria-labelledby={questionId} className="space-y-0.5">
              <ChoiceList
                question={card.text}
                options={card.options}
                multiSelect={card.multiSelect}
                recommended={card.recommended}
                value={choice}
                onChange={setChoice}
                hints
              />
            </fieldset>
          )}
        </form>
      </ExpandPresence>
      {inPlace && mode === "answering" && (
        <div
          data-testid={sheet ? "ask-sheet-answer-row" : undefined}
          className={cn("flex items-center gap-2", answerRow)}
        >
          <SendAnswer
            type="submit"
            form={answerFormId}
            testId="question-send"
            {...(sendLabel === undefined ? {} : { label: sendLabel })}
            disabled={busy || answer === "" || unavailable !== undefined}
            title={unavailable ?? (answer === "" ? "Pick an answer" : undefined)}
            hint={formatKeys("mod+enter")}
          />
          <span className="min-w-0 truncate text-meta text-muted-foreground">
            {worker ? "Goes straight to the worker" : "Goes to the orchestrator"}
          </span>
          <span className="flex-1" />
          {!sheet && (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => (onCancel === undefined ? setMode("idle") : onCancel())}
            >
              Cancel
            </Button>
          )}
          {card.dismissable && onDismiss !== undefined && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              data-testid="question-dismiss"
              onClick={() => setMode("dismissing")}
            >
              Dismiss…
            </Button>
          )}
        </div>
      )}
      <ExpandPresence open={mode === "dismissing"}>
        <form
          className="flex flex-col gap-1.5 pt-1 text-reading"
          onSubmit={(event) => {
            event.preventDefault();
            dismiss();
          }}
        >
          {mode === "dismissing" && (
            <DismissReason labelledBy={questionId} value={reason} onChange={setReason} />
          )}
          <div className={cn("flex items-center gap-2", answerRow)}>
            <Button
              type="submit"
              size={sheet ? "sm" : "xs"}
              variant="outline"
              disabled={busy}
              data-testid="question-dismiss-confirm"
            >
              Dismiss question
            </Button>
            <Button
              type="button"
              size={sheet ? "sm" : "xs"}
              variant="ghost"
              onClick={() => setMode(sheet ? "answering" : "idle")}
            >
              {sheet ? "Back" : "Cancel"}
            </Button>
          </div>
        </form>
      </ExpandPresence>
      {error !== undefined && (
        <p role="alert" className="text-meta text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function useAnswerIn(workspaceId: WorkspaceId) {
  const asks = useDerivedAsks((s) => s.asks.find((w) => w.workspaceId === workspaceId)?.asks);
  return {
    open: (id: string) => {
      const ask = asks?.find((each) => each.ids.includes(id));
      if (ask === undefined) showInbox({ workspaceId });
      else showInboxAsk(ask.key);
    },
  };
}

/** Answers an orchestrator's open question with these words, then reads its memory again. */
export function useMemoryQuestionAnswer(workspaceId: WorkspaceId) {
  const api = useApi();
  const queryClient = useQueryClient();
  return (question: MemoryQuestion) => (text: string) =>
    api
      .answerQuestion({
        workspaceId,
        ...(question.id === undefined ? {} : { questionId: question.id }),
        question: question.text,
        answer: text,
      })
      .then(() => queryClient.invalidateQueries({ queryKey: ["memory", workspaceId] }));
}

/**
 * The open questions, each with Answer to the Inbox, where it is answered; `compact` draws
 * each as a card of its own, for the board.
 */
export function OpenQuestionList({
  questions,
  workspaceId,
  orchestratorId,
  compact = false,
  className,
}: {
  questions: readonly MemoryQuestion[];
  workspaceId: WorkspaceId;
  orchestratorId: ThreadId | undefined;
  compact?: boolean;
  className?: string;
}) {
  const answerIn = useAnswerIn(workspaceId);
  return (
    <ul className={className}>
      <PresenceList>
        {questions.map((question, index) => {
          const card = memoryQuestionCard(question, index, orchestratorId);
          const id = memoryId(workspaceId, question);
          return (
            <PresenceItem key={card.key} as="li" className={compact ? "pb-2" : "pb-3"}>
              <OpenQuestion
                card={card}
                compact={compact}
                onOpen={() => answerIn.open(id)}
                unavailable={
                  orchestratorId === undefined
                    ? "Open the orchestrator first: the answer is a message to it"
                    : undefined
                }
              />
            </PresenceItem>
          );
        })}
      </PresenceList>
    </ul>
  );
}

/** Answer and Dismiss for a worker's question: straight to the worker, the ledger read again after. */
export function useWorkerQuestionActions(workspaceId: WorkspaceId) {
  const api = useApi();
  const queryClient = useQueryClient();
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["orchestratorLedger", workspaceId] });
  return {
    answer: (question: WorkerQuestion) => (text: string) =>
      api
        .answerWorkerQuestion({ workspaceId, questionId: question.id, answer: text })
        .then(refresh),
    /**
     * Changes the answer `question` holds: refused when it changed since (its `closedAt`), and the
     * ledger read again either way, so the card shows the newer answer.
     */
    change: (question: WorkerQuestion) => async (text: string) => {
      try {
        await api.answerWorkerQuestion({
          workspaceId,
          questionId: question.id,
          answer: text,
          replaces: { closedAt: question.closedAt ?? 0 },
        });
      } finally {
        await refresh();
      }
    },
    dismiss: (question: WorkerQuestion) => (reason: string | undefined) =>
      api
        .dismissWorkerQuestion({
          workspaceId,
          questionId: question.id,
          ...(reason === undefined ? {} : { reason }),
        })
        .then(refresh),
  };
}

/** The workers' questions waiting on the user, each with Answer to the one place it is answered. */
export function WorkerQuestionList({
  questions,
  workspaceId,
  compact = false,
  className,
}: {
  questions: readonly WorkerQuestion[];
  workspaceId: WorkspaceId;
  compact?: boolean;
  className?: string;
}) {
  const actions = useWorkerQuestionActions(workspaceId);
  const answerIn = useAnswerIn(workspaceId);
  return (
    <ul className={className}>
      <PresenceList>
        {questions.map((question) => {
          const card = workerQuestionCard(question);
          const id = workerQuestionId(workspaceId, question);
          return (
            <PresenceItem key={question.id} as="li" className={compact ? "pb-2" : "pb-3"}>
              <OpenQuestion
                card={card}
                compact={compact}
                onOpen={() => answerIn.open(id)}
                onDismiss={actions.dismiss(question)}
              />
            </PresenceItem>
          );
        })}
      </PresenceList>
    </ul>
  );
}

/**
 * Who holds a worker's open question and what Answer does about it (`questionHolder`), moved on
 * when its triage time passes.
 */
export function QuestionHolder({ question }: { question: WorkerQuestion }) {
  const now = useNow(question.stage === "triage", undefined, 60_000);
  const holder = questionHolder(question, now);
  if (holder === undefined) return null;
  return (
    <p data-testid="question-holder" className="text-meta text-muted-foreground">
      {holder}
    </p>
  );
}

/**
 * A worker's question that is closed, or still with the orchestrator: what it came to, who closed
 * it and when, in 24-hour time.
 */
export function WorkerQuestionHistory({ question }: { question: WorkerQuestion }) {
  const look =
    question.stage === "answered"
      ? {
          icon: question.closedBy === "orchestrator" ? Bot : CircleCheck,
          className:
            question.closedBy === "orchestrator" ? "text-muted-foreground" : "text-success",
        }
      : question.stage === "dismissed"
        ? { icon: CircleX, className: "text-muted-foreground" }
        : { icon: MessageCircleQuestion, className: "text-status-needs-mark" };
  const Icon = look.icon;
  const status = questionStatusLine(question);
  const outcome = questionOutcome(question);
  return (
    <div
      data-testid="worker-question-history"
      data-question={question.id}
      data-stage={question.stage}
      className="flex min-w-0 items-start gap-2"
    >
      <span title={status} className="mt-0.5 inline-flex shrink-0">
        <Icon aria-hidden className={cn("size-icon-row", look.className)} />
      </span>
      <IdChip id={question.id} />
      <div className="min-w-0 flex-1">
        <p className="text-reading break-words text-muted-foreground">{question.question}</p>
        {outcome !== undefined && <p className="text-meta break-words">{outcome}</p>}
        <p data-testid="question-status" className="text-meta text-muted-foreground tabular-nums">
          {status}
        </p>
      </div>
    </div>
  );
}

interface ClosedLook {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly className: string;
}

const CLOSED_LOOK: Readonly<Record<string, ClosedLook>> = {
  answered: { icon: CircleCheck, label: "Answered by you", className: "text-success" },
  decided: { icon: Bot, label: "Decided by the orchestrator", className: "text-muted-foreground" },
  withdrawn: { icon: CircleX, label: "Withdrawn", className: "text-muted-foreground" },
  dropped: { icon: CircleX, label: "Dropped", className: "text-muted-foreground" },
  obsolete: { icon: CircleX, label: "Obsolete", className: "text-muted-foreground" },
  superseded: { icon: ArrowRightLeft, label: "Superseded", className: "text-muted-foreground" },
};
const CLOSED: ClosedLook = {
  icon: CircleCheck,
  label: "Closed",
  className: "text-muted-foreground",
};

const closedLook = (closedAs: string | undefined): ClosedLook =>
  (closedAs === undefined ? undefined : CLOSED_LOOK[closedAs]) ?? CLOSED;

/** A closed question: how it was closed, and its answer or the reason it was closed without one. */
export function ClosedQuestion({ question }: { question: MemoryQuestion }) {
  const look = closedLook(question.closedAs);
  const Icon = look.icon;
  return (
    <li
      data-testid="memory-closed-question"
      data-question={question.id}
      data-closed-as={question.closedAs}
      className="flex min-w-0 items-start gap-2"
    >
      <span title={look.label} className="mt-0.5 inline-flex shrink-0">
        <Icon aria-hidden className={cn("size-icon-row", look.className)} />
        <span className="sr-only">{look.label}</span>
      </span>
      {question.id !== undefined && <IdChip id={question.id} />}
      <div className="min-w-0 flex-1">
        <p className="text-reading break-words text-muted-foreground">{question.text}</p>
        {question.answer !== undefined && (
          <p className="text-meta break-words">{question.answer}</p>
        )}
      </div>
    </li>
  );
}
