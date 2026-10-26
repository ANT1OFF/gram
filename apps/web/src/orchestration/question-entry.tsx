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
  ArrowRightLeft,
  Bot,
  CircleCheck,
  CircleX,
  MessageCircleQuestion,
  Send,
  type LucideIcon,
} from "lucide-react";
import { useId, useState } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ExpandPresence, PresenceItem, PresenceList } from "@/motion";
import { NO_CHOICE, choiceAnswer, typeOther, type Choice } from "@/thread/choice-model";
import { OptionGallery } from "@/thread/mock-visuals";
import { ChoiceList } from "@/thread/request-cards";

import { useLayoutStore } from "@/stores/layout";

import type { MemoryQuestion } from "./memory-model";
import {
  memoryQuestionCard,
  questionOutcome,
  workerQuestionCard,
  type QuestionCard,
} from "./question-card-model";
import { useFocusOnOpen } from "./use-focus-on-open";

const INPUT =
  "rounded-md border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50";

function IdChip({ id, muted = false }: { id: string; muted?: boolean }) {
  return (
    <span
      className={cn(
        "mt-0.5 shrink-0 rounded-sm border px-1 font-mono text-[11px]",
        muted ? "border-border text-muted-foreground" : "border-status-needs/50 text-status-needs",
      )}
    >
      {id}
    </span>
  );
}

/**
 * The answer to a question with no choices: a text box, mounted when it opens so the focus lands in
 * it, labelled by the question already shown above it.
 */
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

/** A dismissal's optional reason, focused as it opens. */
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

/** Who asked a worker's question, linked to its thread. */
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
 * One open question and its answer: its choices when it offers some, a text box when not, and for
 * a worker's question a Dismiss with an optional reason. Sending closes the question, so it leaves
 * the open list. The words are the asker's, exactly.
 */
