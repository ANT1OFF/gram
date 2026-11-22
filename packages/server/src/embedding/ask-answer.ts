import { NOT_READABLE, readableByOf, readerMay } from "./readable-by.ts";
import {
  type AnswerQuestionResult,
  type AnswerWorkerQuestionInput,
  type MemoryQuestion,
  InvalidState,
  RequestAnswer,
  RequestId,
  ThreadId,
  type WorkerQuestion,
  type WorkspaceId,
} from "@gram/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Actor } from "../http/fronted-identity.ts";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";
import { keylessRefusal } from "../runtime/card-key.ts";
import { HttpServerRequest, HttpServerResponse } from "../platform/unstable.ts";
import { actorEventsOf } from "../rpc/actor-guard.ts";
import type { ThreadRuntimesShape } from "../runtime/thread-runtimes-shape.ts";
import type { AnswerNote } from "./event-sink.ts";
import { ActingPerson } from "./person.ts";
import { makeKeyedLock } from "../git/keyed-lock.ts";
import {
  isUsersQuestion,
  parseWorkerQuestionAskId,
  workerQuestionAnswerText,
  workerQuestionAskId,
} from "./worker-question-asks.ts";
import { NOT_YOUR_MACHINE, RoutedFor } from "../host/ownership.ts";
import {
  orchestratorQuestionAnswerText,
  orchestratorQuestionAskId,
  parseOrchestratorQuestionAskId,
} from "./orchestrator-question-asks.ts";
import {
  ANSWER_OVER_HTTP,
  ASK_ANSWER_MAX_BYTES,
  ASK_ANSWER_PATH,
  type AnswerProof,
  AnswerProofRef,
} from "./answer-proof.ts";

export { ANSWER_OVER_HTTP, ASK_ANSWER_PATH, type AnswerProof, AnswerProofRef };

const AnswerBody = Schema.Struct({
  threadId: ThreadId,
  requestId: RequestId,
  answer: RequestAnswer,
  shown: Schema.optionalKey(Schema.String),
});
const decodeBody = Schema.decodeUnknownOption(Schema.fromJsonString(AnswerBody));

const json = (status: number, body: unknown) => HttpServerResponse.jsonUnsafe(body, { status });
const refusal = (status: number, tag: string, message: string) =>
  json(status, { _tag: tag, message });

export interface AskAnswerDeps {
  readonly runtimes: Pick<ThreadRuntimesShape, "respond">;
  readonly store: Pick<ThreadStoreShape, "appendActorEvents" | "listRequests">;
  /**
   * For a worker question's ask (`worker-question-asks.ts`): reads it, and answers it as the
   * user. Absent, such an ask is refused.
   */
  readonly workerQuestions?: {
    readonly find: (
      workspaceId: WorkspaceId,
      questionId: string,
    ) => Effect.Effect<WorkerQuestion | undefined>;
    readonly answer: (
      input: AnswerWorkerQuestionInput,
      options: { readonly onlyIfOpen: true },
    ) => Effect.Effect<WorkerQuestion, { readonly _tag: string; readonly message: string }>;
    /**
     * Whether this fiber's person may reach the asking thread and the workspace's orchestrator,
     * which `workerQuestion.answer` is held to over a socket (`rpc/actor-guard.ts`).
     */
    readonly mayReach: (workspaceId: WorkspaceId, threadId: ThreadId) => Effect.Effect<boolean>;
  };
  /**
   * For an orchestrator question's ask (`orchestrator-question-asks.ts`): reads the entry and the
   * orchestrator's thread, and answers it as the user, as the socket's `question.answer` does.
   * Absent, such an ask is refused.
   */
  readonly orchestratorQuestions?: {
    readonly find: (
      workspaceId: WorkspaceId,
      questionId: string,
    ) => Effect.Effect<
      { readonly question: MemoryQuestion; readonly threadId: ThreadId } | undefined
    >;
    /**
     * Answers it as `question.answer` does, but only as this answer (`own`): one closed or with an
     * answer on its way is refused. `beforeSend` runs once this answer is the one that goes.
     */
    readonly answer: (
      input: {
        readonly workspaceId: WorkspaceId;
        readonly questionId: string;
        readonly question: string;
        readonly answer: string;
      },
      options: { readonly own: true; readonly beforeSend: Effect.Effect<void> },
    ) => Effect.Effect<AnswerQuestionResult, { readonly _tag: string; readonly message: string }>;
    /** Whether this fiber's person may reach the orchestrator's thread. */
    readonly mayReach: (workspaceId: WorkspaceId, threadId: ThreadId) => Effect.Effect<boolean>;
  };
  /** Keeps who answered, and the proof, for the ask's `ask.resolved`. */
  readonly noteAnswer?: (askId: string, note: AnswerNote | undefined) => Effect.Effect<void>;
}

/**
 * Answers `POST /asks/answer` for `actor`, a person the proxy signed in. A viewer is refused; a
 * member's answer goes as `thread.respond` would take it, on record as theirs, carrying the
 * request's statement and body.
 */
