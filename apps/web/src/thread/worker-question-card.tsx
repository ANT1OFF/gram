import {
  isOpenQuestion,
  questionStatusLine,
  type ThreadId,
  type WorkerQuestion,
} from "@gram/contracts";
import { MessageCircleQuestion } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  questionKind,
  questionOutcome,
  workerQuestionCard,
} from "@/orchestration/question-card-model";
import {
  OpenQuestion,
  QuestionHolder,
  useWorkerQuestionActions,
} from "@/orchestration/question-entry";

import { CARD, ThreadLink, WorkerText } from "./orchestration-cards";

/**
 * A worker's own question (`ask_question`), as one card that moves through its states: asked, with
 * the orchestrator, forwarded to you, answered or dismissed, with who did it and when. While it is
 * open it can be answered or dismissed right here too; the words are the worker's, as written.
 */
export function WorkerQuestionCard({
  question,
  threadId,
}: {
  question: WorkerQuestion;
  /** The thread the card is drawn in, which decides whose side is named. */
  threadId: ThreadId;
}) {
  const inWorker = question.threadId === threadId;
  const actions = useWorkerQuestionActions(question.workspaceId);
  const open = isOpenQuestion(question);
  const outcome = questionOutcome(question);
  const status = questionStatusLine(question);
  return (
    <article
      aria-label={`${questionKind(question.id)} ${question.id}`}
      data-testid="worker-question-card"
      data-question={question.id}
      data-stage={question.stage}
      className={cn(CARD, "my-2 flex flex-col gap-1.5 p-2.5")}
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 text-meta">
        <MessageCircleQuestion
          aria-hidden
          className={cn("size-icon-row", open ? "text-status-needs-mark" : "text-muted-foreground")}
        />
        <h3 className="font-medium">
          {inWorker ? (
            <>Asked a question</>
          ) : (
            <>
              {questionKind(question.id)} from{" "}
              <ThreadLink threadId={question.threadId}>{question.title}</ThreadLink>
            </>
          )}{" "}
          <span className="font-mono font-normal text-muted-foreground">{question.id}</span>
        </h3>
        <span data-testid="question-status" className="ml-auto text-muted-foreground tabular-nums">
          {status}
        </span>
      </header>
      {open ? (
        <OpenQuestion
          card={{ ...workerQuestionCard(question), asker: undefined, status: undefined }}
          compact={false}
          holder={<QuestionHolder question={question} />}
          onAnswer={actions.answer(question)}
          onDismiss={actions.dismiss(question)}
        />
      ) : (
        <>
          <WorkerText text={question.question} />
          {question.note !== undefined && (
            <p className="text-meta text-muted-foreground">
              <span className="font-medium text-foreground">Orchestrator:</span> {question.note}
            </p>
          )}
          {outcome !== undefined && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-reading">
              <dt className="text-meta text-muted-foreground">
                {question.stage === "dismissed" ? "Why" : "A"}
              </dt>
              <dd data-testid="question-outcome">
                <WorkerText text={outcome} />
              </dd>
            </dl>
          )}
        </>
      )}
    </article>
  );
}
