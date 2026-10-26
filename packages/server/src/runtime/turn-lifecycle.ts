// A thread's status and turns: opening and finishing a turn, how it failed, the system delivery or
// note it carried, and the idle timer that ends a session nobody uses.

import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Clock from "effect/Clock";
import * as Option from "effect/Option";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import {
  type Runtime,
  BUSY,
  statusEvent,
  UNAVAILABLE_LOG_CHARS,
  withDataPart,
  ACTIVITY_THROTTLE_MS,
  locked,
  evictable,
  BACKGROUND_TASK_GRACE,
  type TurnEndOrigin,
  runHook,
  makeTurnId,
  type Turn,
} from "./runtime-state.ts";
import type { SystemDeliveryFailure } from "./system-delivery.ts";
import {
  type AgentUnavailable,
  type TurnId,
  type ThreadStatus,
  type ThreadError,
  type AgentFailure,
  type MessageId,
  type Thread,
  type TurnEndReason,
  type ThreadId,
} from "@gram/contracts";
import {
  unavailableMessage,
  unavailableError,
  missingFolderError,
  threadError,
  loggableCode,
} from "./thread-error.ts";
import { missingThreadFolder } from "../fs/folders.ts";
import { settleEstimate } from "./cost-ledger.ts";
import type {
  ObservedTurnEnd,
  RuntimeObserver,
  NotifyObservers,
  Dispatch,
} from "./runtime-observer.ts";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";
import type { EventHubShape } from "../events/event-hub.ts";
import type { ServerConfigShape } from "../config.ts";
import type { TurnHooksShape, CheckoutServiceShape } from "./hooks.ts";
import type { ThreadWaitsShape } from "../waits/service.ts";
import type { FeedWriter } from "./feed-writer.ts";

/** What a thread's turns and status read and change beside its `Runtime`. */
export interface TurnLifecycleDeps {
  readonly store: ThreadStoreShape;
  readonly hub: EventHubShape;
  readonly config: ServerConfigShape;
  readonly hooks: TurnHooksShape;
  readonly checkouts: CheckoutServiceShape;
  readonly waits: ThreadWaitsShape;
  readonly sessions: FiberMap.FiberMap<ThreadId>;
  readonly idleTimers: FiberMap.FiberMap<ThreadId>;
  readonly quietTimers: FiberMap.FiberMap<ThreadId>;
  readonly activityTimers: FiberMap.FiberMap<ThreadId>;
  readonly observers: ReadonlySet<RuntimeObserver>;
  readonly notifyObservers: NotifyObservers;
  readonly dispatch: Dispatch;
  readonly publishMessage: FeedWriter["publishMessage"];
  readonly appendDataPart: FeedWriter["appendDataPart"];
  readonly closeOpenMessages: FeedWriter["closeOpenMessages"];
  readonly setRetrying: (rt: Runtime, retrying: boolean, detail?: string) => Effect.Effect<void>;
  readonly clearPendingRequests: (rt: Runtime, reason: string) => Effect.Effect<void>;
}