export const answerAsk = (
  deps: AskAnswerDeps,
  request: HttpServerRequest.HttpServerRequest,
  actor: Actor,
  statement: string,
) =>
  Effect.gen(function* () {
    if (request.method !== "POST") return refusal(405, "MethodNotAllowed", "method not allowed");
    if (actor.role !== "member")
      return refusal(403, "Forbidden", "read-only: a viewer can't change anything here");
    const length = request.headers["content-length"];
    if (length !== undefined && Number(length) > ASK_ANSWER_MAX_BYTES)
      return refusal(413, "TooLarge", "the answer is too large");
    const bytes = yield* request.arrayBuffer.pipe(
      Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.bytes(ASK_ANSWER_MAX_BYTES)),
      Effect.catch(() => Effect.succeed(undefined)),
    );
    if (bytes === undefined) return refusal(400, "BadRequest", "the answer could not be read");
    let body: string;
    try {
      body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return refusal(400, "BadRequest", "the answer is not UTF-8");
    }
    const parsed = decodeBody(body);
    if (parsed._tag === "None")
      return refusal(400, "BadRequest", "expected {threadId, requestId, answer}");
    const { threadId, requestId, answer, shown } = parsed.value;
    if (!readerMay({ subject: actor.id }, readableByOf(threadId as ThreadId)))
      return refusal(404, "NotFound", NOT_READABLE);
    const proof: AnswerProof = { statement, method: request.method, path: request.url, body };
    const asActor = <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(
        Effect.provideService(ActingPerson, actor.id),
        Effect.provideService(RoutedFor, { person: actor.id }),
      );
    const record = (failed: unknown) =>
      deps.store
        .appendActorEvents(
          actorEventsOf(actor, "thread.respond", parsed.value, Date.now()).map((entry) =>
            failed === undefined ? entry : { ...entry, data: { ...entry.data, failed: true } },
          ),
        )
        .pipe(Effect.catchCause((cause) => Effect.logError("an answer went unrecorded", cause)));
    const entry = parseOrchestratorQuestionAskId(requestId);
    if (entry !== undefined) {
      const failed = yield* answerOrchestratorQuestion(
        deps,
        entry,
        threadId,
        answer,
        actor.id,
        proof,
      );
      yield* record(failed);
      return failed === undefined
        ? json(200, {})
        : refusal(failed.status, failed.tag, failed.message);
    }
    const asked = parseWorkerQuestionAskId(requestId);
    if (asked !== undefined) {
      const failed = yield* answerWorkerQuestion(deps, asked, threadId, answer, actor.id, proof);
      yield* record(failed);
      return failed === undefined
        ? json(200, {})
        : refusal(failed.status, failed.tag, failed.message);
    }
    const keylessForKeyedCard = yield* keylessRefusal(deps.store, threadId, requestId, shown);
    if (keylessForKeyedCard !== undefined) {
      yield* record(keylessForKeyedCard);
      return refusal(409, "InvalidState", keylessForKeyedCard);
    }
    const failed = yield* asActor(deps.runtimes.respond(threadId, requestId, answer, shown)).pipe(
      Effect.provideService(AnswerProofRef, proof),
      Effect.as(undefined),
      Effect.catch((error) => Effect.succeed(error)),
      Effect.catchCause((cause) =>
        Effect.logError("an answer over HTTP failed", cause).pipe(Effect.as("defect" as const)),
      ),
    );
    yield* record(failed);
    if (failed === undefined) return json(200, {});
    if (failed === "defect") return refusal(500, "Failed", "the answer could not be taken");
    if (failed instanceof InvalidState)
      return refusal(failed.message === NOT_YOUR_MACHINE ? 403 : 409, failed._tag, failed.message);
    return refusal(404, failed._tag, failed.message);
  });

const answering = makeKeyedLock<string>();

/**
 * A person's answer to a worker question's ask: its words, from the question answer the receiver
 * sends, become the user's answer, as Gram's own card would give it, on record as theirs with the
 * request's proof. The ask must name the thread that asked it; `undefined` when it was taken.
 */
