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
  guarded,
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
  type AgentEvent,
  type AgentStatus,
  type AgentUnavailable,
  type TurnId,
  type ThreadStatus,
  type ThreadError,
  type AgentFailure,
  type MachineIncident,
  type MessageId,
  type Thread,
  type TurnEndReason,
  type ThreadId,
  type UsageSummary,
} from "@gram/contracts";
import {
  unavailableMessage,
  unavailableError,
  keptWorkGoneError,
  missingFolderError,
  threadError,
  loggableCode,
} from "./thread-error.ts";
import { missingThreadFolder } from "../fs/folders.ts";
import { KEPT_WORK_GONE_REASON } from "../host/stop.ts";
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
import type { TurnActivity } from "./turn-activity.ts";
import type { FeedWriter } from "./feed-writer.ts";

/** What a thread's turns and status read and change beside its `Runtime`. */
export interface TurnLifecycleDeps {
  readonly turnActivity: TurnActivity["Service"];
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
  readonly stampTurnEnd: FeedWriter["stampTurnEnd"];
  readonly setRetrying: (rt: Runtime, retrying: boolean, detail?: string) => Effect.Effect<void>;
  readonly clearPendingRequests: (rt: Runtime, reason: string) => Effect.Effect<void>;
  /**
   * The name of the joined machine the thread runs on, while it is offline: a failure then is the
   * machine's (`Thread.machineIncident`). Absent where there are no joined machines.
   */
  readonly awayMachine?: (thread: Thread) => string | undefined;
}

/** A session a joined machine took with it (`EndedEvent.lostMachine`): which, and what ran. */
export interface MachineLostNote {
  readonly machine: string;
  readonly during?: string;
}

/**
 * The thread's machine incident after a failure at `at`: `lost` when the failure was a session the
 * machine took with it, `away` when the machine is offline now, and otherwise the one it had,
 * which only a completed turn or a resume clears. Never goes back from `lost` to `away`.
 */
export const incidentAfter = (
  thread: Pick<Thread, "machineIncident" | "savedWork" | "lastError">,
  at: number,
  lost: MachineLostNote | undefined,
  away: string | undefined,
): MachineIncident | undefined => {
  const legacy = thread.lastError?.machineLost;
  const kept: MachineIncident | undefined =
    thread.machineIncident ??
    (legacy === undefined
      ? undefined
      : {
          at: legacy.at ?? thread.lastError!.at,
          machine: legacy.machine,
          state: "lost",
          ...(legacy.during === undefined ? {} : { during: legacy.during }),
        });
  const machine = lost?.machine ?? away;
  if (machine === undefined) return kept;
  const state = lost !== undefined || kept?.state === "lost" ? "lost" : "away";
  if (kept !== undefined && kept.machine === machine) {
    const during = kept.during ?? lost?.during;
    return { ...kept, state, ...(during === undefined ? {} : { during }) };
  }
  return {
    at,
    machine,
    state,
    ...(thread.savedWork === undefined ? {} : { saved: thread.savedWork.at }),
    ...(lost?.during === undefined ? {} : { during: lost.during }),
  };
};

/** `error` as kept while `incident` lasts: it says the machine was lost, and since when. */
export const withIncident = (
  error: ThreadError,
  incident: MachineIncident | undefined,
): ThreadError =>
  incident === undefined
    ? error
    : {
        ...error,
        machineLost: {
          machine: incident.machine,
          ...(incident.during === undefined ? {} : { during: incident.during }),
          at: incident.at,
        },
      };

const WORK_STATUSES: ReadonlySet<AgentStatus> = new Set<AgentStatus>(["running", "compacting"]);

