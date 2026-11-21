import { PAUSE_STOP_TEXT, type AgentSession, type AppToolRegistryPort } from "@gram/agents";
import {
  type RequestId,
  type QueueItemId,
  type ThreadId,
  type TurnId,
  fastSelectionProblem,
  InterruptHung,
  InvalidState,
  NotFound,
  AgentUnavailable,
  type ModelRef,
  type GitError,
  type QueuedInput,
  type Thread,
  LOCAL_HOST_ID,
  type ThreadNotFound,
  type ThreadSummary,
  type ThreadStatus,
  type Checkout,
  type WorktreeDirty,
  sessionHostOf,
  listedRow,
  profileAllowsModel,
} from "@gram/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import { randomUUID } from "node:crypto";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import { samePath } from "@gram/git";
import { McpTokens, mcpConnectionFor } from "../app-tools/mcp-tokens.ts";
import { ServerConfig } from "../config.ts";
import { TurnActivity } from "./turn-activity.ts";
import { makeCostLedger } from "./cost-ledger.ts";
import { ClaudeAiSeen } from "../connectors/claude-ai-seen.ts";
import { HttpServer } from "../platform/unstable.ts";
import { EventHub } from "../events/event-hub.ts";
import { ThreadPlans } from "../plans/service.ts";
import { ThreadWaits } from "../waits/service.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { ActivityTracker } from "./activity.ts";
import type { AgentHosts } from "./agent-hosts.ts";
import { restoreGateOf, WorkerHosts } from "../host/worker-host.ts";
import { RemoteHosts } from "../host/remote-hosts.ts";
import { makeAccountScopes } from "./account-scopes.ts";
import { ephemeralAccountScope } from "../usage/account-scope.ts";
import { ownedRuntimes } from "./owned-runtimes.ts";
import { asRecorded, fromStored, mayReachThread, type StoredActor } from "../host/ownership.ts";
import { type CheckoutService, TurnHooks } from "./hooks.ts";
import { turnsHere } from "./turns-here.ts";
import { accountOf, type EarlyReleases, type ReleaseWave } from "./limit-wait.ts";
import { makeRateLimitGate } from "./rate-limits.ts";
import { UsageLimitReadings } from "../usage/limit-readings.ts";
import { RETRIES_EXHAUSTED } from "./thread-error.ts";
import type { CloseThreadOptions, ThreadRuntimesShape } from "./thread-runtimes-shape.ts";
import { browserNotReady } from "./browser-status.ts";

const BROWSER_READY_TIMEOUT = Duration.seconds(3);
import { makeDurableWork } from "../durable-work.ts";
import type { RuntimeObserver } from "./runtime-observer.ts";
import { makeSessionPolicy } from "./session-policy.ts";
import type { ResumeHold, QueueHold, TurnHold } from "./turn-holds.ts";
import { makeSessionRestarts, makeRestartMethods } from "./session-restarts.ts";
import { KeptSessions } from "./kept-sessions.ts";
import { notInFlight } from "./user-input.ts";
import { makeResumePlans, makeHistoryMethods } from "./history-plans.ts";
import {
  type ServerApprovalRequest,
  makeServerApprovals,
  makeApprovalMethods,
} from "./server-approvals.ts";
import { retryFacts, RETRY_DEADLINE } from "./retrying.ts";
import {
  type Turn,
  type StopClaim,
  stopHeld,
  type Runtime,
  BUSY,
  makeTurnId,
  locked,
  evictable,
  NOTHING_RUNNING,
  guarded,
  replyOf,
  type GetRuntime,
} from "./runtime-state.ts";
import { makeFeedWriter, makeFeedMethods, unsettledIn } from "./feed-writer.ts";
import { makeLimitResume, makeLimitMethods } from "./limit-resume.ts";
import { makeTurnLifecycle } from "./turn-lifecycle.ts";
import { makeMessageQueue, makeQueueMethods } from "./message-queue.ts";
import { makeThreadLifecycle, makeCloseMethods } from "./thread-lifecycle.ts";
import { makeAgentEvents } from "./agent-events.ts";
import { SharedFolders } from "../shared/shared-folders.ts";
import { DecisionHook } from "../embedding/decision-hook.ts";
import { EventSink } from "../embedding/event-sink.ts";
import { makeHookedRequests } from "../embedding/hooked-requests.ts";
import { makeSessionSwitch, makeSwitchMethods } from "./session-switch.ts";
import { AGENT_NAMES } from "./agent-names.ts";
import { checkFreshTarget, checkProfileModel, makeAgentSwitch } from "./agent-switch.ts";
import { selectableModels } from "./model-efforts.ts";
import { makeSessionLifecycle } from "./session-lifecycle.ts";
import type { InputUndelivered } from "./undelivered.ts";

const RELOCATABLE: ReadonlySet<ThreadStatus> = new Set(["cold", "idle", "error", "starting"]);
const MOVED_MEANWHILE = "the thread was placed elsewhere meanwhile";

export {
  type CreateThreadInput,
  type ClaimGuard,
  type CloseThreadOptions,
  type RewindPlan,
  type ForkPlan,
  type ForkOptions,
  type JoinQueued,
  type JoinResult,
  type NoticeResult,
  type ThreadRuntimesShape,
} from "./thread-runtimes-shape.ts";
export {
  type SystemDeliveryFailure,
  type DeliveryRest,
  type SystemDelivery,
} from "./system-delivery.ts";
export { type ObservedTurnEnd, type RuntimeObserver } from "./runtime-observer.ts";
export { type SessionPolicy, type SessionPolicyPort } from "./session-policy.ts";
export { type ResumeHold, type QueueHold, type TurnHold } from "./turn-holds.ts";
export {
  type McpConfigChange,
  mcpChangeReaches,
  type RestartReadiness,
  restartReady,
  isRestartMarker,
  BACKGROUND_SETTLE,
} from "./session-restarts.ts";
export { beforeHandoff } from "./history-plans.ts";
export { type ServerApprovalAnswer } from "./server-approvals.ts";
export { retryFacts, RETRY_DEADLINE } from "./retrying.ts";
export { RESUME_MAX_MESSAGES, BACKGROUND_OUTPUT_CHARS } from "./runtime-state.ts";

/** What a paused agent is told: its closed tool gate's refusal, or with no gate, steered in. */
export { PAUSE_STOP_TEXT };

export class ThreadRuntimes extends Context.Service<ThreadRuntimes, ThreadRuntimesShape>()(
  "@gram/server/ThreadRuntimes",
) {
  /**
   * With the plan writer the runtimes store agent plans through, which other services use too, and
   * the writer of what waits on the user, whose items the summaries carry.
   */
  static readonly layer: Layer.Layer<
    ThreadRuntimes | ThreadPlans | ThreadWaits | TurnActivity,
    never,
    ThreadStore | EventHub | WorkerHosts | ServerConfig | TurnHooks
  > = Layer.effect(
    ThreadRuntimes,
    Effect.suspend(() => make),
  ).pipe(
    Layer.provideMerge(Layer.mergeAll(ThreadPlans.layer, ThreadWaits.layer, TurnActivity.layer)),
  );

  /**
   * `layer` on this machine's host alone, for tests: built from the agent hosts and checkout
   * service, and whichever of the host's other parts the test layer provides.
   */
  static readonly layerOnLocalHost: Layer.Layer<
    ThreadRuntimes | ThreadPlans | ThreadWaits | TurnActivity | WorkerHosts,
    never,
    ThreadStore | EventHub | AgentHosts | ServerConfig | TurnHooks | CheckoutService
  > = ThreadRuntimes.layer.pipe(Layer.provideMerge(WorkerHosts.layerLocalForTests));
}

interface InFlightSend {
  readonly rt: Runtime;
  readonly published?: boolean;
}

interface Handover<E> {
  readonly started: Exit.Exit<void, E>;
  readonly refused?: true;
}

const otherAgentRefusal = (
  threadId: ThreadId,
  current: ModelRef,
  next: ModelRef,
): InvalidState | undefined =>
  next.agent === current.agent
    ? undefined
    : new InvalidState({
        threadId,
        message: `${next.model} is a ${AGENT_NAMES[next.agent]} model and this thread runs in ${AGENT_NAMES[current.agent]}. A model change stays on the thread's agent.`,
      });

