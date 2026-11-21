import {
  isOpenQuestion,
  WORKER_QUESTION_TRIAGE_MS,
  WORKER_QUESTIONS_KEPT_CLOSED,
  type ForwardedBy,
  type QuestionDelivery,
  type QuestionWithdrawal,
  type WorkerQuestion,
} from "@gram/contracts";
import type { OutboxState, StoredWorkerQuestion } from "./outbox.ts";

/** The record as surfaces see it, without what only the outbox needs. */
export const publicQuestion = (stored: StoredWorkerQuestion): WorkerQuestion => {
  const {
    copyOwed: _,
    cardMessageId: _card,
    deliveryOwed: _owed,
    closedFor: _for,
    ...question
  } = stored;
  return question;
};

export const questionsOf = (outbox: OutboxState): ReadonlyArray<StoredWorkerQuestion> =>
  outbox.questions ?? [];

/** One question by id, ignoring case, since an agent may write `wq7`. */
export const findQuestion = (outbox: OutboxState, id: string): StoredWorkerQuestion | undefined => {
  const wanted = id.trim().toLowerCase();
  return questionsOf(outbox).find((question) => question.id.toLowerCase() === wanted);
};

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

/**
 * The outbox with every question in triage due now, for a pause: nobody triages while paused, so
 * none waits out its time (`triageCutShort`). Answers the ids it made due.
 */
export const dueAtPause = (
  outbox: OutboxState,
  now: number,
): readonly [OutboxState, readonly string[]] => {
  const due = questionsOf(outbox).filter(
    (question) => question.stage === "triage" && question.triageUntil > now,
  );
  const ids = new Set(due.map((question) => question.id));
  const questions = questionsOf(outbox).map((question) =>
    ids.has(question.id) ? { ...question, triageUntil: now } : question,
  );
  return [ids.size === 0 ? outbox : withQuestions(outbox, questions), [...ids]];
};

/** Whether a question's triage ended before its time: a pause cut it short (`dueAtPause`). */
export const triageCutShort = (question: StoredWorkerQuestion): boolean =>
  question.triageUntil < question.askedAt + WORKER_QUESTION_TRIAGE_MS;

/** A move refused, in words for whoever tried it. */
export interface QuestionRefusal {
  readonly refused: string;
  /** `refusal()`'s code, for a tool's message. */
  readonly code: "unknown_question" | "closed" | "forwarded" | "not_yours";
}

const closedRefusal = (question: StoredWorkerQuestion): QuestionRefusal => ({
  code: "closed",
  refused:
    question.withdrawal !== undefined
      ? `${question.id} is closed already: ${question.withdrawal.how}, says ${
          question.withdrawal.by === "worker" ? "the worker" : "the orchestrator"
        }.`
      : `${question.id} is ${question.stage} already${
          question.closedBy === undefined
            ? ""
            : ` by ${question.closedBy === "user" ? "the user" : "the orchestrator"}`
        }.`,
});

/**
 * The question moved to the user: by the orchestrator with its line, by the timeout or a pause. A
 * timeout a pause brought forward (`dueAtPause`) is the pause's.
 */
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
    forwardedBy: by === "timeout" && triageCutShort(question) ? "paused" : by,
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
 * The question withdrawn by its worker or its orchestrator, in triage or forwarded: off the user's
 * board at once, with the reason in its history. A closed one, the user's answer above all, stays
 * as it is. Only the orchestrator's withdrawal owes the worker a notice; the worker made its own.
 */
export const withdrawn = (
  question: StoredWorkerQuestion,
  withdrawal: QuestionWithdrawal,
  reason: string,
  at: number,
): StoredWorkerQuestion | QuestionRefusal => {
  if (!isOpenQuestion(question)) return closedRefusal(question);
  return {
    ...question,
    stage: "dismissed",
    reason,
    withdrawal,
    ...(withdrawal.by === "orchestrator"
      ? { closedBy: "orchestrator" as const, deliveryOwed: true as const }
      : {}),
    closedAt: at,
  };
};

/**
 * The question answered by the user in a message they wrote to an agent, at any open stage:
 * `answer` is that message word for word, and `recordedBy` the agent that judged it answers the
 * question. Recorded by the worker, the orchestrator gets the copy; by the orchestrator, the worker
 * gets the answer. A closed one, the user's answer above all, stays as it is.
 */
export const answeredFromMessage = (
  question: StoredWorkerQuestion,
  answer: string,
  recordedBy: "worker" | "orchestrator",
  at: number,
): StoredWorkerQuestion | QuestionRefusal => {
  if (!isOpenQuestion(question)) return closedRefusal(question);
  return {
    ...question,
    stage: "answered",
    answer,
    closedBy: "user",
    recordedBy,
    closedAt: at,
    ...(recordedBy === "orchestrator"
      ? { deliveryOwed: true as const }
      : { copyOwed: true as const }),
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
