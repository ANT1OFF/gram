import {
  isOpenQuestion,
  questionStatusLine,
  questionTime,
  type ThreadId,
  type WorkerQuestion,
} from "@gram/contracts";
import { MessageCircleQuestion } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  answerChangeable,
  newerQuestion,
  questionKind,
  questionOutcome,
  workerQuestionCard,
} from "@/orchestration/question-card-model";
import {
  OpenQuestion,
  QuestionHolder,
  useWorkerQuestionActions,
} from "@/orchestration/question-entry";
import { useOrchestratorLedger } from "@/orchestration/use-orchestration";

import { choiceOf } from "./choice-model";
import { CARD, ThreadLink, WorkerText } from "./orchestration-cards";

/**
 * The question as it stands now: the card's own copy is what it was when the card was drawn (an
 * orchestrator's card is never redrawn), so the workspace's live ledger has the last word. `gone`
 * when the ledger is in and no longer holds it: closed long enough ago to leave its history, so
 * there is nothing left to answer or change.
 */
export function useLiveQuestion(card: WorkerQuestion): {
  readonly question: WorkerQuestion;
  readonly gone: boolean;
} {
  const { data: ledger } = useOrchestratorLedger(card.workspaceId);
  const held = ledger?.questions?.find((each) => each.id === card.id);
  return {
    question: newerQuestion(card, held),
    gone: ledger !== undefined && held === undefined,
  };
}

/**
 * A worker's own question (`ask_question`), as one card that moves through its states: asked, with
 * the orchestrator, forwarded to you, answered or dismissed, with who did it and when. Wherever it
 * is drawn it follows the ledger, so an answer given on another card, in the Inbox or in a message
 * shows here too. While it is open it can be answered or dismissed right here; once answered, Update
 * answer changes the answer, starting from the one given. The words are the worker's, as written.
 */
export function WorkerQuestionCard({
  question: drawn,
  threadId,
}: {
  question: WorkerQuestion;
  /** The thread the card is drawn in, which decides whose side is named. */
  threadId: ThreadId;
}) {
  const { question, gone } = useLiveQuestion(drawn);
  const inWorker = question.threadId === threadId;
  const actions = useWorkerQuestionActions(question.workspaceId);
  const open = isOpenQuestion(question) && !gone;
  const outcome = questionOutcome(question);
  const status = gone && isOpenQuestion(question) ? "Closed" : questionStatusLine(question);
  const [changing, setChanging] = useState<{ readonly from: number | undefined }>();
  const [sending, setSending] = useState(false);
  const overtaken = changing !== undefined && !sending && changing.from !== question.closedAt;
  const changeable = answerChangeable(question) && !gone;
  const change = (text: string) => {
    setSending(true);
    return actions
      .change(question)(text)
      .then(() => setChanging(undefined))
      .finally(() => setSending(false));
  };
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
      ) : changeable && changing !== undefined && !overtaken ? (
        <OpenQuestion
          key={changing.from}
          card={{
            ...workerQuestionCard(question),
            asker: undefined,
            status: undefined,
            dismissable: false,
          }}
          compact={false}
          startAnswering
          initialChoice={choiceOf(
            question.answer ?? "",
            question.options ?? [],
            question.multiSelect === true,
          )}
          sendLabel="Update answer"
          onAnswer={change}
          onCancel={() => setChanging(undefined)}
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
          {overtaken && (
            <p role="status" data-testid="question-overtaken" className="text-meta">
              The answer changed while you were changing it
              {question.closedAt === undefined ? "" : `, at ${questionTime(question.closedAt)}`}: it
              is the one above now. Update answer again to change that one.
            </p>
          )}
          {changeable && (
            <div className="flex items-center gap-2">
              <Button
                size="xs"
                variant="outline"
                data-testid="question-update"
                onClick={() => setChanging({ from: question.closedAt })}
              >
                Update answer
              </Button>
              <span className="text-meta text-muted-foreground">
                The worker gets the new answer as a new message
              </span>
            </div>
          )}
        </>
      )}
    </article>
  );
}
