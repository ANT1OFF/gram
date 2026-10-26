// A worker's own questions (docs/design/worker-questions.md): asked with `ask_question`, triaged by
// its orchestrator (answered with `answer_worker`, or forwarded with `forward_question`), and
// otherwise answered or dismissed by the user. The server keeps them in the workspace's outbox; the
// ledger carries them to every surface and the digest to the orchestrator. A leaf beside
// `questions.ts`, whose choices and limits it shares: it imports only that, `mock-visuals.ts` and
// `ids.ts`.

import * as Schema from "effect/Schema";
import { ThreadId, WorkspaceId } from "./ids.ts";
import { visualsProblem } from "./mock-visuals.ts";
import {
  QUESTION_CONTEXT_MAX,
  QUESTION_DESCRIPTION_MAX,
  QUESTION_LABEL_MAX,
  QUESTION_OPTIONS_MAX,
  QUESTION_OPTIONS_MIN,
  QUESTION_TEXT_MAX,
  QuestionChoice,
} from "./questions.ts";

/**
 * How long a question waits in triage before it forwards itself to the user: the ten minutes a
 * worker's waiting request waits before it becomes the orchestrator's business
 * (`REQUEST_PENDING_WAKE_MS`), long enough for an orchestrator in the middle of a turn to finish it
 * and read the digest, short enough that a busy or stuck one costs the user little.
 */
export const WORKER_QUESTION_TRIAGE_MS = 10 * 60_000;
/** The orchestrator's line of context on a forward: one line, this long at most. */
export const FORWARD_CONTEXT_MAX = 200;
/** What settles an answer the orchestrator gives (`answer_worker`'s `source`). */
export const ANSWER_SOURCE_MAX = 200;
/** A free-text recommendation, for a question without options. */
export const WORKER_RECOMMENDATION_MAX = 300;
/** The longest answer, from the orchestrator or the user. */
export const WORKER_QUESTION_ANSWER_MAX = 2000;
/** The longest reason a dismissal gives. */
export const DISMISS_REASON_MAX = 500;
/** How many closed questions a workspace keeps for history, newest first. */
export const WORKER_QUESTIONS_KEPT_CLOSED = 50;

/**
 * Where a question stands: with the orchestrator (`triage`), with the user (`forwarded`), or
 * closed, `answered` by one of them or `dismissed` by the user.
 */
export const WorkerQuestionStage = Schema.Literals([
  "triage",
  "forwarded",
  "answered",
  "dismissed",
]);
export type WorkerQuestionStage = typeof WorkerQuestionStage.Type;

/**
 * Why a question reached the user: the orchestrator forwarded it, nobody triaged it in time, or a
 * pause meant nobody would.
 */
export const ForwardedBy = Schema.Literals(["orchestrator", "timeout", "paused"]);
export type ForwardedBy = typeof ForwardedBy.Type;

/** How the answer or dismissal reached the worker. */
export const QuestionDelivery = Schema.Literals(["steered", "queued", "sent"]);
export type QuestionDelivery = typeof QuestionDelivery.Type;

