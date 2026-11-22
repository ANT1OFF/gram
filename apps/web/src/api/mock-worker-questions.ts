import {
  isOpenQuestion,
  workerAnswerMessage,
  workerDismissMessage,
  type ThreadId,
  type WorkerQuestion,
  type WorkspaceId,
} from "@gram/contracts";

import { MockInvalidState } from "./mock-fs";

/** What closing a worker's question reads and changes of the orchestration mock's state. */
export interface MockQuestionDeps {
  readonly deliver: (threadId: ThreadId, text: string) => Promise<"steered" | "sent">;
  readonly questionsOf: Map<WorkspaceId, readonly WorkerQuestion[]>;
  readonly showQuestion: (question: WorkerQuestion) => void;
  /** When each worker last had input, as the server's memo keeps `lastInputAt`. */
  readonly inputAt: Map<ThreadId, number>;
  readonly changed: (workspaceId: WorkspaceId) => void;
}

export type MockQuestionClose =
  | { readonly answer: string }
  | { readonly dismissed: true; readonly reason?: string };

/**
 * The user's answer or dismissal of a worker's question, as the server's: told to the worker, the
 * card in its transcript moved on, and, once the worker has no other open question, the answer
 * counted as its input (`answeredInput`), so its question report no longer stands.
 */
export const closeWorkerQuestion = async (
  deps: MockQuestionDeps,
  workspaceId: WorkspaceId,
  questionId: string,
  close: MockQuestionClose,
): Promise<WorkerQuestion> => {
  const all = deps.questionsOf.get(workspaceId) ?? [];
  const question = all.find((each) => each.id.toLowerCase() === questionId.toLowerCase());
  if (question === undefined) {
    throw Object.assign(new Error(`There is no question ${questionId} in this workspace.`), {
      _tag: "NotFound",
      entity: "question",
      id: questionId,
    });
  }
  if (!isOpenQuestion(question)) {
    throw new MockInvalidState(`${question.id} is ${question.stage} already.`);
  }
  const text =
    "answer" in close
      ? workerAnswerMessage(question, close.answer, { closedBy: "user" })
      : workerDismissMessage(question, close.reason);
  const delivered = await deps.deliver(question.threadId, text);
  const closed: WorkerQuestion = {
    ...question,
    stage: "answer" in close ? "answered" : "dismissed",
    ...("answer" in close ? { answer: close.answer } : {}),
    ...("dismissed" in close && close.reason !== undefined ? { reason: close.reason } : {}),
    closedBy: "user",
    closedAt: Date.now(),
    delivered,
  };
  const after = all.map((each) => (each.id === closed.id ? closed : each));
  deps.questionsOf.set(workspaceId, after);
  if (!after.some((each) => each.threadId === closed.threadId && isOpenQuestion(each))) {
    deps.inputAt.set(closed.threadId, Date.now());
  }
  deps.showQuestion(closed);
  deps.changed(workspaceId);
  return closed;
};
