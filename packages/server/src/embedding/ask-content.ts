import { type PendingRequest, revealHidden } from "@gram/contracts";
import {
  ASK_OPTION_DESCRIPTION_MAX_CHARS,
  ASK_OPTION_LABEL_MAX_CHARS,
  ASK_OPTIONS_MAX,
  ASK_QUESTION_MAX_CHARS,
  ASK_QUESTIONS_MAX,
} from "./ask-limits.ts";

/** The most of a plan `ask.opened` carries; a longer plan is cut and marked `planTruncated`. */
export const ASK_PLAN_MAX_CHARS = 50_000;

/** The most of an approval's command, and of its description or reason, `ask.opened` carries. */
export const ASK_COMMAND_MAX_CHARS = 10_000;
export const ASK_WORDS_MAX_CHARS = 1000;

const said = (words: string | undefined, max: number): string | undefined => {
  const trimmed = words?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : revealHidden(trimmed).slice(0, max);
};

/**
 * What a receiver shows beside an approval so a person can decide it away from the thread: the
 * exact command where the call runs one, the model's own words for why it makes the call, and why
 * the call asks at all (the permission rule or mode that held it). Hidden characters are shown.
 */
export const approvalContent = (
  request: Extract<PendingRequest, { kind: "approval" }>,
): { readonly command?: string; readonly description?: string; readonly reason?: string } => {
  const command =
    typeof request.input["command"] === "string"
      ? said(request.input["command"], ASK_COMMAND_MAX_CHARS)
      : undefined;
  const description = said(request.description, ASK_WORDS_MAX_CHARS);
  const reason = said(request.decisionReason, ASK_WORDS_MAX_CHARS);
  return {
    ...(command === undefined ? {} : { command }),
    ...(description === undefined ? {} : { description }),
    ...(reason === undefined ? {} : { reason }),
  };
};

/**
 * What a receiver needs to show a question or a plan and answer it through `asks/answer`: the
 * questions with their choices, or the plan. An answer is keyed by each question's text and names
 * choices by their labels, so neither is ever cut: a question ask that doesn't fit whole is sent
 * without its questions, and a receiver sends the person to the thread. An approval carries what is decided (`approvalContent`).
 */
export const askContent = (
  request: PendingRequest,
): {
  readonly questions?: ReadonlyArray<unknown>;
  readonly plan?: string;
  readonly planTruncated?: true;
  readonly command?: string;
  readonly description?: string;
  readonly reason?: string;
} => {
  if (request.kind === "approval") return approvalContent(request);
  if (request.kind === "plan") {
    return request.plan.length > ASK_PLAN_MAX_CHARS
      ? { plan: request.plan.slice(0, ASK_PLAN_MAX_CHARS), planTruncated: true }
      : { plan: request.plan };
  }
  if (request.kind !== "question") return {};
  const { questions } = request;
  const fits =
    questions.length > 0 &&
    questions.length <= ASK_QUESTIONS_MAX &&
    questions.every(
      (each) =>
        each.question.length > 0 &&
        each.question.length <= ASK_QUESTION_MAX_CHARS &&
        each.options.length <= ASK_OPTIONS_MAX &&
        each.options.every(
          (option) => option.label.length > 0 && option.label.length <= ASK_OPTION_LABEL_MAX_CHARS,
        ),
    );
  if (!fits) return {};
  return {
    questions: questions.map((each) => ({
      question: each.question,
      ...(each.header === "" ? {} : { header: each.header.slice(0, 200) }),
      options: each.options.map((option) => ({
        label: option.label,
        ...(option.description === ""
          ? {}
          : { description: option.description.slice(0, ASK_OPTION_DESCRIPTION_MAX_CHARS) }),
      })),
      multiSelect: each.multiSelect,
    })),
  };
};