export const answerWorkerQuestion = (
  deps: AskAnswerDeps,
  asked: { readonly workspaceId: WorkspaceId; readonly questionId: string },
  threadId: ThreadId,
  answer: RequestAnswer,
  person: string,
  proof: AnswerProof,
) =>
  answering.withLock(
    workerQuestionAskId(asked.workspaceId, asked.questionId),
    Effect.gen(function* () {
      const questions = deps.workerQuestions;
      if (questions === undefined) {
        return { status: 404, tag: "NotFound", message: "no such question" } as const;
      }
      const question = yield* questions.find(asked.workspaceId, asked.questionId);
      if (question === undefined || question.threadId !== threadId) {
        return { status: 404, tag: "NotFound", message: "no such question" } as const;
      }
      if (answer.kind !== "question") {
        return {
          status: 400,
          tag: "BadRequest",
          message: "a question takes a question's answer",
        } as const;
      }
      const text = workerQuestionAnswerText(question, answer);
      if (text === undefined) {
        return { status: 400, tag: "BadRequest", message: "the answer says nothing" } as const;
      }
      const reachable = yield* questions
        .mayReach(asked.workspaceId, threadId)
        .pipe(Effect.provideService(RoutedFor, { person }));
      if (!reachable)
        return { status: 403, tag: "InvalidState", message: NOT_YOUR_MACHINE } as const;
      if (!isUsersQuestion(question)) {
        return {
          status: 409,
          tag: "InvalidState",
          message: `${question.id} no longer waits on an answer`,
        } as const;
      }
      const askId = workerQuestionAskId(asked.workspaceId, asked.questionId);
      const note = deps.noteAnswer ?? (() => Effect.void);
      yield* note(askId, { answeredBy: person, proof });
      const failed = yield* questions
        .answer(
          { workspaceId: asked.workspaceId, questionId: asked.questionId, answer: text },
          { onlyIfOpen: true },
        )
        .pipe(
          Effect.provideService(ActingPerson, person),
          Effect.provideService(RoutedFor, { person }),
          Effect.as(undefined),
          Effect.catch((error) => Effect.succeed(error)),
          Effect.catchCause((cause) =>
            Effect.logError("an answer to a worker question failed", cause).pipe(
              Effect.as({ _tag: "Failed", message: "the answer could not be taken" }),
            ),
          ),
        );
      if (failed === undefined) return undefined;
      yield* note(askId, undefined);
      return failed._tag === "NotFound"
        ? ({ status: 404, tag: failed._tag, message: failed.message } as const)
        : failed._tag === "Failed"
          ? ({ status: 500, tag: failed._tag, message: failed.message } as const)
          : ({ status: 409, tag: failed._tag, message: failed.message } as const);
    }),
  );

/**
 * A person's answer to an orchestrator question's ask: its words become the user's answer, as the
 * Answer button gives it, on record as theirs with the request's proof. The ask must name the
 * orchestrator's thread; `undefined` when it was taken.
 */
export const answerOrchestratorQuestion = (
  deps: AskAnswerDeps,
  asked: { readonly workspaceId: WorkspaceId; readonly questionId: string },
  threadId: ThreadId,
  answer: RequestAnswer,
  person: string,
  proof: AnswerProof,
) =>
  answering.withLock(
    orchestratorQuestionAskId(asked.workspaceId, asked.questionId),
    Effect.gen(function* () {
      const questions = deps.orchestratorQuestions;
      if (questions === undefined) {
        return { status: 404, tag: "NotFound", message: "no such question" } as const;
      }
      const found = yield* questions.find(asked.workspaceId, asked.questionId);
      if (found === undefined || found.threadId !== threadId) {
        return { status: 404, tag: "NotFound", message: "no such question" } as const;
      }
      if (answer.kind !== "question") {
        return {
          status: 400,
          tag: "BadRequest",
          message: "a question takes a question's answer",
        } as const;
      }
      const text = orchestratorQuestionAnswerText(found.question, answer);
      if (text === undefined) {
        return { status: 400, tag: "BadRequest", message: "the answer says nothing" } as const;
      }
      const reachable = yield* questions
        .mayReach(asked.workspaceId, threadId)
        .pipe(Effect.provideService(RoutedFor, { person }));
      if (!reachable)
        return { status: 403, tag: "InvalidState", message: NOT_YOUR_MACHINE } as const;
      if (!found.question.open) {
        return {
          status: 409,
          tag: "InvalidState",
          message: `${asked.questionId} no longer waits on an answer`,
        } as const;
      }
      const askId = orchestratorQuestionAskId(asked.workspaceId, asked.questionId);
      const note = deps.noteAnswer ?? (() => Effect.void);
      const failed = yield* questions
        .answer(
          {
            workspaceId: asked.workspaceId,
            questionId: asked.questionId,
            question: found.question.text,
            answer: text,
          },
          { own: true, beforeSend: note(askId, { answeredBy: person, proof }) },
        )
        .pipe(
          Effect.provideService(ActingPerson, person),
          Effect.provideService(RoutedFor, { person }),
          Effect.as(undefined),
          Effect.catch((error) => Effect.succeed(error)),
          Effect.catchCause((cause) =>
            Effect.logError("an answer to an orchestrator question failed", cause).pipe(
              Effect.as({ _tag: "Failed", message: "the answer could not be taken" }),
            ),
          ),
        );
      if (failed === undefined) return undefined;
      yield* note(askId, undefined);
      return failed._tag === "NotFound"
        ? ({ status: 404, tag: failed._tag, message: failed.message } as const)
        : failed._tag === "Failed"
          ? ({ status: 500, tag: failed._tag, message: failed.message } as const)
          : ({ status: 409, tag: failed._tag, message: failed.message } as const);
    }),
  );
