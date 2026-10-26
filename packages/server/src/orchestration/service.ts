// Threaded orchestration's server side: workspaces and
// the orchestrator slot, the session policy a role adds, the ledger, the wake → debounce → digest
// pipeline with its durable outbox, workers that span repos, handoff to a fresh session, the
// charter's one cap, pauses and drift detection. Its decisions are `rules.ts`'s; the service
// gathers the facts and carries the decisions out.
//
// This file is the composition root. `service/kit.ts` holds what every part shares (services,
// timers, locks, state, the outbox and authority), and each part under `service/` is made from the
// kit and the few functions of other parts its `deps` name. Here the parts are made in dependency
// order, the signals are dispatched to them, and the runtime and publisher hooks are wired.
//
// Two invariants hold the rest together. Authority is asked on every call (`authorityOf`), never
// remembered, so a role outside its slot can do nothing whatever tool list its session still
// holds. And a digest is always the ledger now against the snapshot the outbox persisted at the
// last acknowledged digest: the wake reasons kept in memory here decide when a digest goes, never
// what it says, so a restart loses nothing.

import { makeSpawnBreaker } from "./spawn-breaker.ts";
import { idleCompactOf, effectiveCheckout, type ServerEvent, type Thread } from "@gram/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { withOwnedBranch } from "../git/worker-pr.ts";
import { contextPct, workerErrorOf } from "./ledger.ts";
import { makeIdleCompactor } from "./idle-compact.ts";
import { contextNote, userHoldLapsesAt } from "./rules.ts";
import { type OrchestrationShape } from "./service/shape.ts";
import {
  makeOrchestrationKit,
  pausedFeatureOf,
  type Signal,
  heldByUser,
  workerModel,
} from "./service/kit.ts";
import { makeWorkerQuestions } from "./service/questions.ts";
import { makeLedgerWatch } from "./service/ledger-watch.ts";
import { makeHandoff } from "./service/handoff.ts";
import { makeProjects } from "./service/projects.ts";
import { makeSends } from "./service/sends.ts";
import { makeWorkerRepos } from "./service/worker-repos.ts";
import { makeAdoption } from "./service/adoption.ts";
import { makeFeatures } from "./service/features.ts";
import { makePauses } from "./service/pauses.ts";
import { makeDigests } from "./service/digests.ts";
import { makeWakeAlarms } from "./service/wake-alarms.ts";
import { makeWorkers } from "./service/workers.ts";
import { makeSessionPolicy } from "./service/session-policy.ts";
import { makeTaskStartup } from "./service/task-startup.ts";
import { makeCharter } from "./service/charter.ts";
import { makeWorkspaces } from "./service/workspaces.ts";
import { makeObservers } from "./service/observers.ts";
import { makeBoot } from "./service/boot.ts";
import { makeHeldSpawns } from "./service/held-spawns.ts";
import { makeSpawning } from "./service/spawning.ts";
export { DELIVERY_RETRY_DELAYS, DELIVERY_FAILURES_BEFORE_PAUSE } from "./service/digests.ts";
export { RECOVERY_DELAYS, PAUSE_RESUME_KEY } from "./service/pauses.ts";
export { MAX_WORKER_REPOS } from "./service/worker-repos.ts";
export { HANDOFF_KEY, HANDOFF_RETRY, HANDOFF_GIVE_UP_MS } from "./service/handoff.ts";
export { LEDGER_WATCH_DEBOUNCE } from "./service/ledger-watch.ts";
export {
  DEFAULT_WAKE_DEBOUNCE,
  WAKE_MAX_WAIT_WINDOWS,
  OUTBOX_UNREADABLE_DETAIL,
  SIGNAL_COALESCING,
  DIGEST_KEY,
  IN_ERROR_DETAIL,
  CHARTER_MOVED,
} from "./service/kit.ts";
export type { Signal } from "./service/kit.ts";
export type {
  Authority,
  SpawnWorkerInput,
  HeldSpawn,
  SentMessage,
  RepeatedSend,
  StageInput,
  GroupInput,
  AnswerWorkerInput,
  WorkerWorktree,
  AddWorkerRepoInput,
  AddedWorkerRepo,
  JoinInput,
  AdoptThreadInput,
  AdoptPin,
  AdoptedThread,
  SpawnedWorker,
  ReopenFields,
  OrchestrationShape,
} from "./service/shape.ts";