export function OpenQuestion({
  card,
  compact,
  unavailable,
  onAnswer,
  onDismiss,
}: {
  card: QuestionCard;
  compact: boolean;
  /** Why it can't be answered here right now; the Answer button says so. */
  unavailable?: string | undefined;
  onAnswer: (answer: string) => Promise<unknown>;
  onDismiss?: ((reason: string | undefined) => Promise<unknown>) | undefined;
}) {
  const [mode, setMode] = useState<"idle" | "answering" | "dismissing">("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [choice, setChoice] = useState<Choice>(NO_CHOICE);
  const [reason, setReason] = useState("");
  const answer = choiceAnswer(choice).join("; ");
  const questionId = useId();
  const worker = card.to === "worker";

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
    if (unavailable !== undefined || answer === "") return;
    run(() => onAnswer(answer));
  };
  const dismiss = () => {
    if (onDismiss === undefined) return;
    const why = reason.trim();
    run(() => onDismiss(why === "" ? undefined : why));
  };
  return (
    <div
      data-testid={worker ? "worker-question" : "memory-question"}
      data-question={card.id}
      className={cn(
        "flex flex-col gap-1",
        compact && "rounded-(--radius-md) border border-status-needs/50 bg-card p-2",
      )}
    >
      {card.asker !== undefined && (
        <p
          data-testid="question-asker"
          className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground"
        >
          <MessageCircleQuestion aria-hidden className="size-3 shrink-0 text-status-needs" />
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
        <p id={questionId} className="min-w-0 flex-1 text-sm break-words">
          {card.text}
        </p>
        {mode === "idle" && (
          <div className="flex shrink-0 items-center gap-1">
            <Button
              size="xs"
              variant="outline"
              disabled={unavailable !== undefined}
              title={unavailable}
              onClick={() => setMode("answering")}
            >
              Answer
            </Button>
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
        <p className="text-xs whitespace-pre-wrap text-muted-foreground">{card.detail}</p>
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
        <p data-testid="question-recommendation" className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Recommends:</span> {card.recommendation}
        </p>
      )}
      {card.note !== undefined && (
        <p
          data-testid="question-note"
          className="flex items-start gap-1 text-xs text-muted-foreground"
        >
          <Bot aria-hidden className="mt-px size-3.5 shrink-0" />
          <span>
            <span className="font-medium text-foreground">Orchestrator:</span> {card.note}
          </span>
        </p>
      )}
      <ExpandPresence open={mode === "answering"}>
        <form
          className="flex flex-col gap-1.5 pt-1 text-sm"
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
              />
            </fieldset>
          )}
          <div className="flex items-center gap-2">
            <Button type="submit" size="xs" disabled={busy || answer === ""}>
              <Send data-icon="inline-start" />
              {worker ? "Send to the worker" : "Send to the orchestrator"}
            </Button>
            <Button type="button" size="xs" variant="ghost" onClick={() => setMode("idle")}>
              Cancel
            </Button>
          </div>
        </form>
      </ExpandPresence>
      <ExpandPresence open={mode === "dismissing"}>
        <form
          className="flex flex-col gap-1.5 pt-1 text-sm"
          onSubmit={(event) => {
            event.preventDefault();
            dismiss();
          }}
        >
          {mode === "dismissing" && (
            <DismissReason labelledBy={questionId} value={reason} onChange={setReason} />
          )}
          <div className="flex items-center gap-2">
            <Button
              type="submit"
              size="xs"
              variant="outline"
              disabled={busy}
              data-testid="question-dismiss-confirm"
            >
              <CircleX data-icon="inline-start" />
              Dismiss question
            </Button>
            <Button type="button" size="xs" variant="ghost" onClick={() => setMode("idle")}>
              Cancel
            </Button>
          </div>
        </form>
      </ExpandPresence>
      {error !== undefined && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** The open questions, answerable in place; `compact` draws each as a card of its own, for the board. */
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
  const api = useApi();
  const queryClient = useQueryClient();
  const answer = (question: MemoryQuestion) => (text: string) =>
    api
      .answerQuestion({
        workspaceId,
        ...(question.id === undefined ? {} : { questionId: question.id }),
        question: question.text,
        answer: text,
      })
      .then(() => queryClient.invalidateQueries({ queryKey: ["memory", workspaceId] }));
  // An answered question closes and folds away, so what is below it doesn't jump.
  return (
    <ul className={className}>
      <PresenceList>
        {questions.map((question, index) => {
          const card = memoryQuestionCard(question, index, orchestratorId);
          return (
            <PresenceItem key={card.key} as="li" className={compact ? "pb-2" : "pb-3"}>
              <OpenQuestion
                card={card}
                compact={compact}
                unavailable={
                  orchestratorId === undefined
                    ? "Open the orchestrator first: the answer is a message to it"
                    : undefined
                }
                onAnswer={answer(question)}
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

/** The workers' questions waiting on the user, answerable or dismissable in place. */
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
  return (
    <ul className={className}>
      <PresenceList>
        {questions.map((question) => (
          <PresenceItem key={question.id} as="li" className={compact ? "pb-2" : "pb-3"}>
            <OpenQuestion
              card={workerQuestionCard(question)}
              compact={compact}
              onAnswer={actions.answer(question)}
              onDismiss={actions.dismiss(question)}
            />
          </PresenceItem>
        ))}
      </PresenceList>
    </ul>
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
        : { icon: MessageCircleQuestion, className: "text-status-needs" };
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
        <Icon aria-hidden className={cn("size-3.5", look.className)} />
      </span>
      <IdChip id={question.id} muted />
      <div className="min-w-0 flex-1">
        <p className="text-sm break-words text-muted-foreground">{question.question}</p>
        {outcome !== undefined && <p className="text-xs break-words">{outcome}</p>}
        <p data-testid="question-status" className="text-[11px] text-muted-foreground tabular-nums">
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

/** How a closed entry was closed, by icon and colour, with its word for a tooltip and a screen reader. */
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
        <Icon aria-hidden className={cn("size-3.5", look.className)} />
        <span className="sr-only">{look.label}</span>
      </span>
      {question.id !== undefined && <IdChip id={question.id} muted />}
      <div className="min-w-0 flex-1">
        <p className="text-sm break-words text-muted-foreground">{question.text}</p>
        {question.answer !== undefined && <p className="text-xs break-words">{question.answer}</p>}
      </div>
    </li>
  );
}
