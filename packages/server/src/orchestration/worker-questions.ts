// The workers' questions in a workspace's outbox (docs/design/worker-questions.md): pure moves on
// `OutboxState.questions`, which the service makes under the outbox lock. Who may make a move is
// the service's to check; these only refuse a move the question's stage doesn't allow.

import {
  isOpenQuestion,
  WORKER_QUESTIONS_KEPT_CLOSED,
  type ForwardedBy,
  type QuestionDelivery,
  type WorkerQuestion,
} from "@gram/contracts";
import type { OutboxState, StoredWorkerQuestion } from "./outbox.ts";

/** The record as surfaces see it, without what only the outbox needs. */
export const publicQuestion = (stored: StoredWorkerQuestion): WorkerQuestion => {
  const { copyOwed: _, cardMessageId: _card, deliveryOwed: _owed, ...question } = stored;
  return question;
};

export const questionsOf = (outbox: OutboxState): ReadonlyArray<StoredWorkerQuestion> =>
  outbox.questions ?? [];

/** One question by id, ignoring case, since an agent may write `wq7`. */
export const findQuestion = (outbox: OutboxState, id: string): StoredWorkerQuestion | undefined => {
  const wanted = id.trim().toLowerCase();
  return questionsOf(outbox).find((question) => question.id.toLowerCase() === wanted);
};

/**
 * The questions kept: every open one, and the newest `WORKER_QUESTIONS_KEPT_CLOSED` closed ones
 * whose copy is no longer owed, beside any whose copy still is. Oldest first, as asked.
 */
const kept = (questions: ReadonlyArray<StoredWorkerQuestion>): StoredWorkerQuestion[] => {
  const closed = questions
    .filter((question) => !isOpenQuestion(question) && question.copyOwed !== true)
    .toSorted((a, b) => (b.closedAt ?? b.askedAt) - (a.closedAt ?? a.askedAt))
    .slice(0, WORKER_QUESTIONS_KEPT_CLOSED);
  const keep = new Set(closed.map((question) => question.id));
  return questions.filter(
    (question) => isOpenQuestion(question) || question.copyOwed === true || keep.has(question.id),
  );
};

/** The outbox with `questions` in place of its own, pruned; `questions` absent when empty. */
const withQuestions = (
  outbox: OutboxState,
  questions: ReadonlyArray<StoredWorkerQuestion>,
): OutboxState => {
  const { questions: _, ...rest } = outbox;
  const left = kept(questions);
  return left.length === 0 ? rest : { ...rest, questions: left };
};

/** A new question, given the next id, `WQ<n>`. */
export const addQuestion = (
  outbox: OutboxState,
  question: Omit<StoredWorkerQuestion, "id">,
): readonly [OutboxState, StoredWorkerQuestion] => {
  const seq = (outbox.questionSeq ?? 0) + 1;
  const added: StoredWorkerQuestion = { id: `WQ${seq}`, ...question };
  return [{ ...withQuestions(outbox, [...questionsOf(outbox), added]), questionSeq: seq }, added];
};

/** `question` in place of the one with its id. */
export const replaceQuestion = (outbox: OutboxState, question: StoredWorkerQuestion): OutboxState =>
  withQuestions(
    outbox,
    questionsOf(outbox).map((each) => (each.id === question.id ? question : each)),
  );

/** A move refused, in words for whoever tried it. */
export interface QuestionRefusal {
  readonly refused: string;
  /** `refusal()`'s code, for a tool's message. */
  readonly code: "unknown_question" | "closed" | "forwarded";
}

const closedRefusal = (question: StoredWorkerQuestion): QuestionRefusal => ({
  code: "closed",
  refused: `${question.id} is ${question.stage} already${
    question.closedBy === undefined
      ? ""
      : ` by ${question.closedBy === "user" ? "the user" : "the orchestrator"}`
  }.`,
});