export class Orchestration extends Context.Service<Orchestration, OrchestrationShape>()(
  "@gram/server/Orchestration",
) {}

// Hub events worth a place in the queue; status flips and streaming would flood it.
const watched = (event: ServerEvent): boolean =>
  event.type === "thread.upsert" ||
  event.type === "thread.removed" ||
  event.type === "thread.request" ||
  event.type === "thread.requestResolved" ||
  event.type === "thread.background" ||
  (event.type === "thread.status" && event.status === "error");

export const OrchestrationLive = Layer.effect(
  Orchestration,
  Effect.gen(function* () {
    const kit = yield* makeOrchestrationKit;
    const {
      store,
      hub,
      runtimes,
      publisher,
      composerPresence,
      rosterHere,
      rosterAvailability,
      signals,
      requestTimers,
      orchestrators,
      workerWorkspaces,
      retrying,
      requestSeen,
      orchestrationChanged,
      findWorkspace,
      findThread,
      readOutbox,
      updateOutbox,
      authorityOf,
      delegated,
      resolveWorkerParent,
      isWorkerSend,
      listeningWorkspace,
      orchestratorState,
    } = kit;

    const spawnBreaker = yield* makeSpawnBreaker({
      store,
      runtimes,
      authorityOf,
      workerModel,
      rosterHere,
      readOutbox,
      updateOutbox,
      // Made below, by the held spawns, which take this breaker.
      arm: (workspaceId) => armLimitResume(workspaceId),
      changed: orchestrationChanged,
      projectName: (input, state) =>
        lookupProject("spawn_worker", input.project, state).pipe(
          Effect.map((found) => ("known" in found ? found.known.name : found.unknown.name)),
          Effect.orElseSucceed(() => undefined),
        ),
    });

    const onHub = (event: ServerEvent) => {
      switch (event.type) {
        case "thread.upsert":
          return onUpsert(event.thread);
        case "thread.removed":
          return onRemoved(event.threadId);
        case "thread.request":
          return onRequest(event.threadId, event.request.id, event.request.kind);
        case "thread.background":
          return onBackground(event.threadId, event.tasks);
        case "thread.requestResolved":
          requestSeen.delete(event.requestId);
          return FiberMap.remove(requestTimers, event.requestId);
        case "thread.status": {
          // A turn that ends in error is `onTurnEnd`'s; this is the agent that never started.
          const workspaceId = workerWorkspaces.get(event.threadId);
          if (event.status !== "error" || workspaceId === undefined) return Effect.void;
          return findThread(event.threadId).pipe(
            Effect.flatMap((thread) =>
              wakeFor(
                workspaceId,
                {
                  type: "workerError",
                  worker: thread?.title ?? event.threadId,
                  error: thread === undefined ? undefined : workerErrorOf(thread),
                },
                thread,
              ),
            ),
          );
        }
        default:
          return Effect.void;
      }
    };

    const onQuiet = (thread: Thread, active: boolean) =>
      Effect.gen(function* () {
        const state = yield* listeningWorkspace(thread);
        if (state === undefined) return;
        yield* orchestrationChanged(state.workspace.id);
        if (active) {
          yield* wakeFor(
            state.workspace.id,
            { type: "turnEnded", worker: thread.title, queueEmpty: true },
            thread,
          );
        }
      });

    const handle = (signal: Signal): Effect.Effect<void> => {
      switch (signal.type) {
        case "quiet":
          return onQuiet(signal.thread, signal.active);
        case "turnStart":
          return onTurnStart(signal.thread).pipe(
            Effect.andThen(idleCompactor.onTurnStart(signal.thread.id)),
          );
        case "turnEnd":
          return onTurnEnd(signal.thread, signal.end).pipe(
            Effect.andThen(
              idleCompactor.onTurnEnd(signal.thread, signal.end).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("idle compaction planning failed").pipe(
                    Effect.annotateLogs({
                      threadId: signal.thread.id,
                      cause: Cause.pretty(cause),
                    }),
                  ),
                ),
              ),
            ),
          );
        case "userInput":
          return onUserInput(signal.thread);
        case "limitWait":
          return onLimitWait(signal.thread, signal.wait, signal.ended);
        case "gitState":
          return onGitState(signal.thread, signal.state);
        case "hub":
          return onHub(signal.event);
        case "wakeDue":
          return onWakeDue(signal.workspaceId);
        case "requestAged":
          return onRequestAged(signal.threadId, signal.requestId);
        case "holdDue":
          return onHoldDue(signal.threadId);
        case "questionDue":
          return onQuestionDue(signal.workspaceId, signal.questionId);
        case "wakeAlarm":
          return onWakeAlarm(signal.workspaceId, signal.wakeId, signal.fired);
        case "recoveryDue":
          return onRecoveryDue(signal.workspaceId);
        case "limitReset":
          return onLimitReset(signal.workspaceId);
        case "limitHeadroom":
          return store.listWorkspaces.pipe(
            Effect.flatMap((states) =>
              Effect.forEach(
                states,
                (state) =>
                  onLimitHeadroom(state.workspace.id).pipe(
                    Effect.andThen(recoverAtHeadroom(state.workspace.id)),
                  ),
                { discard: true },
              ),
            ),
          );
        case "dragCheck":
          return onDragCheck(signal.threadId);
        case "handoffFailed":
          return onHandoffFailed(signal.workspaceId, signal.reason);
        case "contextLow":
          return rearmContextNote(signal.workspaceId);
        case "outboxUnreadable":
          return quarantineOutbox(signal.workspaceId);
        case "handoffRetry":
          return findWorkspace(signal.workspaceId).pipe(
            Effect.flatMap((state) =>
              state?.workspace.orchestratorThreadId === undefined
                ? clearHandoff(signal.workspaceId).pipe(Effect.asVoid)
                : performFresh(signal.workspaceId, state.workspace.orchestratorThreadId),
            ),
          );
        case "boot":
          return onBoot;
      }
    };

    // Idle compaction (docs/AGENTS_AND_FEATURES.md#idle-compaction): what only this service
    // knows, a thread's workspace, its kind there and what the user holds of it, for the
    // compactor's rules.
    const idleCompactor = yield* makeIdleCompactor({
      runtimes,
      store,
      presence: composerPresence ?? { holdOf: () => Effect.succeed("unknownWindow" as const) },
      scope: (thread) =>
        Effect.gen(function* () {
          const own = yield* orchestratorState(thread);
          const state = own ?? (yield* listeningWorkspace(thread));
          if (state === undefined) return undefined;
          const { enabled, kinds } = idleCompactOf(state.charter);
          return {
            workspaceId: state.workspace.id,
            enabled,
            kinds,
            kind: own === undefined ? ("worker" as const) : ("orchestrator" as const),
          };
        }),
      held: (thread) =>
        Effect.gen(function* () {
          const own = yield* orchestratorState(thread);
          const state = own ?? (yield* listeningWorkspace(thread));
          if (state === undefined) return undefined;
          if (state.paused !== undefined) return "user" as const;
          const outbox = yield* readOutbox(state.workspace.id);
          if (own === undefined) {
            if (pausedFeatureOf(state, thread) !== undefined) return "user" as const;
            if (heldByUser(outbox.workers[thread.id], yield* Clock.currentTimeMillis)) {
              return "user" as const;
            }
          }
          // An open question will bring an answer: the orchestrator's for any of its workers.
          const asking = (outbox.questions ?? []).some(
            (question) =>
              question.closedAt === undefined &&
              (own !== undefined || question.threadId === thread.id),
          );
          return asking ? ("question" as const) : undefined;
        }),
      compacted: (thread, scope) =>
        scope.kind !== "orchestrator"
          ? Effect.void
          : updateOutbox(scope.workspaceId, (outbox) => [
              { ...outbox, booted: false },
              undefined,
            ]).pipe(
              Effect.andThen(
                Effect.logInfo("orchestrator owed its boot context after idle compaction").pipe(
                  Effect.annotateLogs({ threadId: thread.id, workspaceId: scope.workspaceId }),
                ),
              ),
            ),
    });

    const { survey, ledger, watchLedger, featureCards, watchFeatureCards, dependencyBadgesOf } =
      makeLedgerWatch(kit);

    const {
      lookupProject,
      resolveProject,
      projectCall,
      pinRepos,
      repoNames,
      joinWorkspace,
      outsideWorkspace,
    } = makeProjects(kit);

    const { guardSend, checkSend, checkWorkerMessage, noteMessage, sendOnce } = makeSends(kit);

    const { policyFor } = makeSessionPolicy(kit);

    const { openModel, taskWorkers, taskPreflight, withTaskStartup } = makeTaskStartup(kit);

    const {
      cancelDelivery,
      armWake,
      wake,
      wakeFor,
      forgetReasons,
      deliveryFor,
      onWakeDue,
      addNote,
      noteQuietly,
    } = makeDigests(kit, {
      survey,
      // Made below, by the pauses, which take `wake` and `cancelDelivery` from here.
      pause: (...args) => pause(...args),
      endRecovery: (workspaceId) => endRecovery(workspaceId),
    });

    const {
      keepsWakesOf,
      armAlarm,
      syncPrWatches,
      onWatchedPr,
      armAlarms,
      pendingWakesOf,
      scheduleWake,
      cancelWake,
      onWakeAlarm,
    } = makeWakeAlarms(kit, { wake });

    const {
      listWorkers,
      recordReport,
      releaseWorker,
      takeOverWorker,
      armHold,
      armHolds,
      onHoldDue,
      allowsAtFull,
      workerMergesOwn,
    } = makeWorkers(kit, { survey, wakeFor, wake });

    const {
      armLimitResume,
      onLimitReset,
      onLimitHeadroom,
      limitGate,
      holdGate,
      routeGate,
      routeHeld,
      routePaused,
      updateHeld,
      manageHeldSpawn,
      releaseHeldBrief,
      pausedSpawnGate,
    } = makeHeldSpawns(kit, {
      wake,
      lookupProject,
      // Made below, by spawning, which takes the gates from here.
      spawnFor: (...args) => spawnFor(...args),
      survey,
      spawnBreaker,
    });

    const {
      spawnNeedsApproval,
      describeSpawn,
      checkWorkerModel,
      spawnFor,
      joinGroup,
      spawnWorker,
      briefFooter,
      startWorker,
    } = makeSpawning(kit, {
      outsideWorkspace,
      survey,
      repoNames,
      joinWorkspace,
      resolveProject,
      taskWorkers,
      armHold,
      projectCall,
      pausedSpawnGate,
      spawnBreaker,
      routeGate,
      holdGate,
      routeHeld,
      limitGate,
      routePaused,
    });

    const { setCharter, changeCharter } = makeCharter(kit, { wake });

    const {
      noteForNextDigest,
      setStage,
      setGroup,
      archiveFeature,
      setFeaturePaused,
      renameFeature,
      setStageAs,
      setGroupAs,
    } = makeFeatures(kit, { wake, armAlarms, armLimitResume });

    const {
      clearHandoff,
      abandonHandoff,
      performFresh,
      handoffAfterTurn,
      onHandoffFailed,
      handoff,
      resumeHandoff,
      retrySwitch,
      cancelSwitch,
    } = makeHandoff(kit, {
      armWake,
      survey,
      // Made below, by the pauses, which take `abandonHandoff` from here.
      endRecovery: (workspaceId) => endRecovery(workspaceId),
      armAlarms,
      deliveryFor,
      cancelDelivery,
    });

    const {
      quarantineOutbox,
      pause,
      armRecovery,
      endRecovery,
      onRecoveryDue,
      recoverAtHeadroom,
      armPauseResumes,
      forgetStopped,
      recordHeldStop,
      setPaused,
      launchUnlessPaused,
      changePaused,
      followPark,
    } = makePauses(kit, {
      cancelDelivery,
      wake,
      armAlarms,
      noteForNextDigest,
      armLimitResume,
      abandonHandoff,
    });

    const { saveWorkspace, saveWorkspaceApproved, whileWorkspaceStays, removeWorkspace, open } =
      makeWorkspaces(kit, {
        forgetReasons,
        openModel,
        endRecovery,
        deliveryFor,
      });

    const {
      answerWorker,
      armQuestionTimers,
      deliverOwedQuestions,
      askQuestion,
      forwardQuestion,
      answerWorkerQuestion,
      answerQuestionAsUser,
      dismissQuestionAsUser,
      onQuestionDue,
    } = makeWorkerQuestions(kit, { recordReport, wake });

    const { addRepoNeedsApproval, describeAddRepo, addWorkerRepo } = makeWorkerRepos(kit, {
      outsideWorkspace,
      repoNames,
      guardSend,
      resolveProject,
      joinWorkspace,
      noteMessage,
      projectCall,
    });

    const {
      workerRemoved,
      detach,
      joinThread,
      joinTargets,
      describeAdopt,
      pinAdopt,
      adoptThread,
      checkModelChange,
      reopen,
    } = makeAdoption(kit, {
      wakeFor,
      survey,
      syncPrWatches,
      armAlarm,
      armHold,
      joinWorkspace,
      joinGroup,
      wake,
    });

    const {
      onTurnStart,
      rearmContextNote,
      onTurnEnd,
      onLimitWait,
      onUserInput,
      onDragCheck,
      onGitState,
      onUpsert,
      onRemoved,
      onRequest,
      onRequestAged,
      noteRestart,
      onBackground,
    } = makeObservers(kit, {
      updateHeld,
      armLimitResume,
      handoffAfterTurn,
      armHold,
      wakeFor,
      wake,
      survey,
      dependencyBadgesOf,
      followPark,
      workerRemoved,
      clearHandoff,
      forgetReasons,
    });

    const { onBoot } = makeBoot(kit, {
      quarantineOutbox,
      onRequest,
      armHolds,
      armAlarms,
      armLimitResume,
      armPauseResumes,
      armQuestionTimers,
      deliverOwedQuestions,
      noteRestart,
      followPark,
      resumeHandoff,
      wake,
      armRecovery,
    });

    // The runtime's callbacks share one fiber, so each only hands its news to the queue.
    yield* runtimes.observe({
      onTurnStart: (thread, turnId) =>
        signals.offer({ type: "turnStart", thread, turnId }).pipe(Effect.asVoid),
      onTurnEnd: (thread, end) =>
        signals.offer({ type: "turnEnd", thread, end }).pipe(Effect.asVoid),
      onQuiet: (thread, quiet) =>
        signals.offer({ type: "quiet", thread, active: quiet !== undefined }).pipe(Effect.asVoid),
      onRetrying: (threadId, on) =>
        Effect.sync(() => void (on ? retrying.add(threadId) : retrying.delete(threadId))),
      // At once, not behind the signals: input the user typed before a pause mustn't undo its stop.
      onUserInput: (thread) =>
        forgetStopped(thread).pipe(
          Effect.andThen(signals.offer({ type: "userInput", thread })),
          Effect.asVoid,
        ),
      onLimitWait: (thread, wait, ended) =>
        signals.offer({ type: "limitWait", thread, wait, ended }).pipe(Effect.asVoid),
      onTurnHeld: (thread) => recordHeldStop(thread),
    });
    // A worker of a feature the user paused starts no turn from its queue or a system delivery
    // until they resume it, which sends what waited (`setFeaturePaused`).
    // So does every worker of a workspace the user paused, and then each one its resume holds back
    // until its batch (`resuming`). The user's own word goes through either way.
    yield* runtimes.holdQueues((thread) =>
      Effect.gen(function* () {
        const state = yield* listeningWorkspace(thread);
        if (state === undefined) return false;
        if (pausedFeatureOf(state, thread) !== undefined || state.paused?.reason === "user") {
          return true;
        }
        const { resuming } = yield* readOutbox(state.workspace.id);
        return resuming?.some((each) => each.threadId === thread.id) === true;
      }),
    );
    // A turn the agent opens by itself in a workspace the user paused (Claude reporting on a
    // background task) has its tool gate closed too, but a held worker's: that one is theirs.
    yield* runtimes.holdAgentTurns((thread) =>
      Effect.gen(function* () {
        const own = yield* orchestratorState(thread);
        if (own !== undefined) return own.paused?.reason === "user";
        const state = yield* listeningWorkspace(thread);
        if (state?.paused?.reason !== "user") return false;
        const memo = (yield* readOutbox(state.workspace.id)).workers[thread.id];
        return !heldByUser(memo, yield* Clock.currentTimeMillis);
      }),
    );
    // A limit's resume never takes over what the user holds: a worker they typed into and haven't
    // let go of, or a paused workspace's threads. They stay waiting, and are asked again later.
    yield* runtimes.holdResumes((thread) =>
      Effect.gen(function* () {
        const own = yield* orchestratorState(thread);
        if (own !== undefined) return own.paused !== undefined;
        const state = yield* listeningWorkspace(thread);
        if (state === undefined) return false;
        if (state.paused !== undefined || pausedFeatureOf(state, thread) !== undefined) return true;
        const memo = (yield* readOutbox(state.workspace.id)).workers[thread.id];
        const lapsesAt = memo === undefined ? undefined : userHoldLapsesAt(memo);
        return lapsesAt !== undefined && lapsesAt > (yield* Clock.currentTimeMillis);
      }),
    );
    yield* publisher.observe({
      onState: (thread, state) =>
        Effect.gen(function* () {
          const path = effectiveCheckout(thread).path;
          // Before the coalescing queue: a quick second branch switch must retain the first.
          const observed = withOwnedBranch(thread, path, state.branch);
          const latest =
            observed === thread
              ? thread
              : yield* runtimes
                  .updateThread(thread.id, (current) =>
                    withOwnedBranch(current, path, state.branch),
                  )
                  .pipe(Effect.orElseSucceed(() => thread));
          yield* signals.offer({ type: "gitState", thread: latest, state });
        }),
      onRound: () => Effect.void,
      onWatchedPr,
    });
    // Before the boot signal: a worker the boot continues opens its session there, and a session
    // keeps the policy it opened with, so one opened earlier would run without its role's tools.
    yield* runtimes.setSessionPolicy({ forThread: policyFor });

    yield* signals.offer({ type: "boot" });
    yield* signals.take.pipe(
      Effect.flatMap((signal) =>
        handle(signal).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestration signal failed").pipe(
              Effect.annotateLogs({ signal: signal.type, cause: Cause.pretty(cause) }),
            ),
          ),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );
    // Each limit reading may say a limit that holds briefs, new workers or the orchestrator back
    // no longer applies; the threads' own waits end in `ThreadRuntimes`.
    if (Option.isSome(kit.limitReadings)) {
      yield* kit.limitReadings.value.changes.pipe(
        Stream.runForEach(() => signals.offer({ type: "limitHeadroom" })),
        Effect.forkScoped,
      );
    }
    yield* hub.internalEvents(watched, "orchestration").pipe(
      Stream.runForEach((event) => signals.offer({ type: "hub", event })),
      Effect.forkScoped,
    );
    // Usage streams several times a turn from every thread, so only an orchestrator's reading below
    // the note's threshold is queued.
    yield* hub.serverEvents(Effect.succeed({ type: "threads.snapshot", threads: [] })).pipe(
      Stream.runForEach((event) => {
        if (event.type !== "thread.usage") return Effect.void;
        const workspaceId = orchestrators.get(event.threadId);
        if (workspaceId === undefined || contextNote(contextPct(event.usage), true).noted) {
          return Effect.void;
        }
        return signals.offer({ type: "contextLow", workspaceId }).pipe(Effect.asVoid);
      }),
      Effect.forkScoped,
    );

    return Orchestration.of({
      listWorkspaces: store.listWorkspaces,
      saveWorkspace,
      saveWorkspaceApproved,
      removeWorkspace,
      whileWorkspaceStays,
      open,
      setCharter,
      setPaused,
      changeCharter,
      changePaused,
      launchUnlessPaused,
      workerModelAvailability: (workspaceId) =>
        store
          .getWorkspace(workspaceId)
          .pipe(Effect.flatMap((state) => rosterAvailability(state.charter))),
      ledger,
      watchLedger,
      featureCards,
      watchFeatureCards,
      setStage,
      setGroup,
      archiveFeature,
      setFeaturePaused,
      renameFeature,
      detach,
      joinWorkspace: joinThread,
      joinTargets,
      pinAdopt,
      describeAdopt,
      adoptThread,
      releaseWorker,
      takeOverWorker,
      handoff,
      cancelSwitch,
      retrySwitch,
      checkModelChange,
      reopen,
      authorityOf,
      isDelegated: delegated,
      isWorkerSend,
      resolveWorkerParent,
      checkWorkerMessage,
      pinRepos,
      spawnNeedsApproval,
      describeSpawn,
      spawnWorker,
      releaseHeldBrief,
      manageHeldSpawn,
      briefFooter,
      startWorker,
      taskPreflight,
      withTaskStartup,
      addRepoNeedsApproval,
      describeAddRepo,
      addWorkerRepo,
      fullAutonomyAllows: allowsAtFull,
      workerMergesOwn,
      listWorkers,
      setStageAs,
      setGroupAs,
      answerWorker,
      askQuestion,
      forwardQuestion,
      answerWorkerQuestion,
      answerQuestionAsUser,
      dismissQuestionAsUser,
      keepsWakesOf,
      pendingWakesOf,
      scheduleWake,
      cancelWake,
      recordReport,
      checkSend,
      noteMessage,
      sendOnce,
      checkWorkerModel,
      addNote,
      noteQuietly,
    });
  }),
);