export const WorkerQuestion = Schema.Struct({
  /** `WQ7`: unique in its workspace, never reused. */
  id: Schema.String,
  workspaceId: WorkspaceId,
  /** The worker that asked. */
  threadId: ThreadId,
  feature: Schema.String,
  /** The worker's title when it asked. */
  title: Schema.String,
  /** The question in the worker's words, exactly. */
  question: Schema.String,
  /** What the worker says the decision needs, in its words. */
  context: Schema.optionalKey(Schema.String),
  options: Schema.optionalKey(Schema.Array(QuestionChoice)),
  multiSelect: Schema.optionalKey(Schema.Literal(true)),
  /** The worker's own pick: an option's label, or a short free-text one when there are none. */
  recommended: Schema.optionalKey(Schema.String),
  /** The mock the question is about, its `mock.json` or a page, in the worker's folders. */
  mock: Schema.optionalKey(Schema.String),
  /** Epoch ms. */
  askedAt: Schema.Number,
  stage: WorkerQuestionStage,
  /** Epoch ms it forwards itself if still in triage. */
  triageUntil: Schema.Number,
  forwardedAt: Schema.optionalKey(Schema.Number),
  forwardedBy: Schema.optionalKey(ForwardedBy),
  /** The orchestrator's one line on a forward: a recommendation, or who else it affects. */
  note: Schema.optionalKey(Schema.String),
  answer: Schema.optionalKey(Schema.String),
  /** Who closed it; only the user dismisses. */
  closedBy: Schema.optionalKey(Schema.Literals(["orchestrator", "user"])),
  /** What settles an orchestrator's answer: the brief, a standing decision, a memory entry. */
  source: Schema.optionalKey(Schema.String),
  /** A dismissal's reason, when the user gave one. */
  reason: Schema.optionalKey(Schema.String),
  /** Epoch ms. */
  closedAt: Schema.optionalKey(Schema.Number),
  delivered: Schema.optionalKey(QuestionDelivery),
});
export type WorkerQuestion = typeof WorkerQuestion.Type;

/** It still waits: on the orchestrator, or on the user. */
export const isOpenQuestion = (question: Pick<WorkerQuestion, "stage">): boolean =>
  question.stage === "triage" || question.stage === "forwarded";

/** The user's answer from any surface. */
export const AnswerWorkerQuestionInput = Schema.Struct({
  workspaceId: WorkspaceId,
  questionId: Schema.NonEmptyString,
  answer: Schema.NonEmptyString.check(Schema.isMaxLength(WORKER_QUESTION_ANSWER_MAX)),
});
export type AnswerWorkerQuestionInput = typeof AnswerWorkerQuestionInput.Type;

/** The user's dismissal, with a reason or without. */
export const DismissWorkerQuestionInput = Schema.Struct({
  workspaceId: WorkspaceId,
  questionId: Schema.NonEmptyString,
  reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(DISMISS_REASON_MAX))),
});
export type DismissWorkerQuestionInput = typeof DismissWorkerQuestionInput.Type;

/** What `ask_question` takes from a worker. */
export interface AskQuestionInput {
  readonly question: string;
  readonly context?: string | undefined;
  readonly options?: ReadonlyArray<QuestionChoice> | undefined;
  readonly multiSelect?: boolean | undefined;
  readonly recommended?: string | undefined;
  readonly mock?: string | undefined;
}

const oneLine = (text: string): string => text.replaceAll(/\s+/g, " ").trim();

/** Why `ask_question` refuses `input`, in words the worker can act on; `undefined` when it's fine. */
export const askQuestionProblem = (input: AskQuestionInput): string | undefined => {
  const question = input.question.trim();
  if (question === "") return "Say what the question is.";
  if (question.length > QUESTION_TEXT_MAX) {
    return `Keep the question to ${QUESTION_TEXT_MAX} characters, and put the rest in context.`;
  }
  if ((input.context ?? "").length > QUESTION_CONTEXT_MAX) {
    return `Keep the context to ${QUESTION_CONTEXT_MAX} characters.`;
  }
  const options = input.options ?? [];
  if (
    options.length > 0 &&
    (options.length < QUESTION_OPTIONS_MIN || options.length > QUESTION_OPTIONS_MAX)
  ) {
    return `Offer ${QUESTION_OPTIONS_MIN} to ${QUESTION_OPTIONS_MAX} options, or none; the user can always answer in their own words.`;
  }
  const labels = options.map((option) => oneLine(option.label));
  if (labels.some((label) => label === "" || label.length > QUESTION_LABEL_MAX)) {
    return `Give every option a label of at most ${QUESTION_LABEL_MAX} characters.`;
  }
  if (new Set(labels.map((label) => label.toLowerCase())).size !== labels.length) {
    return "Give every option a label of its own.";
  }
  if (options.some((option) => (option.description ?? "").length > QUESTION_DESCRIPTION_MAX)) {
    return `Keep each option's description to ${QUESTION_DESCRIPTION_MAX} characters.`;
  }
  if (input.recommended !== undefined) {
    const recommended = oneLine(input.recommended);
    if (options.length > 0 && !labels.includes(recommended)) {
      return "With options, `recommended` has to be one of their labels.";
    }
    if (recommended.length > WORKER_RECOMMENDATION_MAX) {
      return `Keep the recommendation to ${WORKER_RECOMMENDATION_MAX} characters.`;
    }
  }
  return visualsProblem(options, input.mock);
};

