import {
  isOpenQuestion,
  workerAnswerMessage,
  workerDismissMessage,
  workerRevisedAnswerMessage,
  type GramUIMessage,
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
  | { readonly answer: string; readonly replaces?: { readonly closedAt: number } | undefined }
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
  const replaces = "answer" in close ? close.replaces : undefined;
  if (replaces !== undefined) {
    if (question.stage !== "answered" || question.withdrawal !== undefined) {
      throw new MockInvalidState(`${question.id} has no answer to change.`);
    }
    if (question.closedAt !== replaces.closedAt) {
      throw new MockInvalidState(
        `${question.id}'s answer changed since you saw it: it is now “${question.answer ?? ""}”. Nothing was changed; look at that answer first.`,
      );
    }
  } else if (!isOpenQuestion(question)) {
    throw new MockInvalidState(`${question.id} is ${question.stage} already.`);
  }
  const text =
    "answer" in close
      ? (replaces === undefined ? workerAnswerMessage : workerRevisedAnswerMessage)(
          question,
          close.answer,
          { closedBy: "user" },
        )
      : workerDismissMessage(question, close.reason);
  const delivered = await deps.deliver(question.threadId, text);
  const { recordedBy: _by, source: _source, ...was } = question;
  const closed: WorkerQuestion = {
    ...(replaces === undefined ? question : { ...was, revised: true as const }),
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

/**
 * The forwards' cards in the orchestrator's transcript, as `forward_question` draws them: once,
 * as the question was then, for each one the orchestrator forwarded that is still open.
 */
export const showForwardCards = (
  host: { putMessage(threadId: ThreadId, message: GramUIMessage): void; ids(): string },
  orchestratorThreadId: ThreadId,
  questions: readonly WorkerQuestion[],
): void => {
  for (const question of questions) {
    if (question.forwardedBy !== "orchestrator" || question.stage !== "forwarded") continue;
    host.putMessage(orchestratorThreadId, {
      id: host.ids(),
      role: "assistant",
      metadata: { createdAt: question.forwardedAt ?? question.askedAt },
      parts: [
        {
          type: "data-worker-question",
          id: `worker-question:${question.id}:forwarded`,
          data: question,
        },
      ],
    });
  }
};
