import {
  questionStatusLine,
  questionTime,
  type OrchestratorLedger,
  type QuestionChoice,
  type ThreadId,
  type WorkerQuestion,
} from "@gram/contracts";

import type { MemoryQuestion } from "./memory-model";

export interface QuestionCard {
  /** Unique in its list. */
  readonly key: string;
  /** `Q3`, `WQ7`; absent for an orchestrator entry that has none. */
  readonly id: string | undefined;
  /** The question, as its asker wrote it. */
  readonly text: string;
  /** What else the asker said: an entry's detail, a worker's context. */
  readonly detail: string | undefined;
  readonly options: readonly QuestionChoice[];
  readonly multiSelect: boolean;
  /** The label of the option the asker recommends. */
  readonly recommended: string | undefined;
  /** The mock the question is about, its `mock.json` or a page: "Open mocks". */
  readonly mock?: string | undefined;
  /**
   * The thread that asked, whose folders the options' screenshots and mock pages are in and whose
   * Preview opens them; absent when there is none to read them through.
   */
  readonly seenFrom?: ThreadId | undefined;
  /** A worker's own recommendation, for a question without options. */
  readonly recommendation?: string | undefined;
  /** The worker that asked; absent for the orchestrator's own questions. */
  readonly asker?:
    | { readonly threadId: ThreadId; readonly title: string; readonly feature: string }
    | undefined;
  /** The orchestrator's one line on a forward. */
  readonly note?: string | undefined;
  /** Where it stands: "Forwarded to you · 11:02". */
  readonly status?: string | undefined;
  /** Who the answer goes to, for the submit button and the text box. */
  readonly to: "orchestrator" | "worker";
  /** Whether the user can dismiss it rather than answer it. */
  readonly dismissable: boolean;
}

/** An open entry of the orchestrator's questions.md, asked by `orchestratorId`. */
export const memoryQuestionCard = (
  question: MemoryQuestion,
  index = 0,
  orchestratorId?: ThreadId,
): QuestionCard => ({
  key: question.id ?? `${index}:${question.text}`,
  id: question.id,
  text: question.text,
  detail: question.detail,
  options: question.options ?? [],
  multiSelect: question.multiSelect === true,
  recommended: question.recommended,
  mock: question.mock,
  seenFrom: orchestratorId,
  to: "orchestrator",
  dismissable: false,
});

/** A worker's question, open or closed. */
export const workerQuestionCard = (question: WorkerQuestion): QuestionCard => {
  const options = question.options ?? [];
  return {
    key: question.id,
    id: question.id,
    text: question.question,
    detail: question.context,
    options,
    multiSelect: question.multiSelect === true,
    recommended: options.length > 0 ? question.recommended : undefined,
    recommendation: options.length === 0 ? question.recommended : undefined,
    mock: question.mock,
    seenFrom: question.threadId,
    asker: { threadId: question.threadId, title: question.title, feature: question.feature },
    note: question.note,
    status: questionStatusLine(question),
    to: "worker",
    dismissable: true,
  };
};

/** The workers' questions waiting on the user: forwarded and not yet answered, oldest first. */
export const forwardedQuestions = (
  ledger: Pick<OrchestratorLedger, "questions"> | undefined,
): readonly WorkerQuestion[] =>
  (ledger?.questions ?? []).filter((question) => question.stage === "forwarded");

/** A feature's questions for its card's history: the open ones first, then the closed, newest first. */
export const featureQuestions = (
  ledger: Pick<OrchestratorLedger, "questions"> | undefined,
  feature: string,
): readonly WorkerQuestion[] =>
  (ledger?.questions ?? []).filter((question) => question.feature === feature);

/** What a closed question's card says it came to: the answer, the reason, and what settled it. */
export const questionOutcome = (question: WorkerQuestion): string | undefined => {
  if (question.stage === "answered") {
    return question.closedBy === "orchestrator" && question.source !== undefined
      ? `${question.answer ?? ""} (settled by ${question.source})`
      : question.answer;
  }
  if (question.stage === "dismissed") return question.reason;
  return undefined;
};

/**
 * A worker's latest report as the Board's second line: "Asked WQ6: …" once WQ6 is closed is what it
 * came to instead ("Answered by you: Cursor"), at the time it closed, so an answered question no
 * longer reads as one still asked.
 */
export const reportOrOutcome = (
  report: { readonly summary: string; readonly at: number },
  questions: readonly WorkerQuestion[],
): { readonly summary: string; readonly at: number } => {
  const id = /^Asked (WQ\d+)\b/.exec(report.summary)?.[1];
  const question = questions.find((each) => each.id === id);
  if (question === undefined || question.closedAt === undefined) return report;
  if (question.stage !== "answered" && question.stage !== "dismissed") return report;
  const { closedAt, ...undated } = question;
  const status = questionStatusLine(undated);
  const outcome = questionOutcome(question);
  return {
    summary: `${question.id} ${lowerFirst(status)}${outcome === undefined ? "" : `: ${outcome}`}`,
    at: closedAt,
  };
};

const lowerFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);

/**
 * What a question's id names, in words: "WQ3" is a worker's question, forwarded to you; "Q1" is one
 * the orchestrator keeps in memory for you to decide.
 */
export const questionKind = (id: string): string =>
  /^WQ\d/.test(id) ? "Worker question" : "Question";

/**
 * Who holds an open question and what Answer does about it, for its card in a thread: with the
 * orchestrator until its triage time (answering now takes it from there), or the user's, in the
 * Inbox too. `undefined` once it is closed.
 */
export const questionHolder = (
  question: Pick<WorkerQuestion, "stage" | "triageUntil" | "forwardedBy">,
  now: number,
): string | undefined => {
  if (question.stage === "triage") {
    return question.triageUntil > now
      ? `The orchestrator may settle it from your brief or memory; if not, it comes to your Inbox at ${questionTime(question.triageUntil)}. Answer now to decide it yourself.`
      : "It is on its way to your Inbox. Answer now to decide it yourself.";
  }
  if (question.stage === "forwarded") {
    const why =
      question.forwardedBy === "paused"
        ? "The workspace is paused, so it came straight to you"
        : "It waits on you";
    return `${why}, here and in your Inbox.`;
  }
  return undefined;
};
