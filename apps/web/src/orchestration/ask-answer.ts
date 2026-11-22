import type { WorkspaceId } from "@gram/contracts";

import type { Api } from "@/api/types";
import { errorMessage } from "@/api/errors";
import { respondToCard } from "@/api/respond-to-card";

import { askOf, type Ask, type AskAction } from "./ask-model";
import { useAskStackStore, type SendResult } from "./ask-stack-store";
import { answerGroup, failureText, type InboxEntry } from "./inbox-model";

/** What an answer that is sent does; opening is the caller's. */
export type SendAction = Extract<AskAction, { kind: "group" | "answer" | "memory" | "worker" }>;

const sendAnswer = async (
  api: Api,
  ask: Ask,
  action: SendAction,
  onMemory: (workspaceId: WorkspaceId) => void,
): Promise<SendResult> => {
  if (ask.worker !== undefined) {
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
  await respondToCard(api, entry.threadId, entry.request, action.answer);
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

/**
 * Answers one thread's request of a group on its own, held for undo as the group's answer is: the
 * group's other members still wait, as an ask of their own.
 */
export const holdOneAnswer = (api: Api, entry: InboxEntry, decision: "allow" | "deny"): void =>
  holdAnswer(
    api,
    askOf({ key: entry.request.id, entries: [entry] }),
    decision === "allow" ? `Allowed ${entry.title}` : `Denied ${entry.title}`,
    { kind: "group", decision },
    () => undefined,
  );