/** Status, turns and failures, which every other part of `ThreadRuntimes` reports through. */
export const makeTurnLifecycle = ({
  store,
  hub,
  config,
  hooks,
  checkouts,
  waits,
  sessions,
  idleTimers,
  quietTimers,
  activityTimers,
  observers,
  notifyObservers,
  dispatch,
  publishMessage,
  appendDataPart,
  closeOpenMessages,
  setRetrying,
  clearPendingRequests,
}: TurnLifecycleDeps) => {
  /** Reports a delivery's outcome, once: whichever comes first clears `carrying`. Holds the lock. */
  const settleDelivery = (rt: Runtime, outcome: "accepted" | SystemDeliveryFailure) =>
    Effect.suspend(() => {
      const carried = rt.carrying;
      if (carried === undefined) return Effect.void;
      rt.carrying = undefined;
      return dispatch(
        rt.threadId,
        `system delivery ${outcome === "accepted" ? "accepted" : "failed"}`,
        outcome === "accepted"
          ? carried.delivery.accepted(carried.turnId)
          : carried.delivery.failed(carried.turnId, outcome),
      );
    });

  /**
   * Records what turn `turnId`'s note told as heard when `taken`, or leaves it news. Holds the
   * lock.
   */
  const settleNote = (rt: Runtime, turnId: TurnId | undefined, taken: boolean) =>
    Effect.suspend(() => {
      const told = rt.noteHeard;
      if (told === undefined || told.turnId !== turnId) return Effect.void;
      rt.noteHeard = undefined;
      return taken ? waits.heard(rt.threadId, told.items) : Effect.void;
    });

  /** Holds the lock. */
  const failPendingDeliveries = (rt: Runtime, reason: SystemDeliveryFailure) =>
    Effect.suspend(() => {
      const pending = [...rt.deliveries.values()];
      rt.deliveries.clear();
      return Effect.forEach(
        pending,
        (delivery) =>
          dispatch(rt.threadId, "system delivery failed", delivery.failed(undefined, reason)),
        { discard: true },
      );
    });

  /**
   * Publishes `status`; without an explicit `detail`, a busy status carries the activity line, and
   * so does an idle one while a background subagent is still working.
   */
  const setStatus = (rt: Runtime, status: ThreadStatus, detail?: string, force = false) =>
    Effect.gen(function* () {
      if (rt.status === status && detail === undefined && !force) return;
      rt.status = status;
      // Only a running thread compacts; whatever else it became, the compaction is over.
      const endedCompaction = status !== "running" ? rt.compaction : undefined;
      if (status !== "running") rt.compaction = undefined;
      // A turn that failed leaves its session open, and the next input goes to it as it would from
      // idle: failing what waits here paused orchestration over one API error.
      if (status === "ended" || (status === "error" && rt.session === undefined)) {
        yield* failPendingDeliveries(rt, status);
      }
      if (!BUSY.has(status)) {
        if (status === "idle") rt.activity.endTurn();
        else rt.activity.reset();
        if (!rt.activity.subagentsRunning) yield* FiberMap.remove(activityTimers, rt.threadId);
      }
      const shows = BUSY.has(status) || rt.activity.subagentsRunning;
      const line = detail ?? (shows ? rt.activity.line : undefined);
      rt.activityPublished = line;
      rt.activityPublishedAt = yield* Clock.currentTimeMillis;
      yield* hub.publish(statusEvent(rt, status, line));
      if (endedCompaction !== undefined) {
        yield* Effect.logInfo("thread compaction status").pipe(
          Effect.annotateLogs({
            threadId: rt.threadId,
            phase: "cleared",
            status,
            at: yield* Clock.currentTimeMillis,
            startedAt: endedCompaction.startedAt,
            queueLength: rt.queue.length,
          }),
        );
      }
    });

  /**
   * Puts the thread in `error` for an agent that couldn't start, and logs why: the reason otherwise
   * exists only on screen, and a tester's log for a thread that never started (0.2.0-rc.1 on Windows)
   * held nothing about it. Only `AgentUnavailable`'s own fields are logged, which the adapters write
   * about starting the agent. A turn's error is the agent's text and stays out of the log.
   */
  const failUnavailable = (
    rt: Runtime,
    error: AgentUnavailable,
    detail = unavailableMessage(error),
  ) =>
    Effect.gen(function* () {
      rt.restartMarker = undefined;
      yield* Effect.logWarning("agent unavailable").pipe(
        Effect.annotateLogs({
          threadId: rt.threadId,
          agent: error.agent,
          reason: error.reason ?? "",
          unavailable: error.message.slice(0, UNAVAILABLE_LOG_CHARS),
        }),
      );
      const at = yield* Clock.currentTimeMillis;
      // An agent can't start in a folder that is gone, and its spawn error would read as a broken
      // install: the thread says what happened instead.
      const gone = rt.cwd !== undefined && !(yield* checkouts.present(rt.cwd));
      const text = gone ? missingThreadFolder(rt.cwd!) : undefined;
      yield* keepError(
        rt,
        text === undefined ? unavailableError(error, at) : missingFolderError(text, at),
      );
      yield* setStatus(rt, "error", text ?? detail);
    });

  /** Puts `error` on the thread as its `lastError`, or with none, clears the one it has. */
  const keepError = (rt: Runtime, error: ThreadError | undefined) =>
    Effect.gen(function* () {
      const thread = yield* store.getThread(rt.threadId).pipe(Effect.option);
      if (Option.isNone(thread)) return;
      if (error === undefined && thread.value.lastError === undefined) return;
      const next = yield* store
        .updateThread(rt.threadId, (current) => {
          const { lastError: _, ...rest } = current;
          return error === undefined ? rest : { ...rest, lastError: error };
        })
        .pipe(Effect.orDie);
      yield* publishUpsert(next);
    });

  /**
   * Records how a turn failed: its kind and status in the log, never the agent's words, which may
   * echo the request; Gram's sentence for it on the thread, before the turn ends so its
   * observers read it. Holds the lock.
   */
  const recordFailure = (
    rt: Runtime,
    failure: AgentFailure,
    detail: string,
    turnId: TurnId | undefined,
  ) =>
    Effect.gen(function* () {
      const thread = yield* store.getThread(rt.threadId).pipe(Effect.orDie);
      const at = yield* Clock.currentTimeMillis;
      const { profileId } = thread.model;
      const profile =
        profileId === undefined
          ? undefined
          : (yield* store.listProfiles).find((each) => each.id === profileId);
      const error = threadError(
        failure,
        detail,
        {
          model: thread.model.model,
          agent: thread.model.agent,
          gateway: profileId !== undefined,
          gatewayURL: profile?.baseURL,
        },
        at,
        turnId,
      );
      yield* Effect.logWarning("turn failed").pipe(
        Effect.annotateLogs({
          threadId: rt.threadId,
          agent: rt.agent,
          kind: failure.kind,
          httpStatus: failure.httpStatus ?? "",
          code: loggableCode(failure.code),
          retryable: failure.retryable,
        }),
      );
      yield* keepError(rt, error);
      return error;
    });

  /**
   * The failed turn's error part, at the end of that turn's own reply once it is stored, so the
   * reply keeps its resume anchor for a fork or a rewind. A turn that streamed no reply gets no card:
   * a message of its own, with no anchor, would become the one those resolve against.
   */
  const publishFailure = (
    rt: Runtime,
    error: ThreadError,
    turnId: TurnId,
    replyId: MessageId | undefined,
  ) =>
    Effect.gen(function* () {
      if (replyId === undefined) return;
      const reply = yield* store.getMessage(rt.threadId, replyId);
      if (reply === undefined) return;
      const part = { type: "data-agent-error", id: `error-${turnId}`, data: error } as const;
      yield* publishMessage(rt, withDataPart(reply, part), turnId);
    });

  /** Publishes the activity line if it changed since clients last got one. Holds the lock. */
  const publishActivity = (rt: Runtime) =>
    Effect.gen(function* () {
      const line = rt.activity.line;
      if (line === rt.activityPublished) return;
      // Between turns only a background subagent's line, or clearing it, reaches clients.
      if (!BUSY.has(rt.status) && !rt.activity.subagentsRunning && line !== undefined) return;
      rt.activityPublished = line;
      rt.activityPublishedAt = yield* Clock.currentTimeMillis;
      yield* hub.publish(statusEvent(rt, rt.status, line));
    });

  /** At most one activity publish per `ACTIVITY_THROTTLE_MS`; the latest line wins. */
  const scheduleActivity = (rt: Runtime) =>
    Effect.gen(function* () {
      const wait = rt.activityPublishedAt + ACTIVITY_THROTTLE_MS - (yield* Clock.currentTimeMillis);
      if (wait <= 0) return yield* publishActivity(rt);
      yield* FiberMap.run(
        activityTimers,
        rt.threadId,
        Effect.sleep(wait).pipe(Effect.andThen(locked(rt, publishActivity(rt)))),
        { onlyIfMissing: true },
      );
    });

  const publishUpsert = (thread: Thread) => hub.publish({ type: "thread.upsert", thread });

  const evictAfter = Effect.gen(function* () {
    if (config.idleEvictAfter !== undefined) return config.idleEvictAfter;
    const settings = yield* store.getSettings;
    return Duration.minutes(settings.agents.idleEvictMinutes);
  });

  const stopSession = (rt: Runtime, reason: NonNullable<Runtime["stopping"]>) =>
    Effect.gen(function* () {
      yield* locked(
        rt,
        Effect.sync(() => {
          if (rt.session !== undefined || FiberMap.hasUnsafe(sessions, rt.threadId)) {
            rt.stopping = reason;
          }
        }),
      );
      // Outside the lock: the session fiber's exit handler takes it.
      yield* FiberMap.remove(sessions, rt.threadId);
    });

  const startIdleTimer = (rt: Runtime) =>
    Effect.gen(function* () {
      const thread = yield* store.getThread(rt.threadId).pipe(Effect.orDie);
      if (thread.pinned) return;
      const after = yield* evictAfter;
      yield* FiberMap.run(
        idleTimers,
        rt.threadId,
        Effect.sleep(after).pipe(
          Effect.andThen(
            locked(
              rt,
              Effect.sync(() => evictable(rt) && rt.background.length > 0),
            ),
          ),
          Effect.flatMap((waiting) =>
            waiting ? Effect.sleep(BACKGROUND_TASK_GRACE) : Effect.void,
          ),
          Effect.andThen(
            locked(
              rt,
              Effect.sync(() => evictable(rt)),
            ),
          ),
          Effect.flatMap((evict) => (evict ? stopSession(rt, "evict") : Effect.void)),
        ),
      );
    });

  const cancelIdleTimer = (rt: Runtime) => FiberMap.remove(idleTimers, rt.threadId);

  const touch = (rt: Runtime) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      return yield* store
        .updateThread(rt.threadId, (t) => ({ ...t, lastActivityAt: now }))
        .pipe(Effect.orDie);
    });

  const clearQuiet = (rt: Runtime) =>
    Effect.gen(function* () {
      if (rt.quiet === undefined) return;
      rt.quiet = undefined;
      const thread = yield* store.getThread(rt.threadId).pipe(Effect.orDie);
      yield* notifyObservers(rt.threadId, "onQuiet", (observer) =>
        observer.onQuiet?.(thread, undefined),
      );
    });

  /** `limited`: the turn stopped on a provider limit the thread now waits out (`enterWait`). */
  const finishTurn = (rt: Runtime, reason: TurnEndReason, origin: TurnEndOrigin, limited = false) =>
    Effect.gen(function* () {
      // A compaction Gram asked for that the agent never reported still gets its marker, saying so.
      const idle = rt.turn?.idleCompaction;
      if (rt.turn !== undefined && idle !== undefined && !idle.compacted) {
        yield* appendDataPart(rt, {
          type: "data-compaction",
          id: `compaction:idle:${rt.turn.id}`,
          data: {
            trigger: "manual",
            reason: "idle",
            outcome: reason === "error" ? "failed" : "unknown",
            at: yield* Clock.currentTimeMillis,
            ...(idle.workspaceId === undefined ? {} : { workspaceId: idle.workspaceId }),
          },
        });
      }
      yield* closeOpenMessages(rt);
      const turn = rt.turn;
      if (turn === undefined) return;
      rt.turn = undefined;
      yield* clearQuiet(rt);
      yield* FiberMap.remove(quietTimers, rt.threadId);
      yield* setRetrying(rt, false);
      // Only the adapter's own word counts: a turn the host ended says nothing about whether the
      // agent has the input, and neither does an `error` end before any of its reply.
      const taken = origin === "adapter" && reason !== "error";
      if (rt.carrying?.turnId === turn.id) {
        yield* settleDelivery(
          rt,
          taken ? "accepted" : limited ? "limited" : origin === "adapter" ? "turnError" : origin,
        );
      }
      yield* settleNote(rt, turn.id, taken);
      if (turn.usage?.costEstimated === true && turn.usage.costUsd !== undefined) {
        settleEstimate(rt.cost, turn.usage.costUsd);
      }
      const endedAt = yield* Clock.currentTimeMillis;
      yield* (reason === "interrupted" ? Effect.logInfo : Effect.logDebug)(
        "thread turn ended",
      ).pipe(
        Effect.annotateLogs({
          threadId: rt.threadId,
          turnId: turn.id,
          reason,
          origin,
          lastTool: rt.lastTool,
          at: endedAt,
          queueLength: rt.queue.length,
        }),
      );
      yield* store.endTurn(turn.id, {
        endedAt,
        reason,
        ...(turn.usage === undefined
          ? {}
          : { usage: { ...turn.usage, lastRequestAt: turn.lastInputAt } }),
      });
      yield* Deferred.succeed(turn.done, undefined);
      // Requests belong to the turn: once it ends nothing will answer them, whether or not the agent
      // reported them resolved.
      yield* clearPendingRequests(rt, `turn-${reason}`);
      if (rt.cwd !== undefined) {
        yield* runHook(
          rt,
          "onTurnEnd",
          hooks.onTurnEnd(rt.threadId, turn.id, rt.cwd, reason, rt.touchedRemote),
        );
      }
      if (observers.size === 0) return;
      const thread = yield* store.getThread(rt.threadId).pipe(Effect.option);
      if (Option.isNone(thread)) return;
      const end: ObservedTurnEnd = {
        turnId: turn.id,
        reason,
        producedOutput: turn.producedOutput === true,
        synthesized: origin !== "adapter",
        queueEmpty: rt.queue.length === 0 && rt.deliveries.size === 0,
        endedAt,
        lastTool: rt.lastTool,
        ...(turn.idleCompaction === undefined
          ? {}
          : {
              idleCompaction: turn.idleCompaction.compacted
                ? "completed"
                : reason === "error"
                  ? "failed"
                  : "unknown",
            }),
      };
      yield* notifyObservers(rt.threadId, "onTurnEnd", (observer) =>
        observer.onTurnEnd?.(thread.value, end),
      );
    });

  const openTurn = (rt: Runtime, id: TurnId = makeTurnId()) =>
    Effect.gen(function* () {
      rt.admitted = false;
      yield* cancelIdleTimer(rt);
      const now = yield* Clock.currentTimeMillis;
      const turn: Turn = {
        id,
        startedAt: now,
        done: yield* Deferred.make<void>(),
        usage: undefined,
        model: (yield* store.getThread(rt.threadId).pipe(Effect.orDie)).model,
        lastInputAt: now,
      };
      rt.turn = turn;
      yield* clearQuiet(rt);
      rt.lastTool = undefined;
      rt.runningTools.clear();
      rt.stopAtBoundary = undefined;
      rt.lastProgressAt = now;
      yield* FiberMap.run(
        quietTimers,
        rt.threadId,
        Effect.gen(function* () {
          while (true) {
            yield* Effect.sleep("1 minute");
            yield* locked(
              rt,
              Effect.gen(function* () {
                const at = yield* Clock.currentTimeMillis;
                if (
                  rt.turn !== turn ||
                  rt.status !== "running" ||
                  rt.compaction !== undefined ||
                  rt.runningTools.size === 0 ||
                  rt.quiet !== undefined ||
                  at - rt.lastProgressAt < 600_000
                )
                  return;
                rt.quiet = {
                  kind: "toolStalled",
                  at: rt.lastProgressAt,
                  ...(rt.lastTool === undefined ? {} : { lastTool: rt.lastTool }),
                };
                yield* Effect.logWarning("worker tool stopped streaming").pipe(
                  Effect.annotateLogs({
                    threadId: rt.threadId,
                    turnId: turn.id,
                    lastTool: rt.lastTool,
                    silenceMs: at - rt.lastProgressAt,
                  }),
                );
                const thread = yield* store.getThread(rt.threadId).pipe(Effect.orDie);
                const quiet = rt.quiet;
                yield* notifyObservers(rt.threadId, "onQuiet", (observer) =>
                  observer.onQuiet?.(thread, quiet),
                );
              }),
            );
          }
        }),
      );
      rt.touchedRemote = false;
      yield* store.startTurn(rt.threadId, turn.id, now);
      return { turn, now };
    });

  const markRunning = (rt: Runtime, turn: Turn) =>
    Effect.gen(function* () {
      const thread = yield* touch(rt);
      yield* setStatus(rt, "running");
      if (rt.cwd !== undefined) {
        yield* runHook(rt, "onTurnStart", hooks.onTurnStart(rt.threadId, turn.id, rt.cwd));
      }
      yield* notifyObservers(rt.threadId, "onTurnStart", (observer) =>
        observer.onTurnStart?.(thread, turn.id),
      );
    });

  /** A session's first message creates its transcript, so from then on it can be resumed. */
  const markSessionUsed = (rt: Runtime) =>
    Effect.gen(function* () {
      const thread = yield* store.getThread(rt.threadId).pipe(Effect.orDie);
      if (thread.agentSessionUnused !== true) return;
      const { agentSessionUnused, ...used } = thread;
      void agentSessionUnused;
      yield* publishUpsert(yield* store.updateThread(rt.threadId, () => used).pipe(Effect.orDie));
    });

  return {
    settleDelivery,
    settleNote,
    failPendingDeliveries,
    setStatus,
    failUnavailable,
    keepError,
    recordFailure,
    publishFailure,
    scheduleActivity,
    publishUpsert,
    stopSession,
    startIdleTimer,
    cancelIdleTimer,
    clearQuiet,
    finishTurn,
    openTurn,
    markRunning,
    markSessionUsed,
  };
};

/** What `makeTurnLifecycle` gives the rest of `ThreadRuntimes`. */
export type TurnLifecycle = ReturnType<typeof makeTurnLifecycle>;
