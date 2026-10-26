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
  type GitError,
  type QueuedInput,
  type Thread,
  type ThreadNotFound,
  type ThreadSummary,
  type WorktreeDirty,
} from "@gram/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
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
import { makeCostLedger } from "./cost-ledger.ts";
import { ClaudeAiSeen } from "../connectors/claude-ai-seen.ts";
import { HttpServer } from "../platform/unstable.ts";
import { EventHub } from "../events/event-hub.ts";
import { ThreadPlans } from "../plans/service.ts";
import { ThreadWaits } from "../waits/service.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { ActivityTracker } from "./activity.ts";
import { AgentHosts } from "./agent-hosts.ts";
import { CheckoutService, TurnHooks } from "./hooks.ts";
import type { EarlyReleases, ReleaseWave } from "./limit-wait.ts";
import { makeRateLimitGate } from "./rate-limits.ts";
import { UsageLimitReadings } from "../usage/limit-readings.ts";
import { RETRIES_EXHAUSTED } from "./thread-error.ts";
import type { CloseThreadOptions, ThreadRuntimesShape } from "./thread-runtimes-shape.ts";
import { makeDurableWork } from "../durable-work.ts";
import type { RuntimeObserver } from "./runtime-observer.ts";
import { makeSessionPolicy } from "./session-policy.ts";
import type { ResumeHold, QueueHold, TurnHold } from "./turn-holds.ts";
import { makeSessionRestarts, makeRestartMethods } from "./session-restarts.ts";
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
  type Runtime,
  BUSY,
  makeTurnId,
  locked,
  guarded,
  replyOf,
  type GetRuntime,
} from "./runtime-state.ts";
import { makeFeedWriter, makeFeedMethods } from "./feed-writer.ts";
import { makeLimitResume, makeLimitMethods } from "./limit-resume.ts";
import { makeTurnLifecycle } from "./turn-lifecycle.ts";
import { makeMessageQueue, makeQueueMethods } from "./message-queue.ts";
import { makeThreadLifecycle, makeCloseMethods } from "./thread-lifecycle.ts";
import { makeAgentEvents } from "./agent-events.ts";
import { makeSessionSwitch, makeSwitchMethods } from "./session-switch.ts";
import { makeSessionLifecycle } from "./session-lifecycle.ts";

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
    ThreadRuntimes | ThreadPlans | ThreadWaits,
    never,
    ThreadStore | EventHub | AgentHosts | ServerConfig | TurnHooks | CheckoutService
  > = Layer.effect(
    ThreadRuntimes,
    Effect.suspend(() => make),
  ).pipe(Layer.provideMerge(Layer.mergeAll(ThreadPlans.layer, ThreadWaits.layer)));
}

/** One send of the input in flight: its runtime, and whether its message is in the feed. */
interface InFlightSend {
  readonly rt: Runtime;
  /** A launch's message is in the feed already, unless it is sent in a new turn. */
  readonly published?: boolean;
}

/** What the send of the input in flight came to. */
interface Handover<E> {
  readonly started: Exit.Exit<void, E>;
}

