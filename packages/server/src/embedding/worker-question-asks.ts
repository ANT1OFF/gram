import { type QuestionAnswer, type WorkerQuestion, WorkspaceId } from "@gram/contracts";
import {
  ASK_OPTION_LABEL_MAX_CHARS,
  ASK_OPTIONS_MAX,
  ASK_QUESTION_MAX_CHARS,
} from "./ask-limits.ts";

const PREFIX = "wq:";

/** The ask id of `questionId` in `workspaceId`: `wq:<workspaceId>:WQ7`. */
export const workerQuestionAskId = (workspaceId: WorkspaceId, questionId: string): string =>
  `${PREFIX}${workspaceId}:${questionId}`;

/** The workspace and question an ask id names, or `undefined` for any other ask's id. */
export const parseWorkerQuestionAskId = (
  id: string,
): { readonly workspaceId: WorkspaceId; readonly questionId: string } | undefined => {
  if (!id.startsWith(PREFIX)) return undefined;
  const rest = id.slice(PREFIX.length);
  const at = rest.lastIndexOf(":");
  if (at <= 0 || at === rest.length - 1) return undefined;
  const questionId = rest.slice(at + 1);
  if (!/^WQ\d+$/.test(questionId)) return undefined;
  return { workspaceId: WorkspaceId.make(rest.slice(0, at)), questionId };
};

/** Whether a question waits on the user, which is when a receiver shows it. */
export const isUsersQuestion = (question: Pick<WorkerQuestion, "stage">): boolean =>
  question.stage === "forwarded";

/**
 * `ask.opened`'s data for a forwarded question: one question, keyed by the worker's words, with
 * its choices. One too large to carry whole carries no `questions`, and a receiver sends the person
 * to the thread, as for a harness's question.
 */
export const workerQuestionAsk = (question: WorkerQuestion): Record<string, unknown> => {
  const options = question.options ?? [];
  const fits =
    question.question.length > 0 &&
    question.question.length <= ASK_QUESTION_MAX_CHARS &&
    options.length <= ASK_OPTIONS_MAX &&
    options.every(
      (option) => option.label.length > 0 && option.label.length <= ASK_OPTION_LABEL_MAX_CHARS,
    );
  const note = question.note === undefined ? "" : ` Orchestrator: ${question.note}`;
  return {
    id: workerQuestionAskId(question.workspaceId, question.id),
    kind: "question",
    title: `${question.title} asks`,
    workerQuestion: question.id,
    ...(fits
      ? {
          questions: [
            {
              question: question.question,
              header: question.id,
              options: options.map((option) => ({
                label: option.label,
                ...(option.description === undefined ? {} : { description: option.description }),
              })),
              multiSelect: question.multiSelect === true,
            },
          ],
        }
      : {}),
    ...(question.context === undefined && note === ""
      ? {}
      : { context: `${question.context ?? ""}${note}`.trim() }),
    ...(question.recommended === undefined ? {} : { recommended: question.recommended }),
  };
};

/**
 * The text of a person's answer to a worker question, from `asks/answer`'s question answer: what
 * they picked or wrote for it, keyed by its words; `undefined` when it names nothing.
 */
export const workerQuestionAnswerText = (
  question: Pick<WorkerQuestion, "question">,
  answer: QuestionAnswer,
): string | undefined => {
  const given = answer.answers[question.question] ?? Object.values(answer.answers)[0] ?? [];
  const text = given
    .map((each) => each.trim())
    .filter((each) => each !== "")
    .join(", ");
  return text === "" ? undefined : text;
};

/**
 * How a closed question resolves its ask: `answered` when the user answered it, wherever they did,
 * and `withdrawn` otherwise (dismissed, withdrawn, or answered by its orchestrator).
 */
export const workerQuestionHow = (
  question: Pick<WorkerQuestion, "stage" | "closedBy">,
): "answered" | "withdrawn" =>
  question.stage === "answered" && question.closedBy === "user" ? "answered" : "withdrawn";
