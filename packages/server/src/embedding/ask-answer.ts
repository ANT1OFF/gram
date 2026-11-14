// Answering a card over plain HTTP, for a server whose people sign in through a fronting proxy.
//
// The proxy signs a statement of who sends each request it passes on (`http/fronted-identity.ts`),
// and can bind it to that one request (its method, path and a hash of its body). A WebSocket's
// statement is read only when the socket opens, so it can't say who sent one message on it. So
// while fronted sign-in is on, an answer to a card comes as its own request, and what the
// proxy signed for it is kept, exactly as received, with the answer: the event sink's
// `ask.resolved` carries it as `proof`, for a receiver to check who answered without taking this
// server's word for it. The server checks the statement as it checks every request, and nothing
// more: the extra claims are the receiver's to read.

import {
  type AnswerWorkerQuestionInput,
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
import { HttpServerRequest, HttpServerResponse } from "../platform/unstable.ts";
import { actorEventsOf } from "../rpc/actor-guard.ts";
import type { ThreadRuntimesShape } from "../runtime/thread-runtimes-shape.ts";
import type { AnswerNote } from "./event-sink.ts";
import { ActingPerson } from "./person.ts";
import {
  parseWorkerQuestionAskId,
  workerQuestionAnswerText,
  workerQuestionAskId,
} from "./worker-question-asks.ts";
import { NOT_YOUR_MACHINE, RoutedFor } from "../host/ownership.ts";
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
});
const decodeBody = Schema.decodeUnknownOption(Schema.fromJsonString(AnswerBody));

const json = (status: number, body: unknown) => HttpServerResponse.jsonUnsafe(body, { status });
const refusal = (status: number, tag: string, message: string) =>
  json(status, { _tag: tag, message });

export interface AskAnswerDeps {
  readonly runtimes: Pick<ThreadRuntimesShape, "respond">;
  readonly store: Pick<ThreadStoreShape, "appendActorEvents">;
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
    ) => Effect.Effect<WorkerQuestion, { readonly _tag: string; readonly message: string }>;
    /**
     * Whether this fiber's person may reach the asking thread and the workspace's orchestrator,
     * which `workerQuestion.answer` is held to over a socket (`rpc/actor-guard.ts`).
     */
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
    // Kept exactly as sent, as the proxy hashed it: no BOM dropped, and no bytes that aren't
    // UTF-8 replaced (those are refused, since the proof could never match them).
    let body: string;
    try {
      body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return refusal(400, "BadRequest", "the answer is not UTF-8");
    }
    const parsed = decodeBody(body);
    if (parsed._tag === "None")
      return refusal(400, "BadRequest", "expected {threadId, requestId, answer}");
    const { threadId, requestId, answer } = parsed.value;
    const proof: AnswerProof = { statement, method: request.method, path: request.url, body };
    const asActor = <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(
        Effect.provideService(ActingPerson, actor.id),
        Effect.provideService(RoutedFor, { person: actor.id }),
      );
    /** On record as the socket's `thread.respond` would be, failed or not. */
    const record = (failed: unknown) =>
      deps.store
        .appendActorEvents(
          actorEventsOf(actor, "thread.respond", parsed.value, Date.now()).map((entry) =>
            failed === undefined ? entry : { ...entry, data: { ...entry.data, failed: true } },
          ),
        )
        .pipe(Effect.catchCause((cause) => Effect.logError("an answer went unrecorded", cause)));
    const asked = parseWorkerQuestionAskId(requestId);
    if (asked !== undefined) {
      const failed = yield* answerWorkerQuestion(deps, asked, threadId, answer, actor.id, proof);
      yield* record(failed);
      return failed === undefined
        ? json(200, {})
        : refusal(failed.status, failed.tag, failed.message);
    }
    // As the signed person: the runtimes refuse it, before the request is taken, on a machine
    // they may not reach (`runtime/owned-runtimes.ts`). The statement says who answered, never
    // that they may answer here.
    const failed = yield* asActor(deps.runtimes.respond(threadId, requestId, answer)).pipe(
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
    if (!reachable) return { status: 403, tag: "InvalidState", message: NOT_YOUR_MACHINE } as const;
    const askId = workerQuestionAskId(asked.workspaceId, asked.questionId);
    const note = deps.noteAnswer ?? (() => Effect.void);
    yield* note(askId, { answeredBy: person, proof });
    const failed = yield* questions
      .answer({ workspaceId: asked.workspaceId, questionId: asked.questionId, answer: text })
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
  });
