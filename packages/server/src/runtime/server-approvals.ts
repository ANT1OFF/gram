import { AnswerProofRef } from "../embedding/answer-proof.ts";
import type { EventSinkShape } from "../embedding/event-sink.ts";
import { ActingPerson } from "../embedding/person.ts";
import * as Cause from "effect/Cause";
import {
  type ThreadId,
  RequestId,
  type ApprovalAnswer,
  type AppToolApprovalResolution,
  type PermissionMode,
  type ApprovalRequest,
  type PendingRequest,
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
import * as Option from "effect/Option";
import {
  DECISION_UNAVAILABLE,
  refusalForAgent,
  refusalText,
  type Decided,
  type DecisionHookShape,
} from "../embedding/decision-hook.ts";
import {
  type AskedRequest,
  hookedKey,
  type HookedRequests,
  requestActions,
} from "../embedding/hooked-requests.ts";
import { KEYLESS_ANSWER } from "./card-key.ts";
import { type ApprovalReach, reachRefusal } from "./answer-reach.ts";

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
  /** The signed-in person who answered, where the server knows one (`embedding/person.ts`). */
  readonly answeredBy?: string;
};

export interface ServerApprovalRequest {
  readonly threadId: ThreadId;
  readonly toolName: string;
  /** Best-effort snapshot at request creation; resolution must not depend on database access. */
  readonly permissionMode?: PermissionMode;
  /** Who may approve it, beyond reaching its thread; anyone who may, when absent. */
  readonly reach?: ApprovalReach;
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
  /** The decision hook, where one is configured, and the cards it sent to a person. */
  readonly decisions: DecisionHookShape | undefined;
  readonly hooked: HookedRequests;
  /** The event sink, where one is configured, told who answered a card and how. */
  readonly eventSink: EventSinkShape | undefined;
  readonly getRuntime: GetRuntime;
  readonly serverRequests: Map<RequestId, ServerApprovalRequest>;
  readonly serverApprovalOrigins: Map<RequestId, ThreadId>;
  readonly setStatus: TurnLifecycle["setStatus"];
  readonly pumpDeliveries: MessageQueue["pumpDeliveries"];
  readonly drainQueue: MessageQueue["drainQueue"];
  readonly withSession: MessageQueue["withSession"];
  readonly becomeIdle: (rt: Runtime) => Effect.Effect<void>;
}

interface Confirmed {
  readonly answer: RequestAnswer;
  readonly asked: AskedRequest | undefined;
  readonly card: PendingRequest | undefined;
}

const sameCard = (a: PendingRequest, b: PendingRequest | undefined): boolean =>
  b !== undefined && JSON.stringify(a) === JSON.stringify(b);