/** The question moved to the user: by the orchestrator with its line, by the timeout or a pause. */
export const forwarded = (
  question: StoredWorkerQuestion,
  by: ForwardedBy,
  at: number,
  note?: string | undefined,
): StoredWorkerQuestion | QuestionRefusal => {
  if (question.stage === "forwarded") {
    return { code: "forwarded", refused: `${question.id} is with the user already.` };
  }
  if (question.stage !== "triage") return closedRefusal(question);
  const line = note?.trim();
  return {
    ...question,
    stage: "forwarded",
    forwardedAt: at,
    forwardedBy: by,
    ...(line === undefined || line === "" ? {} : { note: line }),
  };
};

/**
 * The question answered by the orchestrator, which may answer only one still in triage: once it is
 * forwarded, it is the user's.
 */
export const answeredByOrchestrator = (
  question: StoredWorkerQuestion,
  answer: string,
  source: string,
  at: number,
): StoredWorkerQuestion | QuestionRefusal => {
  if (question.stage === "forwarded") {
    return {
      code: "forwarded",
      refused: `${question.id} has been forwarded to the user, so it is theirs to answer now.`,
    };
  }
  if (question.stage !== "triage") return closedRefusal(question);
  return {
    ...question,
    stage: "answered",
    answer,
    closedBy: "orchestrator",
    source,
    closedAt: at,
    deliveryOwed: true,
  };
};

/** The question closed by the user, answered or dismissed, at any open stage; the copy is owed. */
export const closedByUser = (
  question: StoredWorkerQuestion,
  close: { readonly answer: string } | { readonly dismissed: true; readonly reason?: string },
  at: number,
): StoredWorkerQuestion | QuestionRefusal => {
  if (!isOpenQuestion(question)) return closedRefusal(question);
  const reason = "dismissed" in close ? close.reason?.trim() : undefined;
  return {
    ...question,
    stage: "answer" in close ? "answered" : "dismissed",
    ...("answer" in close ? { answer: close.answer } : {}),
    ...(reason === undefined || reason === "" ? {} : { reason }),
    closedBy: "user",
    closedAt: at,
    copyOwed: true,
    deliveryOwed: true,
  };
};

/**
 * The question once its owed notice is settled: with how it reached the worker, or with none when
 * the worker couldn't take one. Either way it is no longer owed.
 */
export const withDelivery = (
  question: StoredWorkerQuestion,
  delivered: QuestionDelivery | undefined,
): StoredWorkerQuestion => {
  const { deliveryOwed: _, ...settled } = question;
  return delivered === undefined ? settled : { ...settled, delivered };
};

export const isRefusal = (
  moved: StoredWorkerQuestion | QuestionRefusal,
): moved is QuestionRefusal => "refused" in moved;

/** The ledger's list: open ones oldest first, then the closed ones newest first. */
export const ledgerQuestions = (outbox: OutboxState): ReadonlyArray<WorkerQuestion> => {
  const all = questionsOf(outbox);
  const open = all.filter(isOpenQuestion);
  const closed = all
    .filter((question) => !isOpenQuestion(question))
    .toSorted((a, b) => (b.closedAt ?? b.askedAt) - (a.closedAt ?? a.askedAt));
  return [...open, ...closed].map(publicQuestion);
};

/** What a digest carries: the questions in triage, and the copies still owed. */
export const digestQuestions = (
  outbox: OutboxState,
):
  | {
      readonly triage: ReadonlyArray<WorkerQuestion>;
      readonly closed: ReadonlyArray<WorkerQuestion>;
    }
  | undefined => {
  const all = questionsOf(outbox);
  const triage = all.filter((question) => question.stage === "triage").map(publicQuestion);
  const closed = all.filter((question) => question.copyOwed === true).map(publicQuestion);
  return triage.length === 0 && closed.length === 0 ? undefined : { triage, closed };
};

/** The outbox once a digest that carried the copies of `ids` is acknowledged. */
export const withCopiesTold = (outbox: OutboxState, ids: ReadonlyArray<string>): OutboxState => {
  if (ids.length === 0) return outbox;
  const told = new Set(ids);
  let changed = false;
  const questions = questionsOf(outbox).map((question) => {
    if (question.copyOwed !== true || !told.has(question.id)) return question;
    changed = true;
    const { copyOwed: _, ...rest } = question;
    return rest;
  });
  return changed ? withQuestions(outbox, questions) : outbox;
};
