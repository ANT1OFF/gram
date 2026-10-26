import {
  questionStatusLine,
  type OrchestratorLedger,
  type QuestionChoice,
  type ThreadId,
  type WorkerQuestion,
} from "@gram/contracts";

import type { MemoryQuestion } from "./memory-model";

// One question card for both kinds of question the user answers (docs/design/worker-questions.md):
// the orchestrator's own (`ask_user`, an entry of questions.md) and a worker's (`ask_question`),
// forwarded to the user. The card shows the asker's words exactly; a worker's adds who asked, the
// orchestrator's line, and Dismiss. No React.

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
