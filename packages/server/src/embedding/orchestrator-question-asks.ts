import { type MemoryQuestion, type QuestionAnswer, WorkspaceId } from "@gram/contracts";
import {
  ASK_OPTION_DESCRIPTION_MAX_CHARS,
  ASK_OPTION_LABEL_MAX_CHARS,
  ASK_OPTIONS_MAX,
  ASK_QUESTION_MAX_CHARS,
} from "./ask-limits.ts";

const PREFIX = "oq:";

/** The ask id of entry `questionId` in `workspaceId`: `oq:<workspaceId>:Q3`. */
export const orchestratorQuestionAskId = (workspaceId: WorkspaceId, questionId: string): string =>
  `${PREFIX}${workspaceId}:${questionId}`;

/** The workspace and entry an ask id names, or `undefined` for any other ask's id. */
export const parseOrchestratorQuestionAskId = (
  id: string,
): { readonly workspaceId: WorkspaceId; readonly questionId: string } | undefined => {
  if (!id.startsWith(PREFIX)) return undefined;
  const rest = id.slice(PREFIX.length);
  const at = rest.lastIndexOf(":");
  if (at <= 0 || at === rest.length - 1) return undefined;
  return { workspaceId: WorkspaceId.make(rest.slice(0, at)), questionId: rest.slice(at + 1) };
};

/**
 * Whether an entry is an ask: open, with an id to answer it by. One with an answer on its way is
 * still open, so its ask resolves as answered when the entry closes, not as withdrawn before.
 */
export const isOrchestratorAsk = (
  question: MemoryQuestion,
): question is MemoryQuestion & { readonly id: string } =>
  question.open && question.id !== undefined;

/**
 * `ask.opened`'s data for an open entry: one question, keyed by its words, with its choices. One
 * too large to carry whole carries no `questions`, and a receiver sends the person to the thread.
 */
export const orchestratorQuestionAsk = (
  workspaceId: WorkspaceId,
  question: MemoryQuestion & { readonly id: string },
): Record<string, unknown> => {
  const options = question.options ?? [];
  const fits =
    question.text.length > 0 &&
    question.text.length <= ASK_QUESTION_MAX_CHARS &&
    options.length <= ASK_OPTIONS_MAX &&
    options.every(
      (option) => option.label.length > 0 && option.label.length <= ASK_OPTION_LABEL_MAX_CHARS,
    );
  return {
    id: orchestratorQuestionAskId(workspaceId, question.id),
    kind: "question",
    title: question.text.slice(0, 300),
    orchestratorQuestion: question.id,
    ...(fits
      ? {
          questions: [
            {
              question: question.text,
              header: question.id,
              options: options.map((option) => ({
                label: option.label,
                ...(option.description === undefined
                  ? {}
                  : { description: option.description.slice(0, ASK_OPTION_DESCRIPTION_MAX_CHARS) }),
              })),
              multiSelect: question.multiSelect === true,
            },
          ],
        }
      : {}),
    ...(question.detail === undefined ? {} : { context: question.detail }),
    ...(question.recommended === undefined ? {} : { recommended: question.recommended }),
  };
};

/** How a closed entry resolves its ask: `answered` when it was closed as answered, else `withdrawn`. */
export const orchestratorQuestionHow = (
  question: Pick<MemoryQuestion, "open" | "closedAs"> | undefined,
): "answered" | "withdrawn" =>
  question !== undefined && !question.open && question.closedAs === "answered"
    ? "answered"
    : "withdrawn";

/** The text of a person's answer, from `asks/answer`'s question answer; `undefined` when empty. */
export const orchestratorQuestionAnswerText = (
  question: Pick<MemoryQuestion, "text">,
  answer: QuestionAnswer,
): string | undefined => {
  const given = answer.answers[question.text] ?? Object.values(answer.answers)[0] ?? [];
  const text = given
    .map((each) => each.trim())
    .filter((each) => each !== "")
    .join(", ");
  return text === "" ? undefined : text;
};
