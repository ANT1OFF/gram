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

import { InvalidState, RequestAnswer, RequestId, ThreadId } from "@gram/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Actor } from "../http/fronted-identity.ts";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";
import { HttpServerRequest, HttpServerResponse } from "../platform/unstable.ts";
import { actorEventsOf } from "../rpc/actor-guard.ts";
import type { ThreadRuntimesShape } from "../runtime/thread-runtimes-shape.ts";
import { ActingPerson } from "./person.ts";
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
   * Whether this call's person may answer in the thread: its owners' to answer, where it is on
   * or under a machine started for one person (`host/ownership.ts`). Absent: anyone may.
   */
  readonly mayAnswer?: (threadId: ThreadId) => Effect.Effect<boolean>;
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
    // Before the request is taken, or any hook or session asked: the statement says who
    // answered, never that they may answer here.
    const allowed = deps.mayAnswer === undefined ? true : yield* asActor(deps.mayAnswer(threadId));
    const failed = !allowed
      ? ("forbidden" as const)
      : yield* asActor(deps.runtimes.respond(threadId, requestId, answer)).pipe(
          Effect.provideService(AnswerProofRef, proof),
          Effect.as(undefined),
          Effect.catch((error) => Effect.succeed(error)),
          Effect.catchCause((cause) =>
            Effect.logError("an answer over HTTP failed", cause).pipe(Effect.as("defect" as const)),
          ),
        );
    // On record as the socket's `thread.respond` would be, failed or not.
    yield* deps.store
      .appendActorEvents(
        actorEventsOf(actor, "thread.respond", parsed.value, Date.now()).map((entry) =>
          failed === undefined ? entry : { ...entry, data: { ...entry.data, failed: true } },
        ),
      )
      .pipe(Effect.catchCause((cause) => Effect.logError("an answer went unrecorded", cause)));
    if (failed === undefined) return json(200, {});
    if (failed === "forbidden") return refusal(403, "Forbidden", NOT_YOUR_MACHINE);
    if (failed === "defect") return refusal(500, "Failed", "the answer could not be taken");
    if (failed instanceof InvalidState) return refusal(409, failed._tag, failed.message);
    return refusal(404, failed._tag, failed.message);
  });
