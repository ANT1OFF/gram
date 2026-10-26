import type { WorkspaceId } from "@gram/contracts";

import type { Api } from "@/api/types";
import { errorMessage } from "@/api/errors";

import type { Ask, AskAction } from "./ask-model";
import { useAskStackStore, type SendResult } from "./ask-stack-store";
import { answerGroup, failureText } from "./inbox-model";

// The one way an ask is answered, wherever the answer comes from: the stack's keys and buttons, or
// a desktop notification's Allow. It holds the answer for the undo window, hides the ask's ids from
// every view meanwhile, then sends it.

/** What an answer that is sent does; opening is the caller's. */
export type SendAction = Extract<AskAction, { kind: "group" | "answer" | "memory" | "worker" }>;

/** Sends an answer; what it reports is what the store brings back. */
const sendAnswer = async (
  api: Api,
  ask: Ask,
  action: SendAction,
  onMemory: (workspaceId: WorkspaceId) => void,
): Promise<SendResult> => {
  if (ask.worker !== undefined) {
    // A worker's question: its words go to the worker, whichever reply field they were typed in.
    const answer =
      action.kind === "worker" || action.kind === "memory"
        ? action.answer
        : action.kind === "answer" && action.answer.kind === "question"
          ? Object.values(action.answer.answers).flat().join("; ")
          : "";
    if (answer === "") return {};
    const { workspaceId, question } = ask.worker;
    await api.answerWorkerQuestion({ workspaceId, questionId: question.id, answer });
    onMemory(workspaceId);
    return {};
  }
  if (action.kind === "worker") return {};
  if (action.kind === "memory") {
    if (ask.memory === undefined) return {};
    const { workspaceId, question } = ask.memory;
    await api.answerQuestion({
      workspaceId,
      ...(question.id === undefined ? {} : { questionId: question.id }),
      question: question.text,
      answer: action.answer,
    });
    onMemory(workspaceId);
    return {};
  }
  if (ask.group === undefined) return {};
  if (action.kind === "group") {
    const result = await answerGroup(ask.group, action.decision, (answers) =>
      api.respondMany(answers),
    );
    return {
      failed: result.failed.map(({ entry }) => entry.request.id),
      problem: failureText(result),
    };
  }
  const [entry] = ask.group.entries;
  await api.respond(entry.threadId, entry.request.id, action.answer);
  return {};
};

/** Answers `ask` with `action`: held for undo, hidden everywhere, then sent. */
export const holdAnswer = (
  api: Api,
  ask: Ask,
  done: string,
  action: SendAction,
  onMemory: (workspaceId: WorkspaceId) => void,
): void =>
  useAskStackStore.getState().hold({ key: ask.key, ids: ask.ids, done }, () =>
    sendAnswer(api, ask, action, onMemory).catch((error: unknown) => ({
      failed: ask.ids,
      problem: errorMessage(error),
    })),
  );
