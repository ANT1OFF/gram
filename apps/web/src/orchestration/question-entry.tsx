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
import { useId, useState } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { formatKeys } from "@/keyboard/registry";
import { cn } from "@/lib/utils";
import { ExpandPresence, PresenceItem, PresenceList } from "@/motion";
import { NO_CHOICE, choiceAnswer, typeOther, type Choice } from "@/thread/choice-model";
import { OptionGallery } from "@/thread/mock-visuals";
import { ChoiceList } from "@/thread/request-cards";

import { useLayoutStore } from "@/stores/layout";

import type { MemoryQuestion } from "./memory-model";
import { SendAnswer } from "./ask-choices";
import { memoryId, workerQuestionId } from "./ask-model";
import { openAskSheet, showAsk } from "./ask-sheet-store";
import { useAskStackStore } from "./ask-stack-store";
import { useDerivedAsks } from "./needs-you-store";
import {
  fitsInPlace,
  memoryQuestionCard,
  questionKind,
  questionOutcome,
  workerQuestionCard,
  type QuestionCard,
} from "./question-card-model";
import { useFocusOnOpen } from "./use-focus-on-open";

const INPUT =
  "rounded-md border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50";

/**
 * A question's id, muted beside its text: a handle to refer to it by, not a label. Its hover and its
 * accessible name say what kind of question it is.
 */
