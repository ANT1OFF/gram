// Approval cards the server raises and answers itself (`requestApproval`), rather than an agent session.

import * as Cause from "effect/Cause";
import {
  type ThreadId,
  RequestId,
  type ApprovalAnswer,
  type AppToolApprovalResolution,
  type PermissionMode,
  type ApprovalRequest,
  type RequestAnswer,
  RequestNotFound,
  InvalidState,
  type RespondManyResult,
} from "@gram/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Exit from "effect/Exit";
import { type Runtime, locked, type GetRuntime } from "./runtime-state.ts";
import type { ThreadRuntimesShape } from "./thread-runtimes-shape.ts";
import { randomUUID } from "node:crypto";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";
import type { EventHubShape } from "../events/event-hub.ts";
import type { TurnLifecycle } from "./turn-lifecycle.ts";
import type { MessageQueue } from "./message-queue.ts";

/** Why one answer of `respondMany` wasn't given, in words a row of the inbox can show. */
export const respondFailure = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);
  const tag =
    typeof error === "object" && error !== null && "_tag" in error ? error._tag : undefined;
  if (tag === "RequestNotFound") return "That request has already been answered.";
  if (tag === "ThreadNotFound") return "That thread is closed.";
  return error instanceof Error && error.message !== "" ? error.message : "The answer failed.";
};

/** Internal result provenance; client RequestAnswer schemas have no resolution field. */
export type ServerApprovalAnswer = ApprovalAnswer & {
  readonly resolution?: AppToolApprovalResolution;
};

export interface ServerApprovalRequest {
  readonly threadId: ThreadId;
  readonly toolName: string;
  /** Best-effort snapshot at request creation; resolution must not depend on database access. */
  readonly permissionMode?: PermissionMode;
  readonly answer: Deferred.Deferred<ServerApprovalAnswer>;
}

export const approvalResolution = (
  threadId: ThreadId,
  requestId: RequestId,
  toolName: string,
  origin: AppToolApprovalResolution["origin"],
  reason: string,
  permissionMode?: PermissionMode,
) =>
  Effect.gen(function* () {
    const resolution = {
      threadId,
      requestId,
      origin,
      reason,
      resolvedAt: yield* Clock.currentTimeMillis,
      ...(permissionMode === undefined ? {} : { permissionMode }),
    };
    yield* Effect.logInfo("app tool approval resolved").pipe(
      Effect.annotateLogs({ ...resolution, toolName }),
      // Logger defects are diagnostic failures, never a reason to strand a decision. The
      // essential receipt has no database dependency and is still delivered to the waiter.
      Effect.catchCause(() =>
        Effect.sync(() => {
          if (origin === "runtime" && !resolution.reason.endsWith("-cleanup-failed")) {
            resolution.reason += "-cleanup-failed";
          }
        }),
      ),
    );
    return resolution;
  });

/** What the server's own cards, and the answers to any card, read and change beside a `Runtime`. */
export interface ServerApprovalsDeps {
  readonly store: ThreadStoreShape;
  readonly hub: EventHubShape;
  readonly getRuntime: GetRuntime;
  readonly serverRequests: Map<RequestId, ServerApprovalRequest>;
  readonly serverApprovalOrigins: Map<RequestId, ThreadId>;
  readonly setStatus: TurnLifecycle["setStatus"];
  readonly pumpDeliveries: MessageQueue["pumpDeliveries"];
  readonly drainQueue: MessageQueue["drainQueue"];
  readonly withSession: MessageQueue["withSession"];
  readonly becomeIdle: (rt: Runtime) => Effect.Effect<void>;
}

/**
 * Cards the server raises and answers itself, and `respond`, which takes an answer to the server's
 * card or the agent session's.
 */
