// Worker questions: `ask_question` from a worker, its triage by the
// orchestrator (`answer_worker` with a `questionId`, `forward_question`), the timer that forwards it
// to the user, the user's own answer or dismissal, and delivering each answer to the worker that
// asked. Also `answer_worker`, the orchestrator's answer to what a worker waits on.

import {
  InvalidState,
  NotFound,
  WORKER_ANSWER_MAX,
  WORKER_REPORT_SUMMARY_MAX,
  type ThreadId,
  type QuestionDelivery,
  type WorkerQuestion,
  askQuestionProblem,
  forwardContextProblem,
  isOpenQuestion,
  workerAnswerMessage,
  workerDismissMessage,
  workerWithdrawnMessage,
  userAnswerProblem,
  ANSWER_SOURCE_MAX,
  DISMISS_REASON_MAX,
  WORKER_QUESTION_ANSWER_MAX,
  WORKER_QUESTIONS_KEPT_CLOSED,
  WORKER_QUESTION_TRIAGE_MS,
  type WorkspaceId,
} from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import { redactText } from "../../logging/redact.ts";
import { makeDurableWork } from "../../durable-work.ts";
import { type OutboxState, type StoredWorkerQuestion } from "../outbox.ts";
import {
  addQuestion,
  answeredByOrchestrator,
  answeredFromMessage,
  closedByUser,
  findQuestion as findStoredQuestion,
  forwarded,
  isRefusal,
  publicQuestion,
  questionsOf,
  replaceQuestion,
  withDelivery,
  withdrawn,
  type QuestionRefusal,
} from "../worker-questions.ts";
import { refusal, userHoldReason, type PendingReason } from "../rules.ts";
import { type OrchestrationShape } from "./shape.ts";
import { USER_ANSWERS_MAX, userMessagesOf } from "../user-words.ts";
import { findUserMessages } from "../../persistence/thread-store.ts";
import { toolError, pausedFeatureOf, clipped, type OrchestrationKit } from "./kit.ts";
import { NOT_YOUR_MACHINE, recordActor } from "../../host/ownership.ts";

/** A worker's own words for a question, trimmed and scrubbed like everything a worker writes. */
const questionWords = (text: string): string => redactText(text.trim());

/** What the worker is told of a closed question, from what was stored with the decision. */
const closedQuestionText = (question: StoredWorkerQuestion) =>
  question.withdrawal !== undefined
    ? workerWithdrawnMessage(question, question.withdrawal.how, question.reason ?? "")
    : question.stage === "dismissed"
      ? workerDismissMessage(question, question.reason)
      : workerAnswerMessage(
          question,
          question.answer ?? "",
          question.closedBy === "orchestrator"
            ? { closedBy: "orchestrator", source: question.source ?? "" }
            : { closedBy: "user", recordedBy: question.recordedBy },
        );

/** Why each way a worker's thread leaves withdraws its open questions, as their history says. */
const LEFT_REASON = {
  archived: "Its thread was archived.",
  deleted: "Its thread was deleted.",
  detached: "Its thread left its orchestrator.",
  moved: "Its thread moved to another workspace.",
} as const;

/** A withdrawal's reason, scrubbed; or why it's refused. */
const withdrawReason = (tool: string, reason: string | undefined) => {
  const words = redactText((reason ?? "").trim());
  if (words === "") {
    return Effect.fail(
      toolError(tool, "Say why it no longer needs an answer: the user reads it in its history."),
    );
  }
  if (words.length > DISMISS_REASON_MAX) {
    return Effect.fail(toolError(tool, `Keep the reason to ${DISMISS_REASON_MAX} characters.`));
  }
  return Effect.succeed(words);
};

/** A worker question's timer key: its workspace and its id there, since ids restart at WQ1 in each. */
const questionTimerKey = (workspaceId: WorkspaceId, questionId: string) =>
  `${workspaceId}\u0000${questionId}`;

/** What the questions take from the rest of the service. */
export interface WorkerQuestionsDeps {
  readonly recordReport: OrchestrationShape["recordReport"];
  readonly wake: (
    workspaceId: WorkspaceId,
    reason: string,
    withoutDiff?: boolean,
    about?: Omit<PendingReason, "reason">,
  ) => Effect.Effect<void>;
}

/** `moved` as made for `closedFor`, when it moved and was made for a caller. */
const withClosedFor = (
  moved: StoredWorkerQuestion | QuestionRefusal,
  closedFor: StoredWorkerQuestion["closedFor"],
) => (isRefusal(moved) || closedFor === undefined ? moved : { ...moved, closedFor });