/** Status, turns and failures, which every other part of `ThreadRuntimes` reports through. */
export const makeTurnLifecycle = ({
  turnActivity,
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
  stampTurnEnd,
  setRetrying,
  clearPendingRequests,
  awayMachine,
}: TurnLifecycleDeps) => {
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

  const noteDeliveryStart = (rt: Runtime, event: AgentEvent, ownReply: boolean) =>
    Effect.suspend(() => {
      const carried = rt.carrying;
      if (
        carried === undefined ||
        carried.started === true ||
        carried.steered !== undefined ||
        rt.turn?.id !== carried.turnId ||
        !(
          (event.type === "status" && WORK_STATUSES.has(event.status)) ||
          (event.type === "chunk" && ownReply) ||
          event.type === "request"
        )
      )
        return Effect.void;
      rt.carrying = { ...carried, started: true };
      const started = carried.delivery.started;
      return started === undefined
        ? Effect.void
        : dispatch(rt.threadId, "system delivery started", started(carried.turnId));
    });

  const settleNote = (rt: Runtime, turnId: TurnId | undefined, taken: boolean) =>
    Effect.suspend(() => {
      const told = rt.noteHeard;
      if (told === undefined || told.turnId !== turnId) return Effect.void;
      rt.noteHeard = undefined;
      return taken ? waits.heard(rt.threadId, told.items) : Effect.void;
    });

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

  const setStatus = (rt: Runtime, status: ThreadStatus, detail?: string, force = false) =>
    Effect.gen(function* () {
      if (rt.status === status && detail === undefined && !force) return;
      rt.status = status;
      const endedCompaction = status !== "running" ? rt.compaction : undefined;
      if (status !== "running") rt.compaction = undefined;
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
      const keptGone = keptWorkGoneError(error, KEPT_WORK_GONE_REASON, at);
      const thread = yield* store.getThread(rt.threadId).pipe(Effect.option);
      const away = Option.isSome(thread) && awayMachine?.(thread.value) !== undefined;
      const gone =
        keptGone === undefined &&
        !away &&
        rt.cwd !== undefined &&
        !(yield* checkouts.present(rt.cwd));
      const text = gone ? missingThreadFolder(rt.cwd!) : undefined;
      const kept = yield* keepError(
        rt,
        keptGone ??
          (text === undefined ? unavailableError(error, at) : missingFolderError(text, at)),
      );
      if (kept?.machineLost !== undefined)
        yield* Effect.logInfo("agent unavailable on a lost machine").pipe(
          Effect.annotateLogs({ threadId: rt.threadId, machineLost: true }),
        );
      yield* setStatus(rt, "error", text ?? detail);
    });

  const keepError = (rt: Runtime, error: ThreadError | undefined, lost?: MachineLostNote) =>
    Effect.gen(function* () {
      const thread = yield* store.getThread(rt.threadId).pipe(Effect.option);
      if (Option.isNone(thread)) return undefined;
      if (
        error === undefined &&
        thread.value.lastError === undefined &&
        thread.value.machineIncident === undefined
      )
        return undefined;
      const at = yield* Clock.currentTimeMillis;
      const away =
        error === undefined || lost !== undefined ? undefined : awayMachine?.(thread.value);
      const next = yield* store
        .updateThread(rt.threadId, (current) => {
          const { lastError: _, machineIncident: __, ...rest } = current;
          if (error === undefined) return rest;
          const incident = incidentAfter(current, at, lost, away);
          return {
            ...rest,
            lastError: withIncident(error, incident),
            ...(incident === undefined ? {} : { machineIncident: incident }),
          };
        })
        .pipe(Effect.orDie);
      yield* publishUpsert(next);
      return next.lastError;
    });

  const recordFailure = (
    rt: Runtime,
    failure: AgentFailure,
    detail: string,
    turnId: TurnId | undefined,
    machineLost?: MachineLostNote,
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
      const kept = (yield* keepError(rt, error, machineLost)) ?? error;
      yield* Effect.logWarning("turn failed").pipe(
        Effect.annotateLogs({
          threadId: rt.threadId,
          agent: rt.agent,
          kind: failure.kind,
          httpStatus: failure.httpStatus ?? "",
          code: loggableCode(failure.code),
          retryable: failure.retryable,
          machineLost: kept.machineLost !== undefined,
        }),
      );
      return kept;
    });

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

  const publishActivity = (rt: Runtime) =>
    Effect.gen(function* () {
      const line = rt.activity.line;
      if (line === rt.activityPublished) return;
      if (!BUSY.has(rt.status) && !rt.activity.subagentsRunning && line !== undefined) return;
      rt.activityPublished = line;
      rt.activityPublishedAt = yield* Clock.currentTimeMillis;
      yield* hub.publish(statusEvent(rt, rt.status, line));
    });

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

  const stopSession = (
    rt: Runtime,
    reason: NonNullable<Runtime["stopping"]>,
    when?: () => boolean,
  ) =>
    Effect.gen(function* () {
      const stop = yield* locked(
        rt,
        Effect.sync(() => {
          if (when !== undefined && !when()) return false;
          if (rt.session !== undefined || FiberMap.hasUnsafe(sessions, rt.threadId)) {
            rt.stopping = reason;
          }
          return true;
        }),
      );
      if (!stop) return false;
      yield* FiberMap.remove(sessions, rt.threadId);
      return true;
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

  const finishTurn = (rt: Runtime, reason: TurnEndReason, origin: TurnEndOrigin, limited = false) =>
    Effect.gen(function* () {
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
      rt.steerSplit = undefined;
      rt.replyAliases.clear();
      const turn = rt.turn;
      if (turn === undefined) return;
      rt.turn = undefined;
      turnActivity.end(turn.id);
      yield* clearQuiet(rt);
      yield* FiberMap.remove(quietTimers, rt.threadId);
      yield* setRetrying(rt, false);
      const taken = origin === "adapter" && reason !== "error";
      const steered = rt.carrying?.turnId === turn.id ? rt.carrying.steered : undefined;
      if (steered !== undefined && origin === "adapter" && reason === "error" && !limited) {
        const delivery = rt.carrying!.delivery;
        rt.carrying = undefined;
        if (!rt.deliveries.has(steered.key)) rt.deliveries.set(steered.key, delivery);
      } else if (rt.carrying?.turnId === turn.id) {
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
      if (turn.reply !== undefined) {
        const end = { at: endedAt, reason: limited ? ("interrupted" as const) : reason };
        yield* guarded(
          rt.threadId,
          "turn end stamp",
          stampTurnEnd(rt, turn.reply, end, replyUsage(turn.usage)),
        );
      }
      yield* Deferred.succeed(turn.done, undefined);
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

  const openTurn = (
    rt: Runtime,
    id: TurnId = makeTurnId(),
    adopted?: { readonly startedAt: number },
  ) =>
    Effect.gen(function* () {
      rt.admitted = false;
      rt.errorAtRest = undefined;
      yield* cancelIdleTimer(rt);
      const now = yield* Clock.currentTimeMillis;
      const turn: Turn = {
        id,
        startedAt: adopted?.startedAt ?? now,
        done: yield* Deferred.make<void>(),
        usage: undefined,
        model: (yield* store.getThread(rt.threadId).pipe(Effect.orDie)).model,
        lastInputAt: now,
      };
      rt.turn = turn;
      turnActivity.start(turn.id);
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
      if (adopted === undefined) yield* store.startTurn(rt.threadId, turn.id, now);
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

  const markSessionUsed = (rt: Runtime) =>
    Effect.gen(function* () {
      const thread = yield* store.getThread(rt.threadId).pipe(Effect.orDie);
      if (thread.agentSessionUnused !== true) return;
      const updated = yield* store
        .updateThread(rt.threadId, (current) => {
          const { agentSessionUnused: _, ...used } = current;
          return used;
        })
        .pipe(Effect.orDie);
      yield* publishUpsert(updated);
    });

  return {
    settleDelivery,
    noteDeliveryStart,
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

/**
 * What a turn's reply keeps of its usage: the tokens the turn used and the context it left, which
 * the reply's token line reads. Not the dollars, which are the whole thread's so far, nor when its
 * cache was last written, which only the idle compaction reads from the thread.
 */
export const replyUsage = (usage: UsageSummary | undefined): UsageSummary | undefined => {
  if (usage === undefined) return undefined;
  const { costUsd: _cost, costEstimated: _estimated, lastRequestAt: _lastRequest, ...kept } = usage;
  return kept;
};