/** Why `forward_question`'s context is refused; `undefined` when there is none or it is one line. */
export const forwardContextProblem = (context: string | undefined): string | undefined => {
  if (context === undefined) return undefined;
  if (/[\r\n]/.test(context.trim())) {
    return "Give at most one line of context: a recommendation, or which other workers it affects. The question itself goes as the worker wrote it.";
  }
  if (context.trim().length > FORWARD_CONTEXT_MAX) {
    return `Keep the context to one line of ${FORWARD_CONTEXT_MAX} characters.`;
  }
  return undefined;
};

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/** The question as a message quotes it: on one line, clipped. */
const quote = (question: Pick<WorkerQuestion, "question">): string =>
  `“${clip(oneLine(question.question), 160)}”`;

/**
 * What the worker is sent when its question is answered: the answer, who gave it and on what
 * grounds, and that its orchestrator knows.
 */
export const workerAnswerMessage = (
  question: Pick<WorkerQuestion, "id" | "question">,
  answer: string,
  by:
    | { readonly closedBy: "user" }
    | { readonly closedBy: "orchestrator"; readonly source: string },
): string =>
  by.closedBy === "user"
    ? `The user answered your question ${question.id} (${quote(question)}): ${answer.trim()}\n\nYour orchestrator has a copy. Go on with this answer.`
    : `Your orchestrator answered your question ${question.id} (${quote(question)}), settled by ${oneLine(by.source)}: ${answer.trim()}\n\nGo on with this answer. If it doesn't fit what you found, say why with \`report\`.`;

/** What the worker is sent when the user dismisses its question. */
export const workerDismissMessage = (
  question: Pick<WorkerQuestion, "id" | "question">,
  reason: string | undefined,
): string => {
  const why = reason === undefined || reason.trim() === "" ? "" : ` Their reason: ${reason.trim()}`;
  return `The user dismissed your question ${question.id} (${quote(question)}) without answering it.${why}\n\nDon't wait for an answer: go on with your own judgment and say what you assumed in your report, or ask again with \`ask_question\` if you can't move without one.`;
};

const pad = (n: number): string => String(n).padStart(2, "0");

/** "14:05", the local 24-hour time a card shows. */
export const questionTime = (ms: number): string => {
  const date = new Date(ms);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

/**
 * "Answered by you · 14:05", "Answered by the orchestrator · 09:12", "Dismissed by you · 16:40",
 * "Forwarded to you · 11:02", "With the orchestrator": where a question stands, in a card's words.
 */
export const questionStatusLine = (
  question: Pick<WorkerQuestion, "stage" | "closedBy" | "closedAt" | "forwardedAt" | "forwardedBy">,
): string => {
  switch (question.stage) {
    case "triage":
      return "With the orchestrator";
    case "forwarded": {
      const how =
        question.forwardedBy === "timeout"
          ? "Forwarded to you, untriaged"
          : question.forwardedBy === "paused"
            ? "Forwarded to you while paused"
            : "Forwarded to you";
      return question.forwardedAt === undefined
        ? how
        : `${how} · ${questionTime(question.forwardedAt)}`;
    }
    case "answered":
    case "dismissed": {
      const verb = question.stage === "answered" ? "Answered" : "Dismissed";
      const who = question.closedBy === "orchestrator" ? "the orchestrator" : "you";
      return question.closedAt === undefined
        ? `${verb} by ${who}`
        : `${verb} by ${who} · ${questionTime(question.closedAt)}`;
    }
  }
};