/** The worker-question tools and the timers and deliveries behind them. */
export const makeWorkerQuestions = (kit: OrchestrationKit, deps: WorkerQuestionsDeps) => {
  const {
    requireAuthority,
    findThread,
    delegated,
    readOutbox,
    store,
    runtimes,
    orchestrationChanged,
    questionTimers,
    signals,
    updateMemo,
    updateOutbox,
    listeningWorkspace,
    authorityOf,
  } = kit;
  const { recordReport, wake } = deps;

  /** Who a decision made now is for (`closedFor`): kept with it, for its owed notice. */
  const decidedFor = recordActor;

  const answerWorker: OrchestrationShape["answerWorker"] = (callerId, input) =>
    Effect.gen(function* () {
      const tool = "answer_worker";
      const { state } = yield* requireAuthority(tool, callerId);
      const workspaceId = state.workspace.id;
      if (state.paused !== undefined) {
        return yield* toolError(
          tool,
          refusal(
            "paused",
            `Orchestration is paused (${state.paused.reason}), so you answer nothing for the user. Only the user can resume it; end your turn.`,
          ),
        );
      }
      const target = yield* findThread(input.threadId);
      if (target === undefined || !(yield* delegated(callerId, input.threadId))) {
        return yield* toolError(
          tool,
          refusal(
            "not_your_worker",
            `${input.threadId} isn't one of your workers, so its questions aren't yours to answer.`,
          ),
        );
      }
      const pausedFeature = pausedFeatureOf(state, target);
      if (pausedFeature !== undefined) {
        return yield* toolError(
          tool,
          refusal(
            "feature_paused",
            `The user paused feature ${pausedFeature}, so you answer nothing for its workers. Only the user can resume it; leave it until a digest says they did.`,
          ),
        );
      }
      if ((yield* readOutbox(workspaceId)).workers[target.id]?.userIntervened === true) {
        return yield* toolError(
          tool,
          refusal("user_intervened", userHoldReason("so is its question")),
        );
      }
      const request = (yield* store.listRequests(target.id)).find(
        (each) => each.id === input.requestId,
      );
      if (request === undefined) {
        return yield* toolError(
          tool,
          refusal(
            "unknown_request",
            `“${target.title}” has no waiting request ${input.requestId}; it may have been answered already. list_workers shows what is waiting.`,
          ),
        );
      }
      if (request.kind !== "question") {
        return yield* toolError(
          tool,
          refusal(
            "wrong_kind",
            `That request is ${request.kind === "approval" ? "an approval" : "a plan"}, and approval and plan requests are the user's at every level of autonomy. Only a question can be answered for them.`,
          ),
        );
      }
      const answer = clipped(redactText(input.answer.trim()), WORKER_ANSWER_MAX);
      // A question card's answer is keyed by each question's own text (`QuestionAnswer`). The
      // tool takes one text, so a request that asks several things gets it under each of them.
      yield* runtimes
        .respond(target.id, request.id, {
          kind: "question",
          answers: Object.fromEntries(request.questions.map((each) => [each.question, [answer]])),
        })
        .pipe(
          Effect.mapError((e) =>
            toolError(
              tool,
              e._tag === "RequestNotFound"
                ? refusal("unknown_request", "That request was answered before yours arrived.")
                : e.message,
            ),
          ),
        );
      const at = yield* Clock.currentTimeMillis;
      yield* store.appendOrchestrationEvent(workspaceId, {
        at,
        kind: "answer",
        data: { threadId: target.id, requestId: request.id },
      });
      yield* orchestrationChanged(workspaceId);
      return {
        threadId: target.id,
        requestId: request.id,
        question: clipped(
          redactText(request.questions.map((each) => each.question).join("\n")),
          WORKER_ANSWER_MAX,
        ),
        answer,
        at,
      };
    });

  // ---------------------------------------------------------------------------------------
  // Workers' own questions (docs/design/worker-questions.md)
  // ---------------------------------------------------------------------------------------

  /** The worker's card for a question, replaced in place; a new one when that message is gone. */
  const showQuestionToWorker = (question: StoredWorkerQuestion) =>
    Effect.gen(function* () {
      const chunk = {
        type: "data-worker-question" as const,
        id: `worker-question:${question.id}`,
        data: publicQuestion(question),
      };
      if (question.cardMessageId !== undefined) {
        const replaced = yield* runtimes
          .updateDataPart(question.threadId, question.cardMessageId, chunk)
          .pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
        if (replaced) return question.cardMessageId;
      }
      return yield* runtimes
        .emitChunk(question.threadId, chunk)
        .pipe(Effect.orElseSucceed(() => undefined));
    });

  /** The card in the orchestrator's transcript, where it answered or forwarded the question. */
  const showQuestionToOrchestrator = (callerId: ThreadId, question: StoredWorkerQuestion) =>
    runtimes
      .emitChunk(callerId, {
        type: "data-worker-question",
        id: `worker-question:${question.id}:${question.stage}`,
        data: publicQuestion(question),
      })
      .pipe(Effect.ignore);

  /** Arms the move of a question still in triage to the user, at its `triageUntil`. */
  const armQuestionTimer = (
    workspaceId: WorkspaceId,
    question: StoredWorkerQuestion,
    now: number,
  ) =>
    FiberMap.run(
      questionTimers,
      questionTimerKey(workspaceId, question.id),
      Effect.sleep(Duration.millis(Math.max(0, question.triageUntil - now))).pipe(
        Effect.andThen(
          signals.offer({ type: "questionDue", workspaceId, questionId: question.id }),
        ),
      ),
    ).pipe(Effect.asVoid);

  const armQuestionTimers = (workspaceId: WorkspaceId) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const outbox = yield* readOutbox(workspaceId);
      for (const question of questionsOf(outbox)) {
        if (question.stage === "triage") yield* armQuestionTimer(workspaceId, question, now);
      }
    });

  /**
   * The worker was given an input: it no longer stands on its question, unless another of its
   * questions is still open, which keeps it in `question`.
   */
  const answeredInput = (workspaceId: WorkspaceId, question: StoredWorkerQuestion) =>
    Effect.gen(function* () {
      const outbox = yield* readOutbox(workspaceId);
      const more = questionsOf(outbox).some(
        (each) => each.threadId === question.threadId && isOpenQuestion(each),
      );
      if (more) return;
      const now = yield* Clock.currentTimeMillis;
      yield* updateMemo(workspaceId, question.threadId, (memo) => ({
        ...memo,
        lastInputAt: now,
      }));
    });

  /**
   * Moves a question under the outbox lock, or says why it can't be moved. `move` sees the stored
   * question; the moved one is written and returned.
   */
  const moveQuestion = (
    workspaceId: WorkspaceId,
    questionId: string,
    move: (question: StoredWorkerQuestion) => StoredWorkerQuestion | QuestionRefusal,
  ) =>
    updateOutbox(
      workspaceId,
      (outbox): readonly [OutboxState, StoredWorkerQuestion | QuestionRefusal] => {
        const question = findStoredQuestion(outbox, questionId);
        if (question === undefined) {
          return [
            outbox,
            {
              code: "unknown_question",
              refused: `There is no question ${questionId} in this workspace; the digest and list_workers name the open ones.`,
            },
          ];
        }
        const moved = move(question);
        return isRefusal(moved) ? [outbox, moved] : [replaceQuestion(outbox, moved), moved];
      },
    );

  /** Puts a question back as it was, after a delivery that failed; one moved since is left. */
  const restoreQuestion = (
    workspaceId: WorkspaceId,
    before: StoredWorkerQuestion,
    claimed: StoredWorkerQuestion,
  ) =>
    updateOutbox(workspaceId, (outbox) => {
      const now = findStoredQuestion(outbox, before.id);
      return now === undefined || now.stage !== claimed.stage || now.closedAt !== claimed.closedAt
        ? [outbox, undefined]
        : [replaceQuestion(outbox, before), undefined];
    });

  /**
   * Sends the worker the answer or dismissal of a question the caller has already closed: steered
   * into a running turn, queued behind it otherwise. Never counted as the user typing.
   */
  const deliverToWorker = (question: StoredWorkerQuestion, text: string) =>
    runtimes
      // Steered, as every notice is: the answer can change what the worker does now, and a steer
      // cancels nothing, so it lands after the tool call under way.
      .sendNotice(question.threadId, `question:${question.id}`, { text })
      .pipe(
        Effect.map((sent): QuestionDelivery =>
          sent.steered ? "steered" : sent.queued ? "queued" : "sent",
        ),
      );

  /** The owed notice settled: how it reached the worker, or `undefined` when it couldn't. */
  const settleDelivery = (
    workspaceId: WorkspaceId,
    closed: StoredWorkerQuestion,
    delivered: QuestionDelivery | undefined,
  ) =>
    updateOutbox(workspaceId, (outbox) => {
      const current = findStoredQuestion(outbox, closed.id);
      if (current === undefined) return [outbox, withDelivery(closed, delivered)];
      const next = withDelivery(current, delivered);
      return [replaceQuestion(outbox, next), next];
    });

  /**
   * A closed question's owed notice, as durable work: `deliveryOwed` is written with the decision,
   * the notice is sent, then the delivery is settled. A worker that is gone, archived or moved to
   * another workspace is never woken: the delivery is settled without it, and the decision stands. A
   * failed send leaves it owed, for the next retry or restart. On a retry, a notice a send before an
   * interruption or restart already queued or recorded is not sent again.
   */
  const owedNotices = makeDurableWork<
    { readonly workspaceId: WorkspaceId; readonly questionId: string },
    StoredWorkerQuestion,
    { readonly delivered: QuestionDelivery | undefined }
  >({
    lockKey: ({ workspaceId, questionId }) => questionTimerKey(workspaceId, questionId),
    read: ({ workspaceId, questionId }) =>
      readOutbox(workspaceId).pipe(Effect.map((outbox) => findStoredQuestion(outbox, questionId))),
    owed: (question) => question.deliveryOwed === true,
    // Delivered as the caller the decision was made in, a retry included (`durable-work.ts`).
    actor: (question) => Effect.succeed(question.closedFor),
    perform: (current, retry, { workspaceId }) =>
      Effect.gen(function* () {
        const worker = yield* findThread(current.threadId);
        if (worker === undefined || worker.parked || worker.workspaceId !== workspaceId) {
          return { delivered: undefined };
        }
        const text = closedQuestionText(current);
        const queued =
          retry && (yield* store.listQueue(worker.id)).some((item) => item.input.text === text);
        const recorded =
          retry &&
          !queued &&
          // Only the user messages whose stored form holds the text are read and decoded.
          (yield* store.messagesWith(worker.id, [text], "user")).some((message) =>
            message.parts.some((part) => part.type === "text" && part.text === text),
          );
        const delivered: QuestionDelivery | "refused" | undefined = queued
          ? "queued"
          : recorded
            ? "sent"
            : yield* deliverToWorker(current, text).pipe(
                // Made for someone this worker isn't theirs to change: settled, never sent.
                Effect.catchIf(
                  (error) => error._tag === "InvalidState" && error.message === NOT_YOUR_MACHINE,
                  () => Effect.succeed("refused" as const),
                ),
                Effect.catch((error) =>
                  Effect.logWarning("closed worker question notice not delivered").pipe(
                    Effect.annotateLogs({ workspaceId, questionId: current.id, kind: error._tag }),
                    Effect.as(undefined),
                  ),
                ),
              );
        if (delivered === "refused") return { delivered: undefined };
        return delivered === undefined ? undefined : { delivered };
      }),
    markDone: (current, { delivered }, { workspaceId }) =>
      settleDelivery(workspaceId, current, delivered),
  });

  /** Hands the worker a closed question's owed notice, once; the question as stored after. */
  const deliverOwed = (workspaceId: WorkspaceId, questionId: string, retry: boolean) =>
    owedNotices.attempt({ workspaceId, questionId }, retry);

  /** After a restart: each decision whose notice was cut off or failed goes to its worker now. */
  const deliverOwedQuestions = (workspaceId: WorkspaceId) =>
    Effect.gen(function* () {
      const owed = questionsOf(yield* readOutbox(workspaceId)).filter(
        (question) => question.deliveryOwed === true,
      );
      yield* owedNotices.resume(
        owed.map((question) => ({ workspaceId, questionId: question.id })),
        (final) => afterClose(workspaceId, final),
      );
    });

  /** After a question is closed and its delivery tried: its timer gone, the cards and ledger told. */
  const afterClose = (workspaceId: WorkspaceId, final: StoredWorkerQuestion) =>
    Effect.gen(function* () {
      yield* FiberMap.remove(questionTimers, questionTimerKey(workspaceId, final.id));
      yield* answeredInput(workspaceId, final);
      yield* showQuestionToWorker(final);
      yield* orchestrationChanged(workspaceId);
      return final;
    });

  const askQuestion: OrchestrationShape["askQuestion"] = (workerId, input) =>
    Effect.gen(function* () {
      const tool = "ask_question";
      const problem = askQuestionProblem(input);
      if (problem !== undefined) return yield* toolError(tool, problem);
      const worker = yield* findThread(workerId);
      const state = worker === undefined ? undefined : yield* listeningWorkspace(worker);
      if (worker === undefined || state === undefined) return undefined;
      const workspaceId = state.workspace.id;
      const now = yield* Clock.currentTimeMillis;
      const options = (input.options ?? []).map((option) => ({
        label: questionWords(option.label),
        ...(option.description === undefined || option.description.trim() === ""
          ? {}
          : { description: questionWords(option.description) }),
        // Confined to the worker's folders and made absolute by the tool.
        ...(option.image === undefined || option.image.trim() === ""
          ? {}
          : { image: option.image.trim() }),
        ...(option.preview === undefined || option.preview.trim() === ""
          ? {}
          : { preview: option.preview.trim() }),
      }));
      const mock = input.mock?.trim() ?? "";
      const context = input.context === undefined ? "" : questionWords(input.context);
      const recommended = input.recommended === undefined ? "" : questionWords(input.recommended);
      // Nobody triages in a paused workspace or feature: the question is the user's at once.
      const paused = state.paused !== undefined || pausedFeatureOf(state, worker) !== undefined;
      const asked = yield* updateOutbox(workspaceId, (outbox) =>
        addQuestion(outbox, {
          workspaceId,
          threadId: worker.id,
          feature: worker.spawnedBy?.feature ?? "",
          title: redactText(worker.title),
          question: questionWords(input.question),
          ...(context === "" ? {} : { context }),
          ...(options.length === 0 ? {} : { options }),
          ...(options.length > 0 && input.multiSelect === true
            ? { multiSelect: true as const }
            : {}),
          ...(recommended === "" ? {} : { recommended }),
          ...(mock === "" ? {} : { mock }),
          askedAt: now,
          triageUntil: now + WORKER_QUESTION_TRIAGE_MS,
          ...(paused
            ? { stage: "forwarded" as const, forwardedAt: now, forwardedBy: "paused" as const }
            : { stage: "triage" as const }),
        }),
      );
      const cardMessageId = yield* showQuestionToWorker(asked);
      const question =
        cardMessageId === undefined
          ? asked
          : yield* updateOutbox(workspaceId, (outbox) => {
              const current = findStoredQuestion(outbox, asked.id);
              if (current === undefined) return [outbox, asked];
              const next = { ...current, cardMessageId };
              return [replaceQuestion(outbox, next), next];
            });
      if (question.stage === "triage") yield* armQuestionTimer(workspaceId, question, now);
      // The worker stands on a question, as a `question` report says, and its orchestrator wakes.
      yield* recordReport(workerId, {
        state: "question",
        summary: clipped(`Asked ${question.id}: ${question.question}`, WORKER_REPORT_SUMMARY_MAX),
      });
      return publicQuestion(question);
    });

  const forwardQuestion: OrchestrationShape["forwardQuestion"] = (callerId, input) =>
    Effect.gen(function* () {
      const tool = "forward_question";
      const { state } = yield* requireAuthority(tool, callerId);
      const workspaceId = state.workspace.id;
      const problem = forwardContextProblem(input.context);
      if (problem !== undefined) return yield* toolError(tool, problem);
      const found = findStoredQuestion(yield* readOutbox(workspaceId), input.questionId);
      if (found !== undefined && !(yield* delegated(callerId, found.threadId))) {
        return yield* toolError(
          tool,
          refusal(
            "not_your_worker",
            `${found.id} was asked by a thread that isn't one of your workers, so it isn't yours to forward.`,
          ),
        );
      }
      const now = yield* Clock.currentTimeMillis;
      const context = input.context === undefined ? undefined : redactText(input.context.trim());
      const moved = yield* moveQuestion(workspaceId, input.questionId, (question) =>
        forwarded(question, "orchestrator", now, context),
      );
      if (isRefusal(moved)) return yield* toolError(tool, refusal(moved.code, moved.refused));
      yield* FiberMap.remove(questionTimers, questionTimerKey(workspaceId, moved.id));
      yield* showQuestionToWorker(moved);
      yield* showQuestionToOrchestrator(callerId, moved);
      yield* orchestrationChanged(workspaceId);
      return publicQuestion(moved);
    });

  const answerWorkerQuestion: OrchestrationShape["answerWorkerQuestion"] = (callerId, input) =>
    Effect.gen(function* () {
      const tool = "answer_worker";
      const { state } = yield* requireAuthority(tool, callerId);
      const workspaceId = state.workspace.id;
      if (state.paused !== undefined) {
        return yield* toolError(
          tool,
          refusal(
            "paused",
            `Orchestration is paused (${state.paused.reason}), so you answer nothing for the user. Only the user can resume it; end your turn.`,
          ),
        );
      }
      const source = input.source.trim();
      if (source === "") {
        return yield* toolError(
          tool,
          "Say what settles it in `source`: the brief, a standing decision or a memory entry. If nothing does, forward it with forward_question.",
        );
      }
      if (source.length > ANSWER_SOURCE_MAX) {
        return yield* toolError(tool, `Keep \`source\` to ${ANSWER_SOURCE_MAX} characters.`);
      }
      const found = findStoredQuestion(yield* readOutbox(workspaceId), input.questionId);
      const target = found === undefined ? undefined : yield* findThread(found.threadId);
      if (
        found !== undefined &&
        (target === undefined || !(yield* delegated(callerId, target.id)))
      ) {
        return yield* toolError(
          tool,
          refusal(
            "not_your_worker",
            `${found.id} was asked by a thread that isn't one of your workers, so it isn't yours to answer.`,
          ),
        );
      }
      if (target !== undefined) {
        const pausedFeature = pausedFeatureOf(state, target);
        if (pausedFeature !== undefined) {
          return yield* toolError(
            tool,
            refusal(
              "feature_paused",
              `The user paused feature ${pausedFeature}, so you answer nothing for its workers. Only the user can resume it; leave it until a digest says they did.`,
            ),
          );
        }
        if ((yield* readOutbox(workspaceId)).workers[target.id]?.userIntervened === true) {
          return yield* toolError(
            tool,
            refusal("user_intervened", userHoldReason("so is its question")),
          );
        }
      }
      const answer = clipped(redactText(input.answer.trim()), WORKER_QUESTION_ANSWER_MAX);
      const at = yield* Clock.currentTimeMillis;
      const closedFor = yield* decidedFor;
      let before: StoredWorkerQuestion | undefined;
      const claimed = yield* moveQuestion(workspaceId, input.questionId, (question) => {
        before = question;
        return withClosedFor(
          answeredByOrchestrator(question, answer, redactText(source), at),
          closedFor,
        );
      });
      if (isRefusal(claimed)) return yield* toolError(tool, refusal(claimed.code, claimed.refused));
      const delivered = yield* deliverToWorker(
        claimed,
        workerAnswerMessage(claimed, answer, {
          closedBy: "orchestrator",
          source: claimed.source ?? source,
        }),
      ).pipe(
        Effect.tapError(() =>
          before === undefined ? Effect.void : restoreQuestion(workspaceId, before, claimed),
        ),
        Effect.mapError((e) =>
          toolError(tool, `The answer didn't reach “${claimed.title}”: ${e.message}`),
        ),
      );
      const settled = yield* settleDelivery(workspaceId, claimed, delivered);
      yield* store.appendOrchestrationEvent(workspaceId, {
        at,
        kind: "answer",
        data: { threadId: claimed.threadId, questionId: claimed.id },
      });
      const final = yield* afterClose(workspaceId, settled);
      yield* showQuestionToOrchestrator(callerId, final);
      return publicQuestion(final);
    });

  /** The user's answer or dismissal, from any surface: to the worker now, the copy to the next digest. */
  const closeAsUser = (
    workspaceId: WorkspaceId,
    questionId: string,
    close: { readonly answer: string } | { readonly dismissed: true; readonly reason?: string },
    onlyIfOpen = false,
  ) =>
    Effect.gen(function* () {
      yield* store.getWorkspace(workspaceId);
      const closedFor = yield* decidedFor;
      const at = yield* Clock.currentTimeMillis;
      const scrubbed =
        "answer" in close
          ? { answer: clipped(redactText(close.answer.trim()), WORKER_QUESTION_ANSWER_MAX) }
          : {
              dismissed: true as const,
              ...(close.reason === undefined ? {} : { reason: redactText(close.reason) }),
            };
      let newlyClosed = false;
      const claimed = yield* moveQuestion(workspaceId, questionId, (question) => {
        // Retries and concurrent user replies preserve the first committed decision.
        // Unless the caller must know its answer is the one taken (`onlyIfOpen`).
        if (!onlyIfOpen && !isOpenQuestion(question) && question.closedBy === "user")
          return question;
        const moved = withClosedFor(closedByUser(question, scrubbed, at), closedFor);
        newlyClosed = !isRefusal(moved);
        return moved;
      });
      if (isRefusal(claimed)) {
        return yield* claimed.code === "unknown_question"
          ? new NotFound({ entity: "question", id: questionId, message: claimed.refused })
          : new InvalidState({ message: claimed.refused });
      }
      // A retry of a decision already written sends only what is still owed of its notice.
      if (!newlyClosed && claimed.deliveryOwed !== true) return publicQuestion(claimed);
      // Resolution is durable even if an archived, unavailable or missing worker cannot receive
      // a notice: it was written with the decision, and a failed send stays owed. Never reopen
      // a user's decision because notification failed; no worker is unarchived here.
      const final = yield* afterClose(
        workspaceId,
        (yield* deliverOwed(workspaceId, claimed.id, !newlyClosed)) ?? claimed,
      );
      yield* wake(
        workspaceId,
        final.stage === "dismissed"
          ? "the user dismissed a worker's question"
          : "the user answered a worker's question",
        true,
      );
      return publicQuestion(final);
    });

  const answerQuestionAsUser: OrchestrationShape["answerQuestionAsUser"] = (input, options) =>
    closeAsUser(
      input.workspaceId,
      input.questionId,
      { answer: input.answer },
      options?.onlyIfOpen === true,
    );

  const dismissQuestionAsUser: OrchestrationShape["dismissQuestionAsUser"] = (input) =>
    closeAsUser(input.workspaceId, input.questionId, {
      dismissed: true,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    });

  /**
   * `record_user_answer`: the user answered an open question in a message to the caller, the worker
   * that asked it or its orchestrator, rather than on its card. The caller only judges that the
   * message answers it; the answer is the user's latest message in the caller's thread, copied word
   * for word. The worker is told what its orchestrator recorded; the orchestrator gets a copy of
   * what its worker recorded.
   */
  const recordUserAnswer: OrchestrationShape["recordUserAnswer"] = (callerId, input) =>
    Effect.gen(function* () {
      const tool = "record_user_answer";
      const authority = yield* authorityOf(callerId);
      const asWorker = authority === undefined;
      const workspaceId = asWorker
        ? (yield* findThread(callerId))?.workspaceId
        : authority.state.workspace.id;
      const found =
        workspaceId === undefined
          ? undefined
          : findStoredQuestion(yield* readOutbox(workspaceId), input.questionId);
      if (workspaceId === undefined || found === undefined) {
        return yield* toolError(
          tool,
          refusal("unknown_question", `There is no question ${input.questionId} on record.`),
        );
      }
      if (asWorker ? found.threadId !== callerId : !(yield* delegated(callerId, found.threadId))) {
        return yield* toolError(
          tool,
          asWorker
            ? refusal("not_yours", `${found.id} isn't your question; record only your own.`)
            : refusal(
                "not_your_worker",
                `${found.id} was asked by a thread that isn't one of your workers, so it isn't yours to record.`,
              ),
        );
      }
      const [message] = yield* findUserMessages(store, callerId, {
        from: "newest",
        count: 1,
        keep: (each) => userMessagesOf([each]).length > 0,
      });
      const words = message === undefined ? undefined : userMessagesOf([message])[0];
      const latest =
        words === undefined
          ? undefined
          : { text: words.text, sentAt: message?.metadata?.createdAt };
      const problem = userAnswerProblem(found.id, latest, found.askedAt);
      if (problem !== undefined || latest === undefined) {
        return yield* toolError(tool, problem ?? "There is no message of the user's to record.");
      }
      const answer = redactText(latest.text.trim());
      const by = asWorker ? ("worker" as const) : ("orchestrator" as const);
      const at = yield* Clock.currentTimeMillis;
      const moved = yield* moveQuestion(workspaceId, found.id, (question) =>
        answeredFromMessage(question, answer, by, at),
      );
      if (isRefusal(moved)) return yield* toolError(tool, refusal(moved.code, moved.refused));
      yield* store.appendOrchestrationEvent(workspaceId, {
        at,
        kind: "answer",
        data: { threadId: moved.threadId, questionId: moved.id },
      });
      const final = yield* afterClose(
        workspaceId,
        moved.deliveryOwed === true
          ? ((yield* deliverOwed(workspaceId, moved.id, false)) ?? moved)
          : moved,
      );
      if (asWorker) {
        yield* wake(workspaceId, "a worker recorded the user's answer to its question", true);
      } else {
        yield* showQuestionToOrchestrator(callerId, final);
      }
      return publicQuestion(final);
    });

  /**
   * A worker's thread left (archived, deleted, detached or moved): its open questions are withdrawn
   * in its name, since nobody would act on an answer, and leave the user's board. Nobody is woken.
   */
  const withdrawQuestionsOf: OrchestrationShape["withdrawQuestionsOf"] = (
    workspaceId,
    threadId,
    why,
  ) =>
    Effect.gen(function* () {
      const open = questionsOf(yield* readOutbox(workspaceId)).filter(
        (question) => question.threadId === threadId && isOpenQuestion(question),
      );
      if (open.length === 0) return;
      const at = yield* Clock.currentTimeMillis;
      for (const question of open) {
        const moved = yield* moveQuestion(workspaceId, question.id, (current) =>
          withdrawn(
            current,
            { by: "worker", how: "withdrawn", threadLeft: why },
            LEFT_REASON[why],
            at,
          ),
        );
        if (!isRefusal(moved)) yield* afterClose(workspaceId, moved);
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("a departed worker's questions weren't withdrawn").pipe(
          Effect.annotateLogs({ workspaceId, threadId, cause: String(cause) }),
        ),
      ),
    );

  /**
   * `ask_question` with `withdraw`: the worker closes its own open question, in triage or with the
   * user, because it no longer needs an answer or a newer one of its own (`supersededBy`) replaces
   * it. Off the user's board at once; nobody is sent a notice.
   */
  const withdrawQuestion: OrchestrationShape["withdrawQuestion"] = (workerId, input) =>
    Effect.gen(function* () {
      const tool = "ask_question";
      const reason = yield* withdrawReason(tool, input.reason);
      // Its own questions stay its own to withdraw, with its orchestrator listening or not.
      const workspaceId = (yield* findThread(workerId))?.workspaceId;
      if (workspaceId === undefined) {
        return yield* toolError(tool, `You have no question ${input.questionId} to withdraw.`);
      }
      const at = yield* Clock.currentTimeMillis;
      const moved = yield* moveQuestion(workspaceId, input.questionId, (question) =>
        question.threadId !== workerId
          ? {
              code: "not_yours",
              refused: `${question.id} isn't your question; you can withdraw only your own.`,
            }
          : withdrawn(
              question,
              {
                by: "worker",
                how: input.supersededBy === undefined ? "withdrawn" : "superseded",
                ...(input.supersededBy === undefined ? {} : { supersededBy: input.supersededBy }),
              },
              reason,
              at,
            ),
      );
      if (isRefusal(moved)) return yield* toolError(tool, refusal(moved.code, moved.refused));
      return publicQuestion(yield* afterClose(workspaceId, moved));
    });

  /**
   * `close_question` on a `WQ` id: the orchestrator closes one of its workers' open questions, in
   * triage or forwarded, without answering it. Off the user's board at once; the worker is told.
   */
  const closeWorkerQuestion: OrchestrationShape["closeWorkerQuestion"] = (callerId, input) =>
    Effect.gen(function* () {
      const tool = "close_question";
      const { state } = yield* requireAuthority(tool, callerId);
      const workspaceId = state.workspace.id;
      if (state.paused !== undefined) {
        return yield* toolError(
          tool,
          refusal(
            "paused",
            `Orchestration is paused (${state.paused.reason}), so its questions are the user's. Only the user can resume it; end your turn.`,
          ),
        );
      }
      const reason = yield* withdrawReason(tool, input.reason);
      const found = findStoredQuestion(yield* readOutbox(workspaceId), input.questionId);
      const target = found === undefined ? undefined : yield* findThread(found.threadId);
      if (
        found !== undefined &&
        (target === undefined || !(yield* delegated(callerId, target.id)))
      ) {
        return yield* toolError(
          tool,
          refusal(
            "not_your_worker",
            `${found.id} was asked by a thread that isn't one of your workers, so it isn't yours to close.`,
          ),
        );
      }
      if (target !== undefined) {
        const pausedFeature = pausedFeatureOf(state, target);
        if (pausedFeature !== undefined) {
          return yield* toolError(
            tool,
            refusal(
              "feature_paused",
              `The user paused feature ${pausedFeature}, so its workers' questions are theirs. Leave it until a digest says they resumed it.`,
            ),
          );
        }
        if ((yield* readOutbox(workspaceId)).workers[target.id]?.userIntervened === true) {
          return yield* toolError(
            tool,
            refusal("user_intervened", userHoldReason("so is its question")),
          );
        }
      }
      const at = yield* Clock.currentTimeMillis;
      const claimed = yield* moveQuestion(workspaceId, input.questionId, (question) =>
        withdrawn(question, { by: "orchestrator", how: input.how }, reason, at),
      );
      if (isRefusal(claimed)) return yield* toolError(tool, refusal(claimed.code, claimed.refused));
      // Written with the decision, the notice is owed until the worker has it, as a user's is.
      const final = yield* afterClose(
        workspaceId,
        (yield* deliverOwed(workspaceId, claimed.id, false)) ?? claimed,
      );
      yield* showQuestionToOrchestrator(callerId, final);
      return publicQuestion(final);
    });

  const userAnswers: OrchestrationShape["userAnswers"] = (callerId, tool, questionIds) =>
    Effect.gen(function* () {
      const { state } = yield* requireAuthority(tool, callerId);
      const outbox = yield* readOutbox(state.workspace.id);
      const ids = [...new Set(questionIds.map((id) => id.trim()))];
      if (ids.length === 0 || ids.length > USER_ANSWERS_MAX || ids.includes("")) {
        return yield* toolError(
          tool,
          `\`userAnswers\` names 1 to ${USER_ANSWERS_MAX} worker questions by id, such as WQ7. Nothing was sent.`,
        );
      }
      const answers: Array<WorkerQuestion> = [];
      for (const id of ids) {
        const found = findStoredQuestion(outbox, id);
        if (found === undefined) {
          return yield* toolError(
            tool,
            `There is no question ${id} on record in this workspace, so nothing of the user's was attached and nothing was sent. Closed questions are kept ${WORKER_QUESTIONS_KEPT_CLOSED} deep.`,
          );
        }
        const words = found.stage === "answered" ? found.answer : found.reason;
        if (found.closedBy !== "user" || words === undefined || words.trim() === "") {
          return yield* toolError(
            tool,
            found.withdrawal !== undefined
              ? `${found.id} was closed as ${found.withdrawal.how} by ${found.withdrawal.by === "worker" ? "its worker" : "an orchestrator"}, not the user, so there are no words of the user's to attach. Nothing was sent.`
              : found.closedBy === "orchestrator"
                ? `${found.id} was answered by an orchestrator, not the user, so there are no words of the user's to attach. Nothing was sent.`
                : found.closedBy === "user"
                  ? `The user dismissed ${found.id} without a reason, so there are no words of theirs to attach. Nothing was sent.`
                  : `${found.id} is still open, so the user hasn't answered it. Nothing was sent.`,
          );
        }
        answers.push(publicQuestion(found));
      }
      return answers;
    });

  /** A question's triage time is up: to the user, with no context line. */
  const onQuestionDue = (workspaceId: WorkspaceId, questionId: string) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const current = findStoredQuestion(yield* readOutbox(workspaceId), questionId);
      if (current === undefined || current.stage !== "triage") return;
      if (current.triageUntil > now) return yield* armQuestionTimer(workspaceId, current, now);
      const moved = yield* moveQuestion(workspaceId, questionId, (question) =>
        forwarded(question, "timeout", now),
      );
      if (isRefusal(moved)) return;
      yield* showQuestionToWorker(moved);
      yield* orchestrationChanged(workspaceId);
    });

  return {
    answerWorker,
    armQuestionTimers,
    deliverOwedQuestions,
    askQuestion,
    forwardQuestion,
    answerWorkerQuestion,
    withdrawQuestion,
    closeWorkerQuestion,
    recordUserAnswer,
    withdrawQuestionsOf,
    answerQuestionAsUser,
    dismissQuestionAsUser,
    userAnswers,
    onQuestionDue,
  };
};

/** What `makeWorkerQuestions` makes, for the parts whose `deps` take some of it. */
export type WorkerQuestions = ReturnType<typeof makeWorkerQuestions>;