export const makeServerApprovals = ({
  store,
  hub,
  decisions,
  hooked,
  eventSink,
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
      hooked.forget(rt.threadId);
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

  const restoreStatusAfterRequest = (rt: Runtime) =>
    Effect.gen(function* () {
      if ((yield* store.listRequests(rt.threadId)).length > 0) return;
      if (rt.turn !== undefined) return yield* setStatus(rt, "running");
      if (rt.status === "needsApproval") {
        if (rt.session !== undefined && !rt.closing && !rt.reserved) return yield* becomeIdle(rt);
        yield* setStatus(rt, rt.session === undefined ? "cold" : "idle");
        yield* pumpDeliveries(rt);
        yield* drainQueue(rt);
      }
    });

  const requestApproval: ThreadRuntimesShape["requestApproval"] = (
    threadId,
    fields,
    decided,
    reach,
  ) =>
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
            ...(reach === undefined ? {} : { reach }),
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
          if (decided !== undefined && eventSink !== undefined)
            yield* eventSink.noteAsk(request.id, decided, threadId);
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

  const noteAnswer = (threadId: ThreadId, requestId: RequestId, answer: RequestAnswer) =>
    Effect.gen(function* () {
      if (eventSink === undefined) return;
      const answeredBy = yield* ActingPerson;
      const proof = yield* AnswerProofRef;
      const decision =
        answer.kind === "question"
          ? undefined
          : answer.decision === "allow" || answer.decision === "approve"
            ? ("approve" as const)
            : ("reject" as const);
      yield* eventSink.noteAnswer(
        requestId,
        {
          ...(decision === undefined ? {} : { decision }),
          ...(answeredBy === undefined ? {} : { answeredBy }),
          ...(proof === undefined ? {} : { proof }),
        },
        threadId,
      );
    });
  const unnoteAnswer = (threadId: ThreadId, requestId: RequestId) =>
    eventSink === undefined ? Effect.void : eventSink.noteAnswer(requestId, undefined, threadId);

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
            const refused =
              answer.decision === "allow" ? yield* reachRefusal(pending.reach) : undefined;
            if (refused !== undefined) {
              return yield* new InvalidState({ message: refused, threadId, status: rt.status });
            }
            serverRequests.delete(requestId);
            const answeredBy = yield* ActingPerson;
            yield* noteAnswer(threadId, requestId, answer);
            yield* Effect.gen(function* () {
              if (!(yield* store.removeRequest(threadId, requestId))) {
                yield* unnoteAnswer(threadId, requestId);
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
                  yield* Deferred.succeed(pending.answer, {
                    kind: "approval",
                    decision: failed ? "deny" : answer.decision,
                    scope: failed ? "once" : answer.scope,
                    ...(!failed && answer.message !== undefined ? { message: answer.message } : {}),
                    resolution,
                    ...(failed || answeredBy === undefined ? {} : { answeredBy }),
                  });
                }),
              ),
            );
          }),
        ).pipe(Effect.andThen(restoreStatusAfterRequest(rt))),
      );
    });

  const confirmedByHook = (
    threadId: ThreadId,
    requestId: RequestId,
    answer: RequestAnswer,
    shown: string | undefined,
  ) =>
    Effect.gen(function* () {
      const asked = hooked.asked.get(hookedKey(threadId, requestId));
      const card = yield* store.listRequests(threadId).pipe(
        Effect.map((requests) => requests.find((request) => request.id === requestId)),
        Effect.orElseSucceed(() => undefined),
      );
      if (shown !== undefined && card?.shown !== shown)
        return yield* new RequestNotFound({ threadId, requestId });
      if (shown === undefined && card?.shown !== undefined)
        return yield* new InvalidState({ message: KEYLESS_ANSWER, threadId });
      const confirmed = (given: RequestAnswer): Confirmed => ({ answer: given, asked, card });
      if (decisions === undefined || answer.kind !== "approval" || answer.decision !== "allow") {
        return confirmed(answer);
      }
      if (asked === undefined) {
        const governed =
          card === undefined ||
          (card.kind === "approval" &&
            requestActions(card).length > 0 &&
            (yield* decisions.enabled));
        if (!governed) return confirmed(answer);
        return confirmed({
          kind: "approval",
          decision: "deny",
          scope: "once",
          message: DECISION_UNAVAILABLE,
        });
      }
      const thread = yield* store.getThread(threadId).pipe(Effect.option);
      const answeredBy = yield* ActingPerson;
      for (const each of asked.actions) {
        const decided: Decided = Option.isNone(thread)
          ? { id: "", decision: "refuse", reason: DECISION_UNAVAILABLE }
          : yield* decisions.decide({
              ...each,
              initiator: "agent",
              thread: thread.value,
              approval: {
                decisionId: each.decisionId,
                askId: requestId,
                ...(answeredBy === undefined ? {} : { answeredBy }),
              },
            });
        if (decided.decision === "allow") continue;
        const reason = decided.reason ?? "The approval was not accepted.";
        yield* hub.publish({
          type: "notify",
          kind: "info",
          title: refusalText(each.action, reason),
          threadId,
        });
        return confirmed({
          kind: "approval",
          decision: "deny",
          scope: "once",
          message: refusalForAgent(each.action, reason),
        });
      }
      return confirmed({ ...answer, scope: "once" });
    });

  const respondToSession = (
    threadId: ThreadId,
    requestId: RequestId,
    given: RequestAnswer,
    shown: string | undefined,
  ) =>
    confirmedByHook(threadId, requestId, given, shown).pipe(
      Effect.flatMap((confirmed) => deliverToSession(threadId, requestId, confirmed, given, shown)),
    );

  const deliverToSession = (
    threadId: ThreadId,
    requestId: RequestId,
    confirmed: Confirmed,
    given: RequestAnswer = confirmed.answer,
    shown?: string,
  ) =>
    withSession(threadId, (rt, session) =>
      Effect.gen(function* () {
        const { answer } = confirmed;
        const waiting = (yield* store.listRequests(threadId)).find(
          (request) => request.id === requestId,
        );
        if (shown === undefined && waiting?.shown !== undefined) {
          return yield* new InvalidState({ message: KEYLESS_ANSWER, threadId, status: rt.status });
        }
        if (
          waiting === undefined ||
          (shown !== undefined && waiting.shown !== shown) ||
          !sameCard(waiting, confirmed.card) ||
          hooked.asked.get(hookedKey(threadId, requestId)) !== confirmed.asked
        ) {
          return yield* new RequestNotFound({ threadId, requestId });
        }
        yield* noteAnswer(threadId, requestId, given);
        yield* session.respond(requestId, answer).pipe(
          Effect.mapError(
            (error) => new InvalidState({ message: error.message, threadId, status: rt.status }),
          ),
          Effect.tapError(() => unnoteAnswer(threadId, requestId)),
        );
        hooked.asked.delete(hookedKey(threadId, requestId));
        if (yield* store.removeRequest(threadId, requestId)) {
          yield* hub.publish({ type: "thread.requestResolved", threadId, requestId });
        }
        const remaining = yield* store.listRequests(threadId);
        if (remaining.length === 0 && rt.turn !== undefined) yield* setStatus(rt, "running");
      }),
    );

  const deliver = (
    threadId: ThreadId,
    requestId: RequestId,
    answer: RequestAnswer,
    shown?: string,
  ) =>
    serverApprovalOrigins.has(requestId)
      ? respondToServer(threadId, requestId, answer)
      : respondToSession(threadId, requestId, answer, shown);

  const respond: ThreadRuntimesShape["respond"] = deliver;

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
    Effect.forEach(answers, ({ threadId, requestId, answer, shown }) =>
      respond(threadId, requestId, answer, shown).pipe(
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
