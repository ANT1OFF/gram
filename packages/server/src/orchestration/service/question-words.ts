import {
  DISMISS_REASON_MAX,
  InvalidState,
  NotFound,
  workerAnswerMessage,
  workerDismissMessage,
  workerRevisedAnswerMessage,
  workerWithdrawnMessage,
  type WorkspaceId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import { redactText } from "../../logging/redact.ts";
import type { StoredWorkerQuestion } from "../outbox.ts";
import { isRefusal, type QuestionRefusal } from "../worker-questions.ts";
import { toolError } from "./kit.ts";

/** A worker's words for a question, trimmed and with secrets redacted. */
export const questionWords = (text: string): string => redactText(text.trim());

/** What the worker is sent once its question is closed: answered, changed, dismissed or withdrawn. */
export const closedQuestionText = (question: StoredWorkerQuestion) =>
  question.withdrawal !== undefined
    ? workerWithdrawnMessage(question, question.withdrawal.how, question.reason ?? "")
    : question.stage === "dismissed"
      ? workerDismissMessage(question, question.reason)
      : (question.revised === true ? workerRevisedAnswerMessage : workerAnswerMessage)(
          question,
          question.answer ?? "",
          question.closedBy === "orchestrator"
            ? { closedBy: "orchestrator", source: question.source ?? "" }
            : { closedBy: "user", recordedBy: question.recordedBy },
        );

/** Why a question was withdrawn when its thread left, in its history's words. */
export const LEFT_REASON = {
  archived: "Its thread was archived.",
  deleted: "Its thread was deleted.",
  detached: "Its thread left its orchestrator.",
  moved: "Its thread moved to another workspace.",
} as const;

/** A withdrawal's reason, redacted, or the tool's refusal when there is none or it is too long. */
export const withdrawReason = (tool: string, reason: string | undefined) => {
  const words = redactText((reason ?? "").trim());
  if (words === "") {
    return Effect.fail(
      toolError(tool, "Say why it no longer needs an answer: the user reads it in its history."),
    );
  }
  if (words.length > DISMISS_REASON_MAX) {
    return Effect.fail(toolError(tool, `Keep the reason to ${DISMISS_REASON_MAX} characters.`));
  }
  return Effect.succeed(words);
};

/** One question's key for its triage timer and its owed notice. */
export const questionTimerKey = (workspaceId: WorkspaceId, questionId: string) =>
  `${workspaceId}\u0000${questionId}`;

/** The move, with who it was decided for when there is someone. */
export const withClosedFor = (
  moved: StoredWorkerQuestion | QuestionRefusal,
  closedFor: StoredWorkerQuestion["closedFor"],
) => (isRefusal(moved) || closedFor === undefined ? moved : { ...moved, closedFor });

/** A move refused to the user, as the error their surface shows. */
export const userRefusal = (questionId: string, refused: QuestionRefusal) =>
  refused.code === "unknown_question"
    ? new NotFound({ entity: "question", id: questionId, message: refused.refused })
    : new InvalidState({ message: refused.refused });