export const makeServerApprovals = ({
  store,
  hub,
  getRuntime,
  serverRequests,
  serverApprovalOrigins,
  setStatus,
  pumpDeliveries,
  drainQueue,
  withSession,
  becomeIdle,
}: ServerApprovalsDeps) => {
  const clearPendingRequests = (rt: Runtime, reason: string) =>
    Effect.gen(function* () {
      const cancelled: Array<[RequestId, ServerApprovalRequest]> = [];
      for (const [requestId, request] of serverRequests) {
        if (request.threadId !== rt.threadId) continue;
        serverRequests.delete(requestId);
        cancelled.push([requestId, request]);
      }
      yield* Effect.gen(function* () {
        const pending = yield* store.listRequests(rt.threadId);
        yield* store.clearRequests(rt.threadId);
        for (const [id, threadId] of serverApprovalOrigins) {
          if (threadId === rt.threadId) serverApprovalOrigins.delete(id);
        }
        yield* Effect.forEach(
          pending,
          (request) =>
            hub.publish({
              type: "thread.requestResolved",
              threadId: rt.threadId,
              requestId: request.id,
            }),
          { discard: true },
        );
      }).pipe(
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            // Withdraw cards before waking calls. A cleanup failure must still fail closed and
            // release every waiter; it cannot turn a runtime withdrawal into a user rejection.
            for (const [requestId, request] of cancelled) {
              const resolution = yield* approvalResolution(
                rt.threadId,
                requestId,
                request.toolName,
                "runtime",
                Exit.isFailure(exit) ? `${reason}-cleanup-failed` : reason,
                request.permissionMode,
              );
              yield* Deferred.succeed(request.answer, {
                kind: "approval",
                decision: "deny",
                scope: "once",
                resolution,
              });
            }
          }),
        ),
      );
    });

  /** Called with the runtime lock held, after a request was removed. */
  const restoreStatusAfterRequest = (rt: Runtime) =>
    Effect.gen(function* () {
      if ((yield* store.listRequests(rt.threadId)).length > 0) return;
      if (rt.turn !== undefined) return yield* setStatus(rt, "running");
      if (rt.status === "needsApproval") {
        // A server-raised card on an idle thread ends without a turn end, so nothing else would
        // get to what was queued or delivered while it was up.
        if (rt.session !== undefined && !rt.closing && !rt.reserved) return yield* becomeIdle(rt);
        yield* setStatus(rt, rt.session === undefined ? "cold" : "idle");
        yield* pumpDeliveries(rt);
        yield* drainQueue(rt);
      }
    });

  const requestApproval: ThreadRuntimesShape["requestApproval"] = (threadId, fields) =>
    Effect.gen(function* () {
      const rt = yield* getRuntime(threadId);
      const request: ApprovalRequest = {
        kind: "approval",
        id: RequestId.make(randomUUID()),
        ...fields,
      };
      const answer = yield* Deferred.make<ServerApprovalAnswer>();
      return yield* locked(
        rt,
        Effect.gen(function* () {
          const thread = yield* store
            .getThread(threadId)
            .pipe(Effect.catchCause(() => Effect.succeed(undefined)));
          serverRequests.set(request.id, {
            threadId,
            toolName: fields.toolName,
            answer,
            ...(thread === undefined ? {} : { permissionMode: thread.mode }),
          });
          serverApprovalOrigins.set(request.id, threadId);
          yield* store.putRequest(threadId, request, yield* Clock.currentTimeMillis);
          yield* Effect.logInfo("app tool approval requested").pipe(
            Effect.annotateLogs({
              threadId,
              requestId: request.id,
              toolName: fields.toolName,
              ...(thread === undefined ? {} : { permissionMode: thread.mode }),
              at: yield* Clock.currentTimeMillis,
            }),
            Effect.catchCause(() => Effect.void),
          );
          yield* hub.publish({ type: "thread.request", threadId, request });
          yield* setStatus(rt, "needsApproval");
        }),
      ).pipe(
        Effect.andThen(Deferred.await(answer)),
        Effect.onInterrupt(() =>
          locked(
            rt,
            Effect.gen(function* () {
              const pending = serverRequests.get(request.id);
              if (serverRequests.delete(request.id)) {
                yield* approvalResolution(
                  threadId,
                  request.id,
                  fields.toolName,
                  "runtime",
                  "request-cancelled",
                  pending?.permissionMode,
                );
              }
              const removed = yield* store.removeRequest(threadId, request.id);
              if (!removed) return;
              serverApprovalOrigins.delete(request.id);
              yield* hub.publish({
                type: "thread.requestResolved",
                threadId,
                requestId: request.id,
              });
              yield* restoreStatusAfterRequest(rt);
            }),
          ),
        ),
      );
    });

  /** Answers a card the server raised with `requestApproval`. */
  const respondToServer = (threadId: ThreadId, requestId: RequestId, answer: RequestAnswer) =>
    Effect.gen(function* () {
      const rt = yield* getRuntime(threadId);
      return yield* locked(
        rt,
        Effect.uninterruptible(
          Effect.gen(function* () {
            const pending = serverRequests.get(requestId);
            if (pending === undefined || pending.threadId !== threadId) {
              return yield* new RequestNotFound({ threadId, requestId });
            }
            if (answer.kind !== "approval") {
              return yield* new InvalidState({
                message: "that request needs an approval answer",
                threadId,
                status: rt.status,
              });
            }
            serverRequests.delete(requestId);
            yield* Effect.gen(function* () {
              if (!(yield* store.removeRequest(threadId, requestId))) {
                return yield* new RequestNotFound({ threadId, requestId });
              }
              serverApprovalOrigins.delete(requestId);
              yield* hub.publish({ type: "thread.requestResolved", threadId, requestId });
            }).pipe(
              Effect.onExit((exit) =>
                Effect.gen(function* () {
                  const failed = Exit.isFailure(exit);
                  const resolution = yield* approvalResolution(
                    threadId,
                    requestId,
                    pending.toolName,
                    failed ? "runtime" : "user",
                    failed
                      ? "approval-response-cleanup-failed"
                      : answer.decision === "allow"
                        ? "approved"
                        : "rejected",
                    pending.permissionMode,
                  );
                  // Copy only client fields. Withdrawal failure propagates, but still releases the
                  // captured waiter fail-closed; diagnostics cannot erase a successful user answer.
                  yield* Deferred.succeed(pending.answer, {
                    kind: "approval",
                    decision: failed ? "deny" : answer.decision,
                    scope: failed ? "once" : answer.scope,
                    ...(!failed && answer.message !== undefined ? { message: answer.message } : {}),
                    resolution,
                  });
                }),
              ),
            );
          }),
        ).pipe(
          // Only withdrawal and decision completion are atomic. Restoring idle can drain a
          // queued delivery into provider I/O, which must stay cancellable and release the lock.
          Effect.andThen(restoreStatusAfterRequest(rt)),
        ),
      );
    });

  const respondToSession = (threadId: ThreadId, requestId: RequestId, answer: RequestAnswer) =>
    withSession(threadId, (rt, session) =>
      Effect.gen(function* () {
        const waiting = yield* store.listRequests(threadId);
        if (!waiting.some((request) => request.id === requestId)) {
          return yield* new RequestNotFound({ threadId, requestId });
        }
        // Removed only once the agent has the answer: one that didn't arrive leaves the card up,
        // to be answered again, rather than a thread that reads running while the agent waits.
        yield* session
          .respond(requestId, answer)
          .pipe(
            Effect.mapError(
              (error) => new InvalidState({ message: error.message, threadId, status: rt.status }),
            ),
          );
        // The adapter may have reported it resolved already, which published the event.
        if (yield* store.removeRequest(threadId, requestId)) {
          yield* hub.publish({ type: "thread.requestResolved", threadId, requestId });
        }
        const remaining = yield* store.listRequests(threadId);
        if (remaining.length === 0 && rt.turn !== undefined) yield* setStatus(rt, "running");
      }),
    );

  const respond: ThreadRuntimesShape["respond"] = (threadId, requestId, answer) =>
    serverApprovalOrigins.has(requestId)
      ? respondToServer(threadId, requestId, answer)
      : respondToSession(threadId, requestId, answer);

  return { clearPendingRequests, requestApproval, respond };
};

/** What `makeServerApprovals` gives the rest of `ThreadRuntimes`. */
export type ServerApprovals = ReturnType<typeof makeServerApprovals>;

/** What answering many cards at once goes through. */
export interface ApprovalMethodsDeps {
  readonly respond: ServerApprovals["respond"];
}

/** The `ThreadRuntimes` method that answers several cards, each on its own. */
export const makeApprovalMethods = ({
  respond,
}: ApprovalMethodsDeps): Pick<ThreadRuntimesShape, "respondMany"> => ({
  respondMany: (answers) =>
    Effect.forEach(answers, ({ threadId, requestId, answer }) =>
      respond(threadId, requestId, answer).pipe(
        Effect.as<RespondManyResult>({ threadId, requestId, ok: true }),
        Effect.catchCause((cause) =>
          Effect.succeed<RespondManyResult>({
            threadId,
            requestId,
            ok: false,
            error: respondFailure(cause),
          }),
        ),
      ),
    ),
});