const make = Effect.gen(function* () {
  const store = yield* ThreadStore;
  const hub = yield* EventHub;
  const plans = yield* ThreadPlans;
  const waits = yield* ThreadWaits;
  const hosts = yield* AgentHosts;
  const config = yield* ServerConfig;
  const hooks = yield* TurnHooks;
  const checkouts = yield* CheckoutService;
  const sessions = yield* FiberMap.make<ThreadId>();
  /** Set by `shutdown`, for good: the process is about to exit. */
  let shuttingDown = false;
  // Kept after a switch marker clears: a delayed mutation still belongs to the former owner.
  const switchGenerations = new Map<ThreadId, string>();
  const switchConfigLock = yield* Semaphore.make(1);
  let shutdownFailed = false;
  const idleTimers = yield* FiberMap.make<ThreadId>();
  const quietTimers = yield* FiberMap.make<ThreadId>();
  const reopens = yield* FiberMap.make<ThreadId>();
  /** A pending restart's second look once background tasks have settled (`BACKGROUND_SETTLE`). */
  const restartChecks = yield* FiberMap.make<ThreadId>();
  /** `stopInMissing` per thread, forked so a session's own event can stop it. */
  const folderStops = yield* FiberMap.make<ThreadId>();
  /**
   * Watchdog recoveries, owned here rather than by the interrupt RPC: one cut short between closing
   * the session and reopening it left the thread `running` with no session, taking no sends.
   */
  const recoveries = yield* FiberMap.make<ThreadId, void, never>();
  /**
   * Each thread's close, owned here so that two callers can't both tear it down (the second used to
   * empty the conversation the first kept) and a caller interrupted mid-close can't strand it
   * `closing`. Taken under `closeLock`, so two callers can't both find none running; `runningCloses`
   * has each running one's fiber and the options it was started with.
   */
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
  /** `releaseAfterClose`'s waits, which outlive the caller that handed them over. */
  const closeReleases = yield* FiberSet.make();
  const seenConnectors = yield* ClaudeAiSeen;
  /** Runs what a session's report of its connectors records, off the agent's message loop. */
  const recordSeen = yield* FiberSet.makeRuntime();
  const rateLimitShown = makeRateLimitGate();
  /** Cards raised by `requestApproval`, answered by the server rather than an agent session. */
  const serverRequests = new Map<RequestId, ServerApprovalRequest>();
  // A failed withdrawal can leave its card stored after the waiter is released. Preserve that
  // card's origin until actual removal, so a late answer never falls through to a native agent.
  const serverApprovalOrigins = new Map<RequestId, ThreadId>();
  const activityTimers = yield* FiberMap.make<ThreadId>();
  /** Each retrying thread's deadline, after which its turn is stopped (`giveUpRetrying`). */
  const retryDeadlines = yield* FiberMap.make<ThreadId>();
  /** Each stop a deadline began, which no later retry or turn end may cancel. */
  const retryStops = yield* FiberMap.make<ThreadId>();
  /** Each thread waiting out a limit (`Thread.limitWait`), the timer that resumes it. */
  const limitTimers = yield* FiberMap.make<ThreadId>();
  /** The latest reading of each subscription window, whose rejections name when an account lifts. */
  const limitReadings = yield* Effect.serviceOption(UsageLimitReadings);
  const resumeHolds = new Set<ResumeHold>();
  const queueHolds = new Set<QueueHold>();
  const turnHolds = new Set<TurnHold>();
  /** Per account, the batches workers let go from a hold resume in (`releaseSlot`). */
  const releaseWaves = new Map<string, ReleaseWave>();
  /** Per account, when a turn on it last met its limit, this run; `hitAt` falls back to the waits. */
  const limitHits = new Map<string, number>();
  /**
   * Per account, the reset its latest limit named, this run: the agent's own word on when the
   * account lifts, which every wait on it then shares (`scheduleAccount`).
   */
  const hitResets = new Map<string, number>();
  /** Per account, its early releases since a turn on it last went through (`earlyReleaseDue`). */
  const earlyReleases = new Map<string, EarlyReleases>();
  /** Each account's early release under way, so a burst of readings starts one. */
  const releasing = yield* FiberMap.make<string>();
  const releaseLock = yield* Semaphore.make(1);
  const runtimes = new Map<ThreadId, Runtime>();
  const registryLock = yield* Semaphore.make(1);
  let appTools: AppToolRegistryPort | undefined;
  const observers = new Set<RuntimeObserver>();
  // Observer and delivery callbacks may call back into this service, so they never run under a
  // runtime lock: they are handed to one fiber, which also keeps them in the order things happened.
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

  const { policyFor, methods: policyMethods } = makeSessionPolicy({ store });
  // Present in the full server; tests without the HTTP layer run agents without MCP endpoints.
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

  // Pending requests and open turns belong to agent processes, which didn't survive the previous
  // server run. A turn left open would count as running forever and never report its cost.
  yield* store.clearRequests();
  const cutOff = yield* store.closeOpenTurns(yield* Clock.currentTimeMillis);
  // A send whose session a restart cut off before it opened is still queued, and goes from there.
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
  // Each takes the end checkpoint its turn would have, before any session can touch the checkout
  // again: without one, `turn_diff` reads the live tree and blames later turns' edits on it.
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
          // The last reported usage survives a restart, so the meter counts on from it.
          const usage = yield* store.lastTurnUsage(threadId);
          // What the store keeps of each notice's key goes back into `noticeKeys`.
          const stored = yield* store.listQueue(threadId);
          const noticeKeys = new Map<QueueItemId, string>();
          for (const item of stored) {
            if (item.noticeKey !== undefined) noticeKeys.set(item.id, item.noticeKey);
          }
          const rt: Runtime = {
            threadId,
            lock: yield* Semaphore.make(1),
            feedLock: yield* Semaphore.make(1),
            status: "cold",
            session: undefined,
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
              const { noticeKey, ...queued } = item;
              // A notice queued without an author (a limit's "continue") is still Gram's, by its stored key.
              return noticeKey === undefined || queued.input.author !== undefined
                ? queued
                : { ...queued, input: { ...queued.input, author: "server" as const } };
            }),
            launch: undefined,
            inFlight: undefined,
            queuedAt: new Map(),
            noticeKeys,
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
            reopenOnIdle: false,
            restartMarker: undefined,
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

  // --- feed, in-flight messages and turns (all called with the runtime lock held) ---

  const {
    publishMessage,
    replaceFeed,
    withdrawMessage,
    appendChunkLocked,
    flushUnsaved,
    appendChunk,
    appendDataPart,
    closeOpenMessages,
    closeLanes,
  } = makeFeedWriter({
    store,
    hub,
    notifyObservers,
    searchRefreshes: yield* FiberMap.make<string>(),
  });

  const {
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
  } = makeTurnLifecycle({
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
    setRetrying: (rt, retrying, detail) => setRetrying(rt, retrying, detail),
    clearPendingRequests: (rt, reason) => clearPendingRequests(rt, reason),
  });
  /**
   * `detail` is the adapter's retry line, of which only `retryFacts` reaches the log. A retry that
   * outlasts `config.retryDeadline` stops the turn: Codex waiting for a network that never comes
   * back retried for half an hour with nothing to say so but its activity line.
   */
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

  // ---------------------------------------------------------------------------------------------
  // Waiting out a provider limit
  // ---------------------------------------------------------------------------------------------

  const {
    hitAt,
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
  });

  // Each reading taken in may say an account's limit no longer applies: one a thread waits on.
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

  /**
   * Stops a turn whose agent has been retrying since its deadline was set, and leaves the failure
   * on the thread for its card and the ledger. Run in `retryStops`, apart from the deadline's
   * sleep, so a retry the agent reports meanwhile can't cancel it, and only ever against the
   * turn and session that expired, never a turn begun after.
   */
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
          // Only over the very state the stop left: the same session at rest, with no turn since.
          // A watchdog's fresh session is still starting, and input queued meanwhile may have
          // run; either is a newer state the error must not replace. `lastError` stands anyway.
          const settled =
            rt.turn === undefined &&
            rt.session === stuck.session &&
            rt.status === "idle" &&
            (yield* store.lastTurn(rt.threadId))?.id === turnId;
          if (settled) yield* setStatus(rt, "error", stuck.failed.text);
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
  });
  /**
   * The turn an in-flight input goes in: the one it was given before, unless a turn with that id
   * was opened already (a restart closed it), whose row a new one can't take.
   */
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

  /**
   * The send of the input in flight (`rt.inFlight`), a launch or the queue's head, as durable work
   * (`makeDurableWork`): the caller stores it at the queue's head with its turn before the attempt,
   * the attempt sends it, and it is marked done by clearing the stored copy, put back first when
   * the send didn't go. Called with the runtime lock held.
   *
   * Its resume is the boot's `sendQueuedAtBoot`: the stored head comes back as the queue's first
   * item, with its turn, and `drainQueue` opens a session and sends it through here once, as the
   * same message (`queue-persistence.test.ts`). `resume` itself isn't used, since the send
   * needs the session that drain opens.
   */
  type SendError = Effect.Error<ReturnType<typeof sendNow>>;
  const handover = makeDurableWork<
    InFlightSend,
    NonNullable<Runtime["inFlight"]> & { readonly sent?: Handover<SendError> },
    Handover<SendError>
  >({
    lockKey: (handed) => handed.rt.threadId,
    read: (handed) => Effect.sync(() => handed.rt.inFlight),
    owed: (item) => item.sent === undefined,
    perform: (item, _retry, { rt, published }) =>
      Effect.gen(function* () {
        if (rt.session === undefined) return undefined;
        const started = yield* Effect.exit(
          sendNow(rt, rt.session, item.input, {
            turnId: item.turnId,
            messageId: item.id,
            ...(published === undefined ? {} : { published }),
          }),
        );
        return { started };
      }),
    markDone: (item, sent, { rt }) =>
      Effect.gen(function* () {
        rt.inFlight = undefined;
        // Clients saw the queue without the item when it was shifted; a launch was never in it.
        yield* persistQueue(rt);
        return { ...item, sent };
      }),
  });

  /** Sends the input in flight (`handover`), and what came of it. */
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
      // Nothing more starts once the server is shutting down: the launch and the queue stay as
      // stored, for the next boot to send (`sendQueuedAtBoot`).
      if (shuttingDown) return yield* setStatus(rt, "idle");
      // Straight from `starting` to `running`: the thread was never idle with the launch waiting.
      const launched = rt.reopenOnIdle ? undefined : rt.launch;
      if (launched !== undefined && rt.session !== undefined) {
        // Stored, in flight, until the agent has taken it.
        const turnId = yield* unusedTurn(rt, launched.turnId);
        rt.launch = undefined;
        rt.inFlight = { ...launched, turnId };
        yield* persistQueue(rt);
        const { started } = yield* sendInFlight({
          rt,
          // In a new turn, its row is published again, under that turn.
          published: turnId === launched.turnId,
        });
        if (Exit.isSuccess(started)) return;
        if (rt.turn !== undefined) yield* finishTurn(rt, "interrupted", "sendFailed");
      }
      yield* setStatus(rt, "idle");
      if (rt.reopenOnIdle) {
        // The reopen that waited for this idle opens after the host dropped its cache, so it
        // carries the pending restart: one restart, under its divider.
        if (rt.pendingRestart !== undefined) {
          rt.restartMarker ??= rt.pendingRestart;
          yield* setPendingRestart(rt, undefined);
        }
        return yield* reopenWhenIdle(rt);
      }
      // The queue and the deliveries wait for the limit's resume, which sends them.
      if (rt.limitWait !== undefined) return yield* startIdleTimer(rt);
      // And for a queue hold to let go (`releaseQueue`).
      if (yield* queueHeld(rt)) return yield* startIdleTimer(rt);
      // A monitor's notice queued before the thread was archived waits: it never wakes an
      // archived thread (`sendInput`), and the monitor that queued it takes it back. Asked before
      // it is taken off the queue, and again after that is written, the last wait before the
      // send, so an archive committed during the write is seen too.
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
        // Off the queue clients see, but stored, in flight, until the agent has taken it: a crash
        // before then sends it again, as the same message, rather than lose it.
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
        const { started } = yield* sendInFlight({ rt });
        if (Exit.isFailure(started)) return yield* Effect.failCause(started.cause);
      } else if (rt.session === undefined || !(yield* deliverNext(rt, rt.session))) {
        yield* startIdleTimer(rt);
        yield* restartIfPending(rt);
      }
    });

  const { handleEvent, setBackground, setLapsedConnectors } = makeAgentEvents({
    store,
    hub,
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
    settleNote,
    recordFailure,
    keepError,
    finishTurn,
    publishFailure,
    turnHeld,
    limitWaitOf,
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
    store,
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
    setPendingRestart,
    resumeOptions,
    handleEvent,
    setBackground,
    setLapsedConnectors,
    isShuttingDown: () => shuttingDown,
    markShutdownFailed: () => {
      shutdownFailed = true;
    },
    currentAppTools: () => appTools,
  });
  const { claimClose, settleClose, guardHolds, restsNow, create } = makeThreadLifecycle({
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
  const interrupt: ThreadRuntimesShape["interrupt"] = (threadId) =>
    Effect.gen(function* () {
      const rt = yield* getRuntime(threadId);
      const target = yield* locked(
        rt,
        Effect.gen(function* () {
          if (rt.session === undefined) return undefined;
          // Between turns there is nothing to interrupt, but a background subagent can still be
          // working, and to the user that is the agent running. Stop means stop that too.
          if (rt.turn === undefined) return { background: rt.session };
          // Stop answers every open card: drop them now rather than when the turn winds down.
          yield* clearPendingRequests(rt, "stop-requested");
          return { session: rt.session, turn: rt.turn };
        }),
      );
      if (target === undefined) return;
      if ("background" in target) {
        // Each stopped task reports back through its own `task_notification`, which closes its
        // transcript and clears the activity line as any finished subagent does.
        yield* target.background.stopBackgroundTasks ?? Effect.void;
        return;
      }
      yield* target.session.interrupt.pipe(
        Effect.andThen(Deferred.await(target.turn.done)),
        Effect.timeoutOrElse({
          duration: config.interruptWatchdog,
          orElse: () =>
            Effect.fail(
              new InterruptHung({ timeoutMs: Duration.toMillis(config.interruptWatchdog) }),
            ),
        }),
        Effect.catchTag("InterruptHung", () => recoverOwned(rt, target.turn.id)),
      );
    });

  /**
   * Called with the lock held: stops `turn` at its next tool boundary, never interrupting it. With
   * a tool gate the gate closes now, so every call the turn makes from here is refused with
   * `PAUSE_STOP_TEXT` and one already running ends by itself; without one the agent is steered the
   * same words. Either way the agent ends its turn, and a hold keeps the next from starting.
   */
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
      // Refused, the turn runs to its own end; the hold still keeps the next from starting.
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
      // Its end arrives as a `backgroundTasks` event without it, published like any other change.
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

  const updateThread: ThreadRuntimesShape["updateThread"] = (threadId, f, authorityCaller) =>
    Effect.gen(function* () {
      const before = yield* store.getThread(threadId);
      const thread = yield* store.updateThread(threadId, f, authorityCaller);
      yield* publishUpsert(thread);
      const unarchived = before.parked && !thread.parked;
      const rt =
        runtimes.get(threadId) ??
        (unarchived && (yield* store.listQueue(threadId)).length > 0
          ? yield* getRuntime(threadId)
          : undefined);
      if (rt === undefined) return thread;
      if (unarchived) {
        yield* locked(rt, drainQueue(rt));
      } else if (thread.parked && !before.parked) {
        // A background subagent's result or a background shell's exit is still to come, and the
        // agent opens a turn for it, so a thread parked meanwhile keeps its session until the idle
        // timer runs out.
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
      // A cold thread has no session yet, but the UI still needs to know what its agent can do.
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
      // A cold or evicted thread, or one whose session hasn't reported yet, shows its last turn's usage.
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

  const { switchSession } = makeSessionSwitch({
    store,
    hosts,
    getRuntime,
    setStatus,
    stopSession,
    cancelIdleTimer,
    publishUpsert,
    isShuttingDown: () => shuttingDown,
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
    checkouts,
    runtimes,
    getRuntime,
    drainQueue,
    sendInput,
    userTyped,
    syncQueue,
    withSession,
    steerNow,
    withQueue,
    switchHold,
    pumpDeliveries,
    scheduleAccount,
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
  });

  const service = ThreadRuntimes.of({
    ...switchMethods,
    switchSession,
    cutAtBoot: cutOff,
    ...queueMethods,
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
    setMode: (threadId, mode) =>
      Effect.gen(function* () {
        const generation = switchGenerations.get(threadId);
        const rt = yield* getRuntime(threadId);
        // One lock over the agent call and the write, so two quick picks land in the store in the
        // order the agent took them. The store is written directly: `updateThread` takes this
        // lock itself when a thread parks.
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
              // Open through `needsApproval` and `needsInput` too, until `finishTurn`.
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
      Effect.sync(() => {
        appTools = port;
      }),
    ...policyMethods,
    observe: (observer) =>
      Effect.acquireRelease(
        Effect.sync(() => void observers.add(observer)),
        () => Effect.sync(() => void observers.delete(observer)),
      ),
  });
  yield* waits.bindTranscript(service);
  return service;
});