function IdChip({ id }: { id: string }) {
  const kind = questionKind(id);
  return (
    <Hint
      label={`${kind} ${id}`}
      render={
        <span
          aria-label={`${kind} ${id}`}
          className="mt-0.5 shrink-0 rounded-sm border border-border px-1 font-mono text-[11px] text-muted-foreground"
        />
      }
    >
      {id}
    </Hint>
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
 * One open question. In the ask sheet (`sheet`) it is answered: its choices when it offers some, a
 * text box when not, then Send answer; a number key picks and ⌘⏎ sends, as in the Asks dock.
 * Anywhere else (the Board's band, a feature's sheet, Memory) it is only shown, and Answer takes it
 * to the one place it is answered (`onOpen`), so no two forms ask the same thing at once. A worker's
 * question has Dismiss, with an optional reason, in both. The words are the asker's, exactly.
 */
export function OpenQuestion({
  card,
  compact,
  sheet = false,
  unavailable,
  onAnswer,
  onDismiss,
  onOpen,
  answering = false,
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
  /** Sends the answer: the sheet's. */
  onAnswer?: ((answer: string) => Promise<unknown>) | undefined;
  onDismiss?: ((reason: string | undefined) => Promise<unknown>) | undefined;
  /** Where Answer goes outside the sheet: the Asks dock turned to it, or the ask sheet. */
  onOpen?: (() => void) | undefined;
  /** The Asks dock has it open now: it says so rather than offer Answer again. */
  answering?: boolean;
}) {
  const [mode, setMode] = useState<"idle" | "answering" | "dismissing">(
    sheet ? "answering" : "idle",
  );
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
    if (unavailable !== undefined || answer === "" || onAnswer === undefined) return;
    run(() => onAnswer(answer));
  };
  const answerRow = sheet
    ? "sticky bottom-0 -mx-4 mt-1 border-t border-border bg-popover px-4 py-2.5"
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
        // A card among cards, on a neutral edge: the amber is its mark, and the dock's.
        compact && "rounded-(--radius-md) border bg-card p-2",
        compact && (answering ? "border-primary/60" : "border-border"),
      )}
    >
      {card.asker !== undefined && (
        <p
          data-testid="question-asker"
          className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground"
        >
          <MessageCircleQuestion aria-hidden className="size-3 shrink-0 text-status-needs-mark" />
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
            {answering ? (
              <span
                data-testid="question-answering"
                className="inline-flex h-6 items-center gap-1 px-1 text-xs text-muted-foreground"
              >
                <ArrowDown aria-hidden className="size-3.5" />
                In Asks
              </span>
            ) : (
              <Button
                size="xs"
                variant="outline"
                data-testid="question-answer"
                disabled={unavailable !== undefined || onOpen === undefined}
                title={unavailable}
                onClick={() => onOpen?.()}
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
      <ExpandPresence open={sheet && mode === "answering"}>
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
                hints
              />
            </fieldset>
          )}
          <div
            data-testid={sheet ? "ask-sheet-answer-row" : undefined}
            className={cn("flex items-center gap-2", answerRow)}
          >
            <SendAnswer
              type="submit"
              testId="question-send"
              disabled={busy || answer === "" || unavailable !== undefined}
              title={unavailable ?? (answer === "" ? "Pick a choice first" : undefined)}
              hint={formatKeys("mod+enter")}
            />
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              {worker ? "Goes straight to the worker" : "Goes to the orchestrator"}
            </span>
            <span className="flex-1" />
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
          <div className={cn("flex items-center gap-2", answerRow)}>
            <Button
              type="submit"
              size={sheet ? "sm" : "xs"}
              variant="outline"
              disabled={busy}
              data-testid="question-dismiss-confirm"
            >
              <CircleX data-icon="inline-start" />
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
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Where a listed question's Answer goes: "dock", the Board's Asks dock turned to it (or the ask
 * sheet, for one too long for the dock), or "sheet", the ask sheet, where no dock is in sight.
 */
export type AnswerIn = "dock" | "sheet";

/**
 * Answer for a listed question, by its hold id: the one place it is answered. And whether the dock
 * has it open now, so the list marks it instead of offering a second Answer.
 */
function useAnswerIn(workspaceId: WorkspaceId, where: AnswerIn) {
  const asks = useDerivedAsks((s) => s.asks.find((w) => w.workspaceId === workspaceId)?.asks);
  const current = useAskStackStore((s) => (where === "dock" ? s.current[workspaceId] : undefined));
  return {
    open: (id: string, card: QuestionCard) => {
      const ask = asks?.find((each) => each.ids.includes(id));
      if (where === "dock" && ask !== undefined && fitsInPlace(card)) {
        showAsk(workspaceId, ask);
        return;
      }
      openAskSheet(workspaceId, { ids: [id], key: id });
    },
    answering: (id: string) => current === id,
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
 * The open questions, each with Answer to the one place it is answered (`where`); `compact` draws
 * each as a card of its own, for the board.
 */
export function OpenQuestionList({
  questions,
  workspaceId,
  orchestratorId,
  where,
  compact = false,
  className,
}: {
  questions: readonly MemoryQuestion[];
  workspaceId: WorkspaceId;
  orchestratorId: ThreadId | undefined;
  where: AnswerIn;
  compact?: boolean;
  className?: string;
}) {
  const answerIn = useAnswerIn(workspaceId, where);
  // An answered question closes and folds away, so what is below it doesn't jump.
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
                onOpen={() => answerIn.open(id, card)}
                answering={answerIn.answering(id)}
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
  where,
  compact = false,
  className,
}: {
  questions: readonly WorkerQuestion[];
  workspaceId: WorkspaceId;
  where: AnswerIn;
  compact?: boolean;
  className?: string;
}) {
  const actions = useWorkerQuestionActions(workspaceId);
  const answerIn = useAnswerIn(workspaceId, where);
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
                onOpen={() => answerIn.open(id, card)}
                answering={answerIn.answering(id)}
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
        <Icon aria-hidden className={cn("size-3.5", look.className)} />
      </span>
      <IdChip id={question.id} />
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
      {question.id !== undefined && <IdChip id={question.id} />}
      <div className="min-w-0 flex-1">
        <p className="text-sm break-words text-muted-foreground">{question.text}</p>
        {question.answer !== undefined && <p className="text-xs break-words">{question.answer}</p>}
      </div>
    </li>
  );
}