const make = Effect.gen(function* () {
  const store = yield* ThreadStore;
  const hub = yield* EventHub;
  const plans = yield* ThreadPlans;
  const waits = yield* ThreadWaits;
  const turnActivity = yield* TurnActivity;
  const workerHosts = yield* WorkerHosts;
  const remoteHosts = Option.getOrUndefined(yield* Effect.serviceOption(RemoteHosts));
  const { sessions: hosts, checkouts, git } = workerHosts.placed;
  const limitReadings = yield* Effect.serviceOption(UsageLimitReadings);
  const accountScopes = makeAccountScopes(
    workerHosts.local.sessions,
    yield* store.listThreads,
    Option.isSome(limitReadings) && limitReadings.value.scopeFor !== undefined
      ? limitReadings.value.scopeFor
      : ephemeralAccountScope(),
    (thread) => workerHosts.get(sessionHostOf(thread)).pipe(Effect.map((host) => host.sessions)),
    (account) => startRelease(account),
  );
  const { scopeFor: accountScopeFor, quotaFor } = accountScopes;
  const config = yield* ServerConfig;
  const hooks = turnsHere(yield* TurnHooks, store);
  const sessions = yield* FiberMap.make<ThreadId>();
  let shuttingDown = false;
  const switchGenerations = new Map<ThreadId, string>();
  const switchConfigLock = yield* Semaphore.make(1);
  let shutdownFailed = false;
  const idleTimers = yield* FiberMap.make<ThreadId>();
  const quietTimers = yield* FiberMap.make<ThreadId>();
  const reopens = yield* FiberMap.make<ThreadId>();
  const restartChecks = yield* FiberMap.make<ThreadId>();
  const folderStops = yield* FiberMap.make<ThreadId>();
  const recoveries = yield* FiberMap.make<ThreadId, void, never>();
  const closes = yield* FiberMap.make<
    ThreadId,
    void,
    ThreadNotFound | GitError | WorktreeDirty | InvalidState
  >();
  const runningCloses = new Map<
    ThreadId,
    {
      readonly fiber: Fiber.Fiber<void, ThreadNotFound | GitError | WorktreeDirty | InvalidState>;
      readonly options: CloseThreadOptions;
    }
  >();
  const closeLock = yield* Semaphore.make(1);
  const closeReleases = yield* FiberSet.make();
  const seenConnectors = yield* ClaudeAiSeen;
  const recordSeen = yield* FiberSet.makeRuntime();
  const rateLimitShown = makeRateLimitGate();
  const serverRequests = new Map<RequestId, ServerApprovalRequest>();
  const serverApprovalOrigins = new Map<RequestId, ThreadId>();
  const activityTimers = yield* FiberMap.make<ThreadId>();
  const retryDeadlines = yield* FiberMap.make<ThreadId>();
  const retryStops = yield* FiberMap.make<ThreadId>();
  const limitTimers = yield* FiberMap.make<ThreadId>();
  const decisions = Option.getOrUndefined(yield* Effect.serviceOption(DecisionHook));
  const sharedFolders = Option.getOrUndefined(yield* Effect.serviceOption(SharedFolders));
  const eventSink = Option.getOrUndefined(yield* Effect.serviceOption(EventSink));
  const hooked = makeHookedRequests();
  const decisionCalls = yield* FiberSet.make();
  const forkDecision = (decision: Effect.Effect<void>) =>
    FiberSet.run(decisionCalls, decision).pipe(Effect.asVoid);
  const resumeHolds = new Set<ResumeHold>();
  const queueHolds = new Set<QueueHold>();
  const turnHolds = new Set<TurnHold>();
  const releaseWaves = new Map<string, ReleaseWave>();
  const limitHits = new Map<string, number>();
  const hitResets = new Map<string, number>();
  const earlyReleases = new Map<string, EarlyReleases>();
  const releasing = yield* FiberMap.make<string>();
  const releaseLock = yield* Semaphore.make(1);
  const runtimes = new Map<ThreadId, Runtime>();
  if (eventSink !== undefined) yield* eventSink.setStreaming(unsettledIn(runtimes));
  const registryLock = yield* Semaphore.make(1);
  let appTools: AppToolRegistryPort | undefined;
  const observers = new Set<RuntimeObserver>();
  const callbacks = yield* Queue.unbounded<Effect.Effect<void>>();
  yield* Queue.take(callbacks).pipe(
    Effect.flatMap((callback) => callback),
    Effect.forever,
    Effect.forkScoped,
  );
  const dispatch = (threadId: ThreadId, what: string, callback: Effect.Effect<void>) =>
    Queue.offer(callbacks, guarded(threadId, what, callback)).pipe(Effect.asVoid);
  const notifyObservers = (
    threadId: ThreadId,
    name: keyof RuntimeObserver,
    call: (observer: RuntimeObserver) => Effect.Effect<void> | undefined,
  ) =>
    Effect.forEach(
      [...observers],
      (observer) => {
        const callback = call(observer);
        return callback === undefined
          ? Effect.void
          : dispatch(threadId, `runtime observer ${name}`, callback);
      },
      { discard: true },
    );

  const {
    policyFor,
    opening,
    modeAfterSwitch,
    switchHandoff,
    methods: policyMethods,
  } = makeSessionPolicy({ store });
  const mcpTokens = yield* Effect.serviceOption(McpTokens);
  const httpServer = yield* Effect.serviceOption(HttpServer.HttpServer);
  const mcpEndpoint = (threadId: ThreadId) =>
    Option.isSome(mcpTokens) && Option.isSome(httpServer)
      ? mcpConnectionFor(threadId).pipe(
          Effect.provideService(McpTokens, mcpTokens.value),
          Effect.provideService(HttpServer.HttpServer, httpServer.value),
          Effect.map(Option.some),
        )
      : Effect.succeed(Option.none());

  const kept = Option.getOrUndefined(yield* Effect.serviceOption(KeptSessions)) ?? KeptSessions.off;
  yield* store.clearRequests();
  const cutOff = yield* store.closeOpenTurns(yield* Clock.currentTimeMillis, kept.survivors);
  const withdrawn = yield* store.deleteQueuedMessages();
  if (withdrawn > 0) {
    yield* Effect.logInfo("withdrew messages the previous run never sent").pipe(
      Effect.annotateLogs({ messages: withdrawn }),
    );
  }
  if (cutOff.length > 0) {
    yield* Effect.logInfo("closed turns the previous run left open").pipe(
      Effect.annotateLogs({ turns: cutOff.length }),
    );
  }
  yield* Effect.forEach(
    cutOff,
    (turn) =>
      store.getThread(turn.threadId).pipe(
        Effect.flatMap((thread) =>
          hooks.onTurnEnd(turn.threadId, turn.id, thread.checkout.path, "interrupted", false),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("end checkpoint for a cut-off turn failed").pipe(
            Effect.annotateLogs({ threadId: turn.threadId, cause: Cause.pretty(cause) }),
          ),
        ),
      ),
    { discard: true },
  );

  const getRuntime: GetRuntime = (threadId) =>
    Effect.suspend(() => {
      const existing = runtimes.get(threadId);
      if (existing !== undefined) return Effect.succeed(existing);
      return registryLock.withPermits(1)(
        Effect.gen(function* () {
          const raced = runtimes.get(threadId);
          if (raced !== undefined) return raced;
          const thread = yield* store.getThread(threadId);
          const usage = yield* store.lastTurnUsage(threadId);
          const listed = yield* store.listQueue(threadId);
          const stored: Array<(typeof listed)[number]> = [];
          for (const item of listed) {
            const may = yield* asRecorded(fromStored(item.actor))(
              mayReachThread(store.getThread, workerHosts.ownerOf, threadId),
            );
            if (may) stored.push(item);
            else
              yield* Effect.logWarning("a queued input not sent: its writer may not reach it").pipe(
                Effect.annotateLogs({ threadId, itemId: item.id }),
              );
          }
          if (stored.length !== listed.length) yield* store.putQueue(threadId, stored);
          const noticeKeys = new Map<QueueItemId, string>();
          const actors = new Map<QueueItemId, StoredActor>();
          for (const item of stored) {
            if (item.noticeKey !== undefined) noticeKeys.set(item.id, item.noticeKey);
            if (item.actor !== undefined) actors.set(item.id, item.actor);
          }
          const rt: Runtime = {
            threadId,
            lock: yield* Semaphore.make(1),
            feedLock: yield* Semaphore.make(1),
            status: "cold",
            session: undefined,
            sessionBrowser: false,
            quota: undefined,
            profileId: undefined,
            limitWait: thread.limitWait,
            resumedFrom: undefined,
            admitted: false,
            capabilities: undefined,
            identity: undefined,
            usage,
            cost: makeCostLedger(usage?.costUsd),
            cwd: undefined,
            queue: stored.map((item) => {
              const { noticeKey, actor: _actor, ...queued } = item;
              return noticeKey === undefined || queued.input.author !== undefined
                ? queued
                : { ...queued, input: { ...queued.input, author: "server" as const } };
            }),
            launch: undefined,
            inFlight: undefined,
            queuedAt: new Map(),
            noticeKeys,
            actors,
            turn: undefined,
            open: new Map(),
            remoteCalls: new Set(),
            stopAtBoundary: undefined,
            touchedRemote: false,
            seq: 0,
            stopping: undefined,
            closing: false,
            reserved: false,
            endedReason: undefined,
            restartedMachine: undefined,
            lostMachine: undefined,
            machineRestart: undefined,
            stopAsked: undefined,
            reopenOnIdle: false,
            restartMarker: undefined,
            lostSession: undefined,
            pendingRestart: undefined,
            tasksEndedAt: undefined,
            agentRunning: false,
            reopening: false,
            deliveries: new Map(),
            carrying: undefined,
            noteHeard: undefined,
            retrying: false,
            agent: undefined,
            activity: new ActivityTracker(),
            background: [],
            backgroundOutput: new Map(),
            lapsedConnectors: [],
            lastProgressAt: 0,
            lastTool: undefined,
            runningTools: new Set(),
            toolTimes: new Map(),
            steerSplit: undefined,
            replyAliases: new Map(),
            quiet: undefined,
            compaction: undefined,
            activityPublished: undefined,
            activityPublishedAt: 0,
          };
          runtimes.set(threadId, rt);
          return rt;
        }),
      );
    });

  const {
    publishMessage,
    replaceFeed,
    withdrawMessage,
    appendChunkLocked,
    flushUnsaved,
    appendChunk,
    appendDataPart,
    closeOpenMessages,
    stampTurnEnd,
    closeLanes,
  } = makeFeedWriter({
    store,
    hub,
    notifyObservers,
    searchRefreshes: yield* FiberMap.make<string>(),
  });

  const {
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
  } = makeTurnLifecycle({
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
    setRetrying: (rt, retrying, detail) => setRetrying(rt, retrying, detail),
    clearPendingRequests: (rt, reason) => clearPendingRequests(rt, reason),
    ...(remoteHosts === undefined
      ? {}
      : {
          awayMachine: (thread: Thread) => {
            const id = sessionHostOf(thread);
            if (id === LOCAL_HOST_ID) return undefined;
            const machine = remoteHosts.machines.get(id);
            return machine === undefined || remoteHosts.origin(id) !== undefined
              ? undefined
              : machine.name;
          },
        }),
  });
  const setRetrying = (rt: Runtime, retrying: boolean, detail?: string) =>
    Effect.gen(function* () {
      if (rt.retrying === retrying) return;
      rt.retrying = retrying;
      const turnId = rt.turn?.id;
      if (retrying && turnId !== undefined) {
        yield* FiberMap.run(
          retryDeadlines,
          rt.threadId,
          Effect.sleep(config.retryDeadline ?? RETRY_DEADLINE).pipe(
            Effect.andThen(
              FiberMap.run(retryStops, rt.threadId, giveUpRetrying(rt, turnId), {
                onlyIfMissing: true,
              }),
            ),
          ),
        );
      } else {
        yield* FiberMap.remove(retryDeadlines, rt.threadId);
      }
      yield* Effect.logInfo(retrying ? "thread started retrying" : "thread stopped retrying").pipe(
        Effect.annotateLogs({
          threadId: rt.threadId,
          agent: rt.agent,
          ...(detail === undefined ? {} : retryFacts(rt.agent, detail)),
        }),
      );
      yield* notifyObservers(rt.threadId, "onRetrying", (observer) =>
        observer.onRetrying?.(rt.threadId, retrying),
      );
    });

  const {
    hitAt,
    limitedUntil,
    dropWaitForSwitch,
    limitWaitOf,
    enterWait,
    waitWithAccount,
    startRelease,
    scheduleAccount,
    queueHeld,
    queueHoldsFor,
    resumeWait,
    endWaitForUser,
    cancelLimitWait,
    turnHeld,
  } = makeLimitResume({
    quotaFor,
    accountChanged: accountScopes.changed,
    store,
    runtimes,
    getRuntime,
    notifyObservers,
    publishUpsert,
    limitReadings,
    limitTimers,
    limitHits,
    hitResets,
    earlyReleases,
    releasing,
    releaseLock,
    releaseWaves,
    resumeHolds,
    queueHolds,
    turnHolds,
    setStatus,
    recordFailure,
    isShuttingDown: () => shuttingDown,
    syncQueue: (rt) => syncQueue(rt),
    drainQueue: (rt) => drainQueue(rt),
    pumpDeliveries: (rt) => pumpDeliveries(rt),
    reopenWhenIdle: (rt) => reopenWhenIdle(rt),
  });

  if (Option.isSome(limitReadings)) {
    yield* limitReadings.value.changes.pipe(
      Stream.runForEach(() =>
        Effect.forEach(
          new Set(
            [...runtimes.values()].flatMap((each) =>
              each.limitWait?.kind === "limit" &&
              each.limitWait.cancelled !== true &&
              each.limitWait.cleared === undefined
                ? [each.limitWait.account]
                : [],
            ),
          ),
          (account) => startRelease(account),
          { discard: true },
        ),
      ),
      Effect.forkScoped,
    );
  }

  const giveUpRetrying = (rt: Runtime, turnId: TurnId): Effect.Effect<void> =>
    Effect.gen(function* () {
      const stuck = yield* locked(
        rt,
        Effect.gen(function* () {
          const turn = rt.turn;
          const session = rt.session;
          if (!rt.retrying || turn?.id !== turnId || session === undefined) return undefined;
          yield* Effect.logWarning("thread gave up retrying").pipe(
            Effect.annotateLogs({
              threadId: rt.threadId,
              agent: rt.agent,
              afterMs: Duration.toMillis(config.retryDeadline ?? RETRY_DEADLINE),
            }),
          );
          rt.retrying = false;
          yield* notifyObservers(rt.threadId, "onRetrying", (observer) =>
            observer.onRetrying?.(rt.threadId, false),
          );
          yield* clearPendingRequests(rt, "retry-deadline");
          const failed = yield* recordFailure(rt, RETRIES_EXHAUSTED, "", turnId);
          return { failed, replyId: replyOf(rt, turnId), session, turn };
        }),
      );
      if (stuck === undefined) return;
      yield* stuck.session.interrupt.pipe(
        Effect.andThen(Deferred.await(stuck.turn.done)),
        Effect.timeoutOrElse({
          duration: config.interruptWatchdog,
          orElse: () =>
            Effect.fail(
              new InterruptHung({ timeoutMs: Duration.toMillis(config.interruptWatchdog) }),
            ),
        }),
        Effect.catchTag("InterruptHung", () => recoverOwned(rt, turnId)),
        Effect.ignore,
      );
      yield* locked(
        rt,
        Effect.gen(function* () {
          yield* publishFailure(rt, stuck.failed, turnId, stuck.replyId);
          const settled =
            rt.turn === undefined &&
            rt.session === stuck.session &&
            rt.status === "idle" &&
            (yield* store.lastTurn(rt.threadId))?.id === turnId;
          if (settled) {
            rt.errorAtRest = { session: stuck.session, turnId };
            yield* setStatus(rt, "error", stuck.failed.text);
          }
        }),
      );
    });

  const {
    persistQueue,
    syncQueue,
    sendNow,
    steerNow,
    deliverNext,
    switchHold,
    pumpDeliveries,
    sendInput,
    send,
    userTyped,
    withQueue,
    drainQueue,
    withSession,
    refuseMissingFolder,
  } = makeMessageQueue({
    store,
    hub,
    waits,
    checkouts,
    observers,
    notifyObservers,
    dispatch,
    getRuntime,
    publishMessage,
    withdrawMessage,
    setStatus,
    openTurn,
    markRunning,
    markSessionUsed,
    settleDelivery,
    finishTurn,
    startIdleTimer,
    failPendingDeliveries,
    failUnavailable,
    waitWithAccount,
    endWaitForUser,
    queueHoldsFor,
    queueHeld,
    isShuttingDown: () => shuttingDown,
    openSession: (rt, thread, resumeAt, switchAttempt) =>
      openSession(rt, thread, resumeAt, switchAttempt),
    forkStopInMissing: (rt) => forkStopInMissing(rt),
    becomeIdle: (rt) => becomeIdle(rt),
    restoreGate:
      remoteHosts === undefined
        ? undefined
        : (thread) => restoreGateOf(remoteHosts.stops, sessionHostOf(thread), thread.id),
  });
  const unusedTurn = (rt: Runtime, turnId: TurnId | undefined) =>
    turnId === undefined
      ? Effect.sync(makeTurnId)
      : store
          .listTurns(rt.threadId)
          .pipe(
            Effect.map((turns) =>
              turns.some((turn) => turn.id === turnId) ? makeTurnId() : turnId,
            ),
          );

  type SendError = Exclude<Effect.Error<ReturnType<typeof sendNow>>, InputUndelivered>;
  const handover = makeDurableWork<
    InFlightSend,
    NonNullable<Runtime["inFlight"]> & { readonly sent?: Handover<SendError> },
    Handover<SendError>
  >({
    lockKey: (handed) => handed.rt.threadId,
    read: (handed) => Effect.sync(() => handed.rt.inFlight),
    owed: (item) => item.sent === undefined,
    actor: (item, { rt }) => Effect.succeed(fromStored(rt.actors.get(item.id))),
    perform: (item, _retry, { rt, published }) =>
      Effect.gen(function* () {
        if (rt.session === undefined) return undefined;
        if (!(yield* mayReachThread(store.getThread, workerHosts.ownerOf, rt.threadId))) {
          yield* Effect.logWarning("a queued input not sent: its writer may not reach it").pipe(
            Effect.annotateLogs({ threadId: rt.threadId, itemId: item.id }),
          );
          if (published === true) yield* withdrawMessage(rt, item.id);
          rt.actors.delete(item.id);
          return { started: Exit.void, refused: true as const };
        }
        const started = yield* Effect.exit(
          sendNow(rt, rt.session, item.input, {
            turnId: item.turnId,
            messageId: item.id,
            ...(published === undefined ? {} : { published }),
          }).pipe(Effect.catchTag("InputUndelivered", () => Effect.void)),
        );
        return { started };
      }),
    markDone: (item, sent, { rt }) =>
      Effect.gen(function* () {
        rt.inFlight = undefined;
        yield* persistQueue(rt);
        return { ...item, sent };
      }),
  });

  const sendInFlight = (handed: InFlightSend) =>
    handover
      .attempt(handed, false)
      .pipe(
        Effect.flatMap((item) =>
          item?.sent === undefined
            ? Effect.die("no input was in flight")
            : Effect.succeed(item.sent),
        ),
      );

  const becomeIdle = (rt: Runtime): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (rt.reopening) return;
      if ((yield* switchHold(rt)) !== undefined) {
        yield* setStatus(rt, "idle");
        return yield* pumpDeliveries(rt);
      }
      if (shuttingDown) return yield* setStatus(rt, "idle");
      const launched = rt.reopenOnIdle ? undefined : rt.launch;
      if (launched !== undefined && rt.session !== undefined) {
        const turnId = yield* unusedTurn(rt, launched.turnId);
        rt.launch = undefined;
        rt.inFlight = { ...launched, turnId };
        yield* persistQueue(rt);
        const { started, refused } = yield* sendInFlight({
          rt,
          published: turnId === launched.turnId,
        });
        if (refused !== true) {
          if (Exit.isSuccess(started)) return;
          if (rt.turn !== undefined) yield* finishTurn(rt, "interrupted", "sendFailed");
        }
      }
      yield* setStatus(rt, "idle");
      if (rt.reopenOnIdle) {
        if (rt.pendingRestart !== undefined) {
          rt.restartMarker ??= rt.pendingRestart;
          yield* setPendingRestart(rt, undefined);
        }
        return yield* reopenWhenIdle(rt);
      }
      if (stopHeld(rt)) return;
      if (rt.limitWait !== undefined) return yield* startIdleTimer(rt);
      if (yield* queueHeld(rt)) return yield* startIdleTimer(rt);
      const archived = (item: QueuedInput | undefined) =>
        item !== undefined && rt.noticeKeys.has(item.id)
          ? store.getThread(rt.threadId).pipe(
              Effect.map((thread) => thread.parked),
              Effect.orElseSucceed(() => false),
            )
          : Effect.succeed(false);
      const held = rt.session !== undefined && (yield* archived(rt.queue[0]));
      const next = rt.session === undefined || held ? undefined : rt.queue.shift();
      if (next !== undefined) {
        rt.inFlight = { ...next, turnId: yield* unusedTurn(rt, next.turnId) };
        yield* syncQueue(rt);
      }
      if (held) {
        yield* startIdleTimer(rt);
      } else if (next !== undefined && (yield* archived(next))) {
        rt.inFlight = undefined;
        rt.queue.unshift(notInFlight(next));
        yield* syncQueue(rt);
        yield* startIdleTimer(rt);
      } else if (next !== undefined && rt.session !== undefined && rt.inFlight !== undefined) {
        const { started, refused } = yield* sendInFlight({ rt });
        if (refused === true) return yield* becomeIdle(rt);
        if (Exit.isFailure(started)) return yield* Effect.failCause(started.cause);
      } else if (rt.session === undefined || !(yield* deliverNext(rt, rt.session))) {
        yield* startIdleTimer(rt);
        yield* restartIfPending(rt);
      }
    });

  const { handleEvent, setBackground, setLapsedConnectors } = makeAgentEvents({
    rememberAccount: accountScopes.remember,
    store,
    hub,
    decisions,
    hooked,
    serverRaised: (requestId) => serverApprovalOrigins.has(requestId),
    eventSink,
    forkDecision,
    config,
    hooks,
    checkouts,
    plans,
    hosts,
    runtimes,
    notifyObservers,
    limitReadings,
    earlyReleases,
    rateLimitShown,
    restartChecks,
    appendChunk,
    appendChunkLocked,
    appendDataPart,
    publishUpsert,
    setStatus,
    clearQuiet,
    scheduleActivity,
    startIdleTimer,
    openTurn,
    markRunning,
    settleDelivery,
    noteDeliveryStart,
    settleNote,
    recordFailure,
    keepError,
    finishTurn,
    publishFailure,
    turnHeld,
    limitWaitOf,
    queueHeld,
    switchHold,
    hitAt,
    startRelease,
    enterWait,
    scheduleAccount,
    setRetrying,
    becomeIdle,
    forkStopInMissing: (rt) => forkStopInMissing(rt),
    restartIfPending: (rt) => restartIfPending(rt),
    reopenWhenIdle: (rt) => reopenWhenIdle(rt),
    reopenNow: (rt) => reopenNow(rt),
    beginBoundaryStop: (rt, session, turn) => beginBoundaryStop(rt, session, turn),
    setCurrentCheckout: (threadId, checkout) => setCurrentCheckout(threadId, checkout),
  });
  const { reloadHostConfig, setPendingRestart, restartIfPending, reopenWhenIdle, reopenNow } =
    makeSessionRestarts({
      store,
      hub,
      hosts,
      runtimes,
      dispatch,
      reopens,
      setStatus,
      stopSession,
      failUnavailable,
      openSession: (rt, thread, resumeAt, switchAttempt) =>
        openSession(rt, thread, resumeAt, switchAttempt),
    });

  const { clearPendingRequests, requestApproval, respond } = makeServerApprovals({
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
  });
  const { resumeOptions } = makeResumePlans({
    store,
  });

  const { stopInMissing, forkStopInMissing, openSession, recoverOwned } = makeSessionLifecycle({
    accountScopeFor,
    limitReadings,
    store,
    decisions,
    hub,
    checkouts,
    hosts,
    sessions,
    folderStops,
    recoveries,
    activityTimers,
    seenConnectors,
    recordSeen,
    mcpEndpoint,
    withdrawMessage,
    appendChunkLocked,
    closeOpenMessages,
    closeLanes,
    flushUnsaved,
    appendDataPart,
    syncQueue,
    stopSession,
    recordFailure,
    finishTurn,
    publishFailure,
    setStatus,
    failUnavailable,
    publishUpsert,
    setRetrying,
    clearPendingRequests,
    policyFor,
    opening,
    setPendingRestart,
    resumeOptions,
    handleEvent,
    setBackground,
    setLapsedConnectors,
    isShuttingDown: () => shuttingDown,
    markShutdownFailed: () => {
      shutdownFailed = true;
    },
    sharedFolder: (thread) =>
      sharedFolders === undefined ? Effect.succeed(undefined) : sharedFolders.forSession(thread),
    currentAppTools: () => appTools,
  });
  const { claimClose, settleClose, guardHolds, restsNow, create } = makeThreadLifecycle({
    eventSink,
    store,
    hub,
    checkouts,
    hosts,
    plans,
    mcpTokens,
    runtimes,
    getRuntime,
    sessions,
    recoveries,
    closes,
    runningCloses,
    closeLock,
    setStatus,
    publishUpsert,
    cancelIdleTimer,
    stopSession,
    failPendingDeliveries,
    send,
    openSession: (rt, thread, resumeAt, switchAttempt) =>
      openSession(rt, thread, resumeAt, switchAttempt),
  });
  const claimStop = (rt: Runtime, turnId?: TurnId): Effect.Effect<StopClaim | undefined> =>
    Effect.gen(function* () {
      if (rt.session === undefined) return undefined;
      if (turnId !== undefined && rt.turn?.id !== turnId) return undefined;
      if (rt.turn === undefined) return { background: rt.session };
      yield* clearPendingRequests(rt, "stop-requested");
      rt.stopAsked = rt.turn.id;
      rt.stopsPending = (rt.stopsPending ?? 0) + 1;
      return { session: rt.session, turn: rt.turn };
    });

  const runStop = (rt: Runtime, target: StopClaim) =>
    Effect.gen(function* () {
      if ("background" in target) {
        yield* target.background.stopBackgroundTasks ?? Effect.void;
        return;
      }
      const turnId = target.turn.id;
      yield* Effect.gen(function* () {
        if (yield* Deferred.isDone(target.turn.done)) return;
        yield* target.session.interrupt.pipe(
          Effect.andThen(Deferred.await(target.turn.done)),
          Effect.timeoutOrElse({
            duration: config.interruptWatchdog,
            orElse: () =>
              Effect.fail(
                new InterruptHung({ timeoutMs: Duration.toMillis(config.interruptWatchdog) }),
              ),
          }),
          Effect.catchTag("InterruptHung", () => recoverOwned(rt, turnId)),
        );
      }).pipe(
        Effect.ensuring(
          locked(
            rt,
            Effect.gen(function* () {
              rt.stopsPending = Math.max(0, (rt.stopsPending ?? 0) - 1);
              if (stopHeld(rt)) return;
              if (rt.turn === undefined && rt.session !== undefined && rt.status === "idle")
                yield* becomeIdle(rt);
              else if (rt.queue.length > 0 || rt.launch !== undefined) yield* drainQueue(rt);
              else yield* pumpDeliveries(rt);
            }),
          ),
        ),
      );
    });

  const interrupt: ThreadRuntimesShape["interrupt"] = (threadId, options) =>
    Effect.gen(function* () {
      const rt = yield* getRuntime(threadId);
      const target = yield* locked(rt, claimStop(rt, options?.turnId));
      if (options?.endLimitWait === true) yield* cancelLimitWait(threadId);
      if (target !== undefined) yield* runStop(rt, target);
    });

  const beginBoundaryStop = (rt: Runtime, session: AgentSession, turn: Turn): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (rt.turn?.id !== turn.id || rt.session !== session) return;
      rt.stopAtBoundary = turn.id;
      if (session.closeToolGate !== undefined) return yield* session.closeToolGate;
      if (rt.capabilities?.steer !== true) return;
      const asked = yield* steerNow(rt, session, turn, { text: PAUSE_STOP_TEXT }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("couldn't ask a paused agent to end its turn").pipe(
            Effect.annotateLogs({ threadId: rt.threadId, cause: Cause.pretty(cause) }),
            Effect.as(true),
          ),
        ),
      );
      if (!asked) {
        yield* Effect.logWarning("a paused agent refused the request to end its turn").pipe(
          Effect.annotateLogs({ threadId: rt.threadId }),
        );
      }
    });

  const stopAtToolBoundary: ThreadRuntimesShape["stopAtToolBoundary"] = (threadId) =>
    Effect.gen(function* () {
      const rt = yield* getRuntime(threadId);
      return yield* locked(
        rt,
        Effect.gen(function* () {
          const session = rt.session;
          const turn = rt.turn;
          if (session === undefined || turn === undefined) return false;
          yield* Effect.logInfo("thread stops at its next tool boundary").pipe(
            Effect.annotateLogs({ threadId, gated: session.closeToolGate !== undefined }),
          );
          yield* beginBoundaryStop(rt, session, turn);
          return true;
        }),
      );
    });

  const stopTask: ThreadRuntimesShape["stopTask"] = (threadId, taskId) =>
    Effect.gen(function* () {
      const rt = yield* getRuntime(threadId);
      const session = yield* locked(
        rt,
        Effect.sync(() =>
          rt.background.some((task) => task.taskId === taskId) ? rt.session : undefined,
        ),
      );
      const notFound = new NotFound({ entity: "backgroundTask", id: taskId });
      if (session === undefined) return yield* Effect.fail(notFound);
      if (session.stopTask === undefined) {
        return yield* Effect.fail(
          new InvalidState({ message: "This agent can't stop a background task", threadId }),
        );
      }
      if (!(yield* session.stopTask(taskId))) return yield* Effect.fail(notFound);
    });

  const setCurrentCheckout: ThreadRuntimesShape["setCurrentCheckout"] = (threadId, checkout) =>
    Effect.gen(function* () {
      const thread = yield* store.updateThread(threadId, ({ currentCheckout, ...rest }) => {
        void currentCheckout;
        return checkout === undefined || samePath(checkout.path, rest.checkout.path)
          ? rest
          : { ...rest, currentCheckout: checkout };
      });
      yield* publishUpsert(thread);
      return thread;
    });

  let switchUnarchived: ((threadId: ThreadId) => Effect.Effect<void>) | undefined;

  const markAgentSession = (thread: Thread) =>
    Effect.gen(function* () {
      const agentSessionId = thread.agentSessionId;
      if (agentSessionId === undefined || thread.checkout.hostId !== undefined) return;
      const host = yield* hosts.get(thread.model.agent).pipe(Effect.option);
      const mark = Option.getOrUndefined(host)?.setSessionArchived;
      if (mark === undefined) return;
      yield* dispatch(
        thread.id,
        "agent session archive mark",
        mark({ cwd: thread.checkout.path, agentSessionId, archived: thread.parked }).pipe(
          Effect.catch((error) =>
            Effect.logDebug("agent session archive mark skipped").pipe(
              Effect.annotateLogs({ threadId: thread.id, message: error.message }),
            ),
          ),
        ),
      );
    });

  const updateThread: ThreadRuntimesShape["updateThread"] = (
    threadId,
    f,
    authorityCaller,
    claimScan,
  ) =>
    Effect.gen(function* () {
      const before = yield* store.getThread(threadId);
      const thread = yield* store.updateThread(threadId, f, authorityCaller, claimScan);
      yield* publishUpsert(thread);
      const unarchived = before.parked && !thread.parked;
      if (before.parked !== thread.parked) yield* markAgentSession(thread);
      if (unarchived && switchUnarchived !== undefined) yield* switchUnarchived(threadId);
      const rt =
        runtimes.get(threadId) ??
        (unarchived && (yield* store.listQueue(threadId)).length > 0
          ? yield* getRuntime(threadId)
          : undefined);
      if (rt === undefined) return thread;
      if (unarchived) {
        yield* locked(rt, drainQueue(rt));
      } else if (thread.parked && !before.parked) {
        const idle = yield* locked(
          rt,
          Effect.sync(
            () =>
              rt.status === "idle" && !rt.activity.subagentsRunning && rt.background.length === 0,
          ),
        );
        if (idle) yield* stopSession(rt, "evict");
      } else if (thread.pinned !== before.pinned) {
        if (thread.pinned) {
          yield* cancelIdleTimer(rt);
        } else {
          yield* locked(
            rt,
            rt.status === "idle" && rt.session !== undefined ? startIdleTimer(rt) : Effect.void,
          );
        }
      }
      return thread;
    });

  const summary = (thread: Thread) =>
    Effect.gen(function* () {
      const rt = runtimes.get(thread.id);
      const pendingRequests = yield* store.listRequests(thread.id);
      const hostCapabilities =
        rt?.capabilities ??
        (yield* hosts.get(thread.model.agent).pipe(
          Effect.map((host) => host.capabilities),
          Effect.orElseSucceed(() => undefined),
        ));
      const live =
        rt === undefined
          ? {
              status: "cold" as const,
              queue: yield* store.listQueue(thread.id),
              capabilities: hostCapabilities,
              identity: undefined,
              usage: undefined,
              background: [],
              backgroundOutput: [],
              pendingRestart: undefined,
              lapsedConnectors: [],
              activity: undefined,
              compaction: undefined,
            }
          : yield* locked(
              rt,
              Effect.sync(() => ({
                status: rt.status,
                queue: [...rt.queue],
                capabilities: rt.capabilities ?? hostCapabilities,
                identity: rt.identity,
                usage: rt.usage,
                background: rt.background,
                backgroundOutput: [...rt.backgroundOutput.values()],
                pendingRestart: rt.pendingRestart,
                lapsedConnectors: rt.lapsedConnectors,
                activity:
                  BUSY.has(rt.status) || rt.activity.subagentsRunning
                    ? rt.activity.line
                    : undefined,
                compaction: rt.compaction,
              })),
            );
      const activity = live.activity;
      const usage = live.usage ?? (yield* store.lastTurnUsage(thread.id));
      const { plan, turnPlan } = yield* plans.record(thread.id);
      const openWaits = yield* store.listWaits(thread.id);
      const helperResolved = yield* waits.helperResolved(thread.id);
      const result: ThreadSummary = {
        thread,
        status: live.status,
        pendingRequests,
        queue: live.queue,
        ...(activity === undefined ? {} : { activity }),
        ...(live.compaction === undefined ? {} : { compaction: live.compaction }),
        ...(live.capabilities === undefined ? {} : { capabilities: live.capabilities }),
        ...(live.identity === undefined ? {} : { identity: live.identity }),
        ...(usage === undefined ? {} : { usage }),
        ...(live.background.length === 0 ? {} : { background: live.background }),
        ...(live.backgroundOutput.length === 0 ? {} : { backgroundOutput: live.backgroundOutput }),
        ...(live.pendingRestart === undefined ? {} : { pendingRestart: live.pendingRestart }),
        ...(live.lapsedConnectors.length === 0 ? {} : { lapsedConnectors: live.lapsedConnectors }),
        ...(plan === undefined ? {} : { plan }),
        ...(turnPlan === undefined || turnPlan.length === 0 ? {} : { turnPlan }),
        ...(openWaits.length === 0 ? {} : { waits: openWaits }),
        ...(helperResolved.length === 0 ? {} : { helperResolved }),
      };
      return result;
    });

  const { switchSession, reopenSwitchTarget } = makeSessionSwitch({
    store,
    hosts,
    getRuntime,
    setStatus,
    stopSession,
    cancelIdleTimer,
    publishUpsert,
    isShuttingDown: () => shuttingDown,
    hasSessionFiber: (threadId) => FiberMap.hasUnsafe(sessions, threadId),
    drainQueue,
    modeAfterSwitch,
    openSession: (rt, thread, resumeAt, switchAttempt) =>
      openSession(rt, thread, resumeAt, switchAttempt),
  });
  const feedMethods = makeFeedMethods({
    store,
    runtimes,
    getRuntime,
    appendChunk,
    appendDataPart,
    publishMessage,
  });

  const limitMethods = makeLimitMethods({
    store,
    runtimes,
    getRuntime,
    limitTimers,
    resumeHolds,
    queueHolds,
    turnHolds,
    resumeWait,
    drainQueue,
  });

  const queueMethods = makeQueueMethods({
    store,
    runtimes,
    getRuntime,
    drainQueue,
    sendInput,
    userTyped,
    syncQueue,
    withSession,
    refuseMissingFolder,
    steerNow,
    withQueue,
    switchHold,
    pumpDeliveries,
    scheduleAccount,
    claimStop,
    runStop,
    paired: (id) => workerHosts.paired(id),
  });

  const closeMethods = makeCloseMethods({
    getRuntime,
    runningCloses,
    closeReleases,
    claimClose,
    settleClose,
    guardHolds,
    restsNow,
    pumpDeliveries,
  });

  const historyMethods = makeHistoryMethods({
    store,
    hub,
    runtimes,
    config,
    getRuntime,
    stopSession,
    failUnavailable,
    publishUpsert,
    replaceFeed,
    openSession,
  });

  const approvalMethods = makeApprovalMethods({
    respond,
  });

  const restartMethods = makeRestartMethods({
    store,
    hub,
    checkouts,
    hosts,
    runtimes,
    getRuntime,
    sessions,
    switchGenerations,
    switchConfigLock,
    reloadHostConfig,
    setPendingRestart,
    restartIfPending,
    reopenWhenIdle,
    reopenNow,
    setStatus,
    stopSession,
    failUnavailable,
    publishUpsert,
    openSession,
    interrupt,
  });

  const switchMethods = makeSwitchMethods({
    store,
    getRuntime,
    switchGenerations,
    switchConfigLock,
    publishUpsert,
    drainQueue,
    becomeIdle,
    modeAfterSwitch,
  });

  const restSession: ThreadRuntimesShape["restSession"] = (threadId) =>
    Effect.gen(function* () {
      const rt = runtimes.get(threadId);
      if (rt === undefined) return "none";
      const rested = yield* stopSession(
        rt,
        "evict",
        () => evictable(rt) && rt.background.length === 0 && rt.queue.length === 0,
      );
      if (rested) return "rested";
      return yield* locked(
        rt,
        Effect.sync(() =>
          rt.session === undefined && rt.launch === undefined && NOTHING_RUNNING.has(rt.status)
            ? ("none" as const)
            : ("working" as const),
        ),
      );
    });

  const relocate: ThreadRuntimesShape["relocate"] = (threadId, plan) =>
    Effect.gen(function* () {
      const rt = yield* getRuntime(threadId);
      const busy = (message: string) => new InvalidState({ message, threadId, status: rt.status });
      yield* locked(
        rt,
        Effect.gen(function* () {
          if (rt.closing) return yield* busy("the thread is closing");
          if (rt.reserved) return yield* busy("the thread is being worked on");
          if (plan.endWork !== true && (rt.turn !== undefined || !RELOCATABLE.has(rt.status)))
            return yield* busy("the thread is at work");
          if (rt.status === "ended") return yield* busy("the thread has ended");
          if (!(yield* sameCheckout(threadId, plan.from))) return yield* busy(MOVED_MEANWHILE);
          rt.reserved = true;
        }),
      );
      const release = locked(
        rt,
        Effect.gen(function* () {
          rt.reserved = false;
          yield* pumpDeliveries(rt);
          yield* drainQueue(rt);
        }),
      );
      return yield* Effect.gen(function* () {
        yield* stopSession(rt, "evict");
        if (plan.endWork === true) {
          yield* locked(
            rt,
            rt.turn !== undefined && rt.session === undefined
              ? finishTurn(rt, "interrupted", "sessionExit")
              : Effect.void,
          );
        }
        const checkout = yield* plan.prepare;
        return yield* locked(
          rt,
          Effect.gen(function* () {
            if (
              rt.session !== undefined ||
              FiberMap.hasUnsafe(sessions, threadId) ||
              rt.turn !== undefined ||
              rt.launch !== undefined
            )
              return yield* busy("the thread started work on its old machine meanwhile");
            if (!(yield* sameCheckout(threadId, plan.from))) return yield* busy(MOVED_MEANWHILE);
            const thread = yield* store
              .updateThread(
                threadId,
                ({ currentCheckout: _current, awaitingMachine: _awaited, ...t }) => ({
                  ...t,
                  checkout,
                }),
              )
              .pipe(Effect.mapError(() => busy("the thread is gone")));
            yield* publishUpsert(thread);
            return thread;
          }),
        );
      }).pipe(Effect.ensuring(release));
    });

  const sameCheckout = (threadId: ThreadId, from: Checkout) =>
    store.getThread(threadId).pipe(
      Effect.map(
        (thread) =>
          thread.currentCheckout === undefined &&
          thread.checkout.path === from.path &&
          thread.checkout.hostId === from.hostId,
      ),
      Effect.orElseSucceed(() => false),
    );

  const switchSettles = yield* FiberSet.make<void>();
  const agentSwitch = makeAgentSwitch({
    store,
    hosts,
    hub,
    getRuntime,
    switches: yield* FiberMap.make<ThreadId>(),
    refuseMissingFolder,
    runtimes: {
      ...switchMethods,
      switchSession,
      emitChunk: feedMethods.emitChunk,
      updateDataPart: feedMethods.updateDataPart,
      updateThread,
      requestSystemDelivery: queueMethods.requestSystemDelivery,
    },
    afterRelease: (rt) =>
      locked(
        rt,
        Effect.gen(function* () {
          if (rt.turn !== undefined) return;
          yield* becomeIdle(rt);
          yield* drainQueue(rt);
        }),
      ),
    limitedUntil: (thread) =>
      Effect.gen(function* () {
        return yield* limitedUntil(
          yield* quotaFor(thread),
          yield* Clock.currentTimeMillis,
          thread.model.model,
        );
      }),
    endLimitWait: (rt, previous) => locked(rt, dropWaitForSwitch(rt, accountOf(previous))),
    reopenTarget: reopenSwitchTarget,
    background: (effect) => FiberSet.run(switchSettles, effect).pipe(Effect.asVoid),
    gitState: (cwd) => git.local(cwd),
    roleHandoff: switchHandoff,
  });
  switchUnarchived = agentSwitch.giveOwed;
  observers.add({ onTurnEnd: agentSwitch.onTurnEnd });
  yield* Effect.forEach(
    (yield* store.listThreads).filter((thread) => thread.sessionSwitch !== undefined),
    agentSwitch.resumeAtBoot,
    { discard: true },
  );

  const takeUpKept = Effect.forEach(
    [...kept.survivors],
    (threadId) =>
      Effect.gen(function* () {
        const rt = yield* getRuntime(threadId);
        const thread = yield* store.getThread(threadId);
        yield* locked(
          rt,
          Effect.gen(function* () {
            const open = yield* store.lastTurn(threadId);
            if (open !== undefined && open.endedAt === undefined)
              yield* openTurn(rt, open.id, { startedAt: open.startedAt });
            yield* openSession(rt, thread);
          }),
        );
        yield* Effect.logInfo("took up a session kept running after Gram quit").pipe(
          Effect.annotateLogs({ threadId }),
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("couldn't take up a session kept running after Gram quit").pipe(
            Effect.annotateLogs({ threadId, cause: Cause.pretty(cause) }),
            Effect.andThen(kept.discard(threadId)),
          ),
        ),
      ),
    { discard: true },
  );
  let takenUp = false;

  const service = ThreadRuntimes.of({
    ...switchMethods,
    restSession,
    relocate,
    switchSession,
    switchAgent: agentSwitch.switchAgent,
    switchNotePlan: agentSwitch.switchNotePlan,
    handOverSwitch: agentSwitch.handOverSwitch,
    cutAtBoot: cutOff,
    ...queueMethods,
    sendQueuedAtBoot: agentSwitch.handOverOwed.pipe(Effect.andThen(queueMethods.sendQueuedAtBoot)),
    create,
    stopTask,
    send,
    interrupt,
    stopAtToolBoundary,
    ...limitMethods,
    cancelLimitWait,
    stopInMissingFolder: (threadId) =>
      Effect.suspend(() => {
        const rt = runtimes.get(threadId);
        return rt === undefined ? Effect.void : stopInMissing(rt);
      }),
    setCurrentCheckout,
    respond,
    ...approvalMethods,
    requestApproval,
    session: (threadId) => withSession(threadId, (_rt, session) => Effect.succeed(session)),
    browserNotReadyOf: (threadId) =>
      Effect.gen(function* () {
        const rt = yield* getRuntime(threadId);
        const connectors = rt.session?.connectors;
        if (connectors === undefined || !rt.sessionBrowser) return undefined;
        const thread = yield* store.getThread(threadId);
        return yield* connectors.status.pipe(
          Effect.map((servers) => browserNotReady(thread.model.agent, servers)),
          Effect.timeoutOption(BROWSER_READY_TIMEOUT),
          Effect.map(Option.getOrUndefined),
          Effect.catchTag("AgentUnavailable", () => Effect.succeed(undefined)),
        );
      }),
    moveCheckout: (threadId, checkout) =>
      Effect.gen(function* () {
        const rt = yield* getRuntime(threadId);
        return yield* locked(
          rt,
          Effect.gen(function* () {
            const thread = yield* store.updateThread(threadId, ({ currentCheckout, ...t }) => {
              void currentCheckout;
              return { ...t, checkout };
            });
            yield* publishUpsert(thread);
            yield* reopenWhenIdle(rt);
            return thread;
          }),
        );
      }),
    addDirectories: (threadId, paths) =>
      Effect.gen(function* () {
        const rt = yield* getRuntime(threadId);
        return yield* locked(
          rt,
          Effect.gen(function* () {
            const thread = yield* store.updateThread(threadId, (t) => {
              const granted = [...(t.additionalDirectories ?? [])];
              for (const path of paths) {
                if (!granted.some((existing) => samePath(existing, path))) granted.push(path);
              }
              return { ...t, additionalDirectories: granted };
            });
            yield* publishUpsert(thread);
            const live = rt.session?.addDirectories;
            const applied =
              live === undefined ? false : yield* live(thread.additionalDirectories ?? []);
            if (!applied) yield* reopenWhenIdle(rt);
            return thread;
          }),
        );
      }),
    ...restartMethods,
    startFreshOn: (threadId, model) =>
      Effect.gen(function* () {
        const thread = yield* store.getThread(threadId);
        const to = AGENT_NAMES[model.agent];
        if (thread.role === "orchestrator")
          return yield* new InvalidState({
            threadId,
            message: "The orchestrator starts fresh from its own Fresh session or Settings.",
          });
        if (
          thread.model.agent === model.agent &&
          thread.model.model === model.model &&
          thread.model.profileId === model.profileId
        )
          return yield* new InvalidState({ threadId, message: `This thread already runs on it.` });
        if (thread.parked)
          return yield* new InvalidState({
            threadId,
            message: "Unarchive this thread before starting it fresh.",
          });
        if (thread.sessionSwitch !== undefined)
          return yield* new InvalidState({
            threadId,
            message: "Resolve this thread's switch before starting it fresh.",
          });
        const rt = yield* getRuntime(threadId);
        if (
          rt.turn !== undefined ||
          (rt.status !== "idle" && rt.status !== "cold" && rt.status !== "error")
        )
          return yield* new InvalidState({
            threadId,
            message: "Wait for this turn to finish, or stop it, then start fresh.",
          });
        if (rt.background.length > 0 || rt.activity.subagentsRunning)
          return yield* new InvalidState({
            threadId,
            message: `${AGENT_NAMES[thread.model.agent]} still has background work running.`,
          });
        yield* checkFreshTarget(store, hosts, model, thread);
        if (thread.mode === "plan" && model.agent !== thread.model.agent) {
          const host = yield* hosts
            .get(model.agent)
            .pipe(Effect.mapError((e) => new InvalidState({ threadId, message: e.message })));
          if (!host.capabilities.planMode)
            return yield* new InvalidState({
              threadId,
              message: `${to} can't keep this thread's Plan mode. Finish the plan first.`,
            });
        }
        const previous = yield* restartMethods.freshSession(threadId, model, { carryTurns: true });
        yield* feedMethods
          .emitChunk(threadId, {
            type: "data-handoff",
            id: randomUUID(),
            data: {
              reason: "user",
              ...(previous === undefined ? {} : { previousAgentSessionId: previous }),
              agent: model.agent,
              model: model.model,
              previousAgent: thread.model.agent,
              previousModel: thread.model.model,
              at: yield* Clock.currentTimeMillis,
            },
          })
          .pipe(Effect.ignore);
        return yield* store.getThread(threadId);
      }),
    setMode: (threadId, mode) =>
      Effect.gen(function* () {
        const generation = switchGenerations.get(threadId);
        const rt = yield* getRuntime(threadId);
        yield* locked(
          rt,
          Effect.gen(function* () {
            if (
              switchGenerations.get(threadId) !== generation ||
              (yield* store.getThread(threadId)).sessionSwitch !== undefined
            )
              return yield* new InvalidState({
                threadId,
                message:
                  "The orchestrator changed while this mode selection waited. Review the current session and select again.",
              });
            if (rt.session !== undefined) {
              yield* rt.session.setMode(mode).pipe(
                Effect.mapError(
                  (refused) =>
                    new InvalidState({
                      message: `The agent didn't switch mode: ${refused.message}`,
                      threadId,
                    }),
                ),
              );
            }
            const thread = yield* store.updateThread(threadId, (t) => ({ ...t, mode }));
            yield* publishUpsert(thread);
          }),
        );
      }),
    setModel: (threadId, model) =>
      Effect.gen(function* () {
        const generation = switchGenerations.get(threadId);
        const before = yield* store.getThread(threadId);
        if (before.sessionSwitch !== undefined)
          return yield* new InvalidState({
            threadId,
            message: "Wait for the orchestrator switch before changing its model.",
          });
        const otherAgent = otherAgentRefusal(threadId, before.model, model);
        if (otherAgent !== undefined) return yield* otherAgent;
        if (!profileAllowsModel(before.profile, model.model)) {
          const listed = yield* selectableModels(store, hosts, model.agent, model.profileId).pipe(
            Effect.orElseSucceed(() => undefined),
          );
          const row = listedRow(listed, model.model);
          yield* checkProfileModel(before, model.model, row ?? { id: model.model }).pipe(
            Effect.mapError((e) => new InvalidState({ threadId, message: e.message })),
          );
        }
        if (model.speed === "fast") {
          const host = yield* hosts.get(model.agent);
          const problem = fastSelectionProblem(
            model,
            yield* host.listModels(
              model.profileId === undefined ? {} : { profileId: model.profileId },
            ),
          );
          if (problem !== undefined)
            return yield* new AgentUnavailable({ agent: model.agent, message: problem });
        }
        const rt = yield* getRuntime(threadId);
        yield* locked(
          rt,
          Effect.gen(function* () {
            const current = yield* store.getThread(threadId);
            if (
              switchGenerations.get(threadId) !== generation ||
              current.sessionSwitch !== undefined
            )
              return yield* new InvalidState({
                threadId,
                message:
                  "The orchestrator changed while this model selection waited. Review the current session and select again.",
              });
            const movedAgent = otherAgentRefusal(threadId, current.model, model);
            if (movedAgent !== undefined) return yield* movedAgent;
            const thread = yield* store.updateThread(threadId, (t) => ({
              ...t,
              model,
              speedState: { speed: "unknown", detail: "Awaiting the CLI speed report." },
            }));
            yield* publishUpsert(thread);
            const session = rt.session;
            if (session === undefined) return;
            if (session.needsReopenFor?.(model.model) === true) yield* reopenWhenIdle(rt);
            else yield* session.setModel(model);
          }),
        );
      }),
    updateThread,
    ...closeMethods,
    markCompleted: (threadId, reason) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const thread = yield* store.setCompletion(
          threadId,
          reason === undefined ? undefined : { at: now, reason },
        );
        yield* publishUpsert(thread);
        return thread;
      }),
    updateCompletion: (threadId, f) =>
      store
        .updateCompletion(threadId, f)
        .pipe(Effect.tap(({ thread, changed }) => (changed ? publishUpsert(thread) : Effect.void))),
    ...feedMethods,
    status: (threadId) =>
      getRuntime(threadId).pipe(
        Effect.flatMap((rt) =>
          locked(
            rt,
            Effect.sync(() => rt.status),
          ),
        ),
      ),
    quiet: (threadId) =>
      getRuntime(threadId).pipe(
        Effect.flatMap((rt) =>
          locked(
            rt,
            Effect.sync(() => rt.quiet),
          ),
        ),
      ),
    compacting: (threadId) =>
      getRuntime(threadId).pipe(
        Effect.flatMap((rt) =>
          locked(
            rt,
            Effect.sync(() => rt.compaction !== undefined),
          ),
        ),
      ),
    activity: (threadId) =>
      getRuntime(threadId).pipe(
        Effect.flatMap((rt) =>
          locked(
            rt,
            Effect.sync(() =>
              BUSY.has(rt.status) || rt.activity.subagentsRunning ? rt.activity.line : undefined,
            ),
          ),
        ),
      ),
    snapshot: store.listThreads.pipe(Effect.flatMap((threads) => Effect.forEach(threads, summary))),
    summaryOf: (threadId) =>
      store.getThread(threadId).pipe(
        Effect.option,
        Effect.flatMap((thread) =>
          Option.isNone(thread) ? Effect.succeed(undefined) : summary(thread.value),
        ),
      ),
    working: Effect.gen(function* () {
      const working: ThreadId[] = [];
      for (const rt of runtimes.values()) {
        const busy = yield* locked(
          rt,
          Effect.sync(
            () =>
              rt.status === "starting" ||
              rt.turn !== undefined ||
              rt.background.length > 0 ||
              rt.activity.subagentsRunning,
          ),
        );
        if (busy) working.push(rt.threadId);
      }
      return working;
    }),
    shutdown: Effect.suspend(() => {
      shuttingDown = true;
      if (kept.on) kept.detach();
      return FiberMap.clear(sessions).pipe(
        Effect.andThen(
          Effect.suspend(() =>
            shutdownFailed ? Effect.die("Agent session teardown failed") : Effect.void,
          ),
        ),
      );
    }),
    stopAccepting: Effect.sync(() => {
      shuttingDown = true;
    }),
    openSessions: FiberMap.size(sessions),
    processIds: Effect.gen(function* () {
      const pids: Array<readonly [ThreadId, number]> = [];
      for (const rt of runtimes.values()) {
        const pid = rt.session?.processId === undefined ? undefined : yield* rt.session.processId;
        if (pid !== undefined) pids.push([rt.threadId, pid]);
      }
      return pids;
    }),
    ...historyMethods,
    setAppTools: (port) =>
      Effect.suspend(() => {
        appTools = port;
        if (takenUp) return Effect.void;
        takenUp = true;
        return takeUpKept;
      }),
    ...policyMethods,
    observe: (observer) =>
      Effect.acquireRelease(
        Effect.sync(() => void observers.add(observer)),
        () => Effect.sync(() => void observers.delete(observer)),
      ),
  });
  yield* waits.bindTranscript(service);
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      if (!kept.on) return;
      shuttingDown = true;
      kept.detach();
    }),
  );
  return ThreadRuntimes.of(ownedRuntimes(service, store.getThread, workerHosts.ownerOf));
});
