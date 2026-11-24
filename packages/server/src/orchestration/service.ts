import { makeSpawnBreaker } from "./spawn-breaker.ts";
import {
  idleCompactOf,
  effectiveCheckout,
  InvalidState,
  type ServerEvent,
  type Thread,
} from "@gram/contracts";
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
import { contextNote, rosterOf, userHoldLapsesAt } from "./rules.ts";
import { sameTaskModel } from "./task-selection.ts";
import { type OrchestrationShape } from "./service/shape.ts";
import {
  makeOrchestrationKit,
  pausedFeatureOf,
  type Signal,
  heldByUser,
  workerModel,
} from "./service/kit.ts";
import { makeWorkerQuestions } from "./service/questions.ts";
import { makeMemoryQuestions } from "./service/memory-questions.ts";
import { makeLedgerWatch } from "./service/ledger-watch.ts";
import { makeHandoff } from "./service/handoff.ts";
import { moveKindOf } from "../runtime/agent-switch.ts";
import { makeProjects } from "./service/projects.ts";
import { makeSends } from "./service/sends.ts";
import { makeWorkerRepos } from "./service/worker-repos.ts";
import { makeAdoption } from "./service/adoption.ts";
import { makeFeatures } from "./service/features.ts";
import { makePauses } from "./service/pauses.ts";
import { makeDigests } from "./service/digests.ts";
import { makeWakeAlarms, preWakeOrOff } from "./service/wake-alarms.ts";
import { makeWorkers } from "./service/workers.ts";
import { makeSessionPolicy } from "./service/session-policy.ts";
import { makeTaskStartup } from "./service/task-startup.ts";
import { makeCharter, withRoutineRun } from "./service/charter.ts";
import { makeWorkspacesHere } from "./service/workspaces.ts";
import { makeObservers } from "./service/observers.ts";
import { makeBoot } from "./service/boot.ts";
import { makeHeldSpawns } from "./service/held-spawns.ts";
import { makeSpawning } from "./service/spawning.ts";
import { makeWorkerAdmitting } from "./service/worker-admitting.ts";
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
import { watched } from "./service/watched-events.ts";

export class Orchestration extends Context.Service<Orchestration, OrchestrationShape>()(
  "@gram/server/Orchestration",
) {}

export const OrchestrationLive = Layer.effect(
  Orchestration,
  Effect.gen(function* () {
    const kit = yield* makeOrchestrationKit;
    const admitting = makeWorkerAdmitting(kit.joinedMachines);
    const {
      store,
      hosts,
      hub,
      runtimes,
      publisher,
      composerPresence,
      rosterHere,
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
      noteStop,
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
      makeLedgerWatch(kit, {
        reconcileQuestions: (workspaceId) => reconcileQuestions(workspaceId),
      });
    if (kit.eventSink !== undefined) {
      yield* kit.eventSink.setFeatureCardRefresh((workspaceId) =>
        featureCards(workspaceId).pipe(
          Effect.asVoid,
          Effect.catchCause(() => Effect.void),
        ),
      );
    }

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

    const { policyFor, opening, modeAfterSwitch } = makeSessionPolicy(kit);

    const { openModel, taskPreflight, withTaskStartup } = makeTaskStartup(kit);

    const {
      cancelDelivery,
      armWake,
      wake,
      wakeFor,
      forgetReasons,
      deliveryFor,
      bootDelivery,
      onWakeDue,
      addNote,
      noteQuietly,
    } = makeDigests(kit, {
      survey,
      pause: (...args) => pause(...args),
      endRecovery: (workspaceId) => endRecovery(workspaceId),
    });

    const {
      keepsWakesOf,
      armAlarm,
      syncPrWatches,
      onWatchedPr,
      conditionHost,
      armAlarms,
      pendingWakesOf,
      scheduleWake,
      cancelWake,
      onWakeAlarm,
    } = makeWakeAlarms(kit, { wake, preWake: yield* preWakeOrOff });

    const {
      listWorkers,
      recordReport,
      armHold,
      armHolds,
      onHoldDue,
      allowsAtFull,
      allowsCoordination,
      workerMergesOwn,
    } = makeWorkers(kit, { survey, wakeFor });

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
      spawnFor: (...args) => spawnFor(...args),
      survey,
      spawnBreaker,
    });

    const {
      spawnNeedsApproval,
      checkSpawnMachine,
      spawnModel,
      describeSpawn,
      checkWorkerModel,
      spawnFor,
      joinGroup,
      spawnWorker,
      briefFooter,
      setRoutineAdmission,
    } = makeSpawning(kit, {
      admitting,
      outsideWorkspace,
      survey,
      repoNames,
      joinWorkspace,
      resolveProject,
      projectCall,
      pausedSpawnGate,
      spawnBreaker,
      routeGate,
      holdGate,
      routeHeld,
      limitGate,
      routePaused,
    });

    const { setCharter, changeCharter, checkCharter, afterCharter, editCharter } = makeCharter(
      kit,
      {
        wake,
        routinesChanged: orchestrationChanged,
      },
    );

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
      sendAfterHandoff,
      resumeHandoff,
      retrySwitch,
      cancelSwitch,
    } = makeHandoff(kit, {
      armWake,
      survey,
      endRecovery: (workspaceId) => endRecovery(workspaceId),
      armAlarms,
      deliveryFor,
      cancelDelivery,
    });

    const prepareTaskOrchestrator: OrchestrationShape["prepareTaskOrchestrator"] = (input) =>
      Effect.gen(function* () {
        const picked = input.orchestrator;
        if (picked === undefined) return undefined;
        const target = input.target;
        const state =
          "workspaceId" in target
            ? yield* store.getWorkspace(target.workspaceId)
            : (yield* store.listWorkspaces).find(
                (row) =>
                  row.workspace.projectIds.length === 1 &&
                  row.workspace.projectIds[0] === target.projectId,
              );
        if (state === undefined) return undefined;
        const holderId = state.workspace.orchestratorThreadId;
        const holder = holderId === undefined ? undefined : yield* findThread(holderId);
        if (holder === undefined) {
          const own = state.charter.orchestratorModel;
          if (own !== undefined && !("tier" in own) && sameTaskModel(own, picked)) return undefined;
          yield* setCharter(state.workspace.id, { ...state.charter, orchestratorModel: picked });
          return undefined;
        }
        const switching = holder.sessionSwitch?.target;
        if (sameTaskModel(holder.model, picked)) return undefined;
        if (switching !== undefined && sameTaskModel(switching, picked)) return undefined;
        const move = yield* moveKindOf(store, hosts, holder, picked);
        yield* handoff(state.workspace.id, "user", picked, move === "fresh" ? { fresh: true } : {});
        return move;
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

    const {
      saveWorkspace,
      commitWorkspace,
      whileWorkspaceStays,
      removeWorkspace,
      open,
      openFromProfile,
      arrive,
    } = yield* makeWorkspacesHere(kit, {
      forgetReasons,
      openModel,
      endRecovery,
      deliveryFor,
      checkCharter,
      afterCharter,
    });

    const {
      answerWorker,
      armQuestionTimers,
      deliverOwedQuestions,
      askQuestion,
      forwardQuestion,
      answerWorkerQuestion,
      withdrawQuestion,
      closeWorkerQuestion,
      recordUserAnswer,
      withdrawQuestionsOf,
      reconcileQuestions,
      answerQuestionAsUser,
      dismissQuestionAsUser,
      userAnswers,
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
      admitting,
      wakeFor,
      survey,
      syncPrWatches,
      armAlarm,
      armHold,
      joinWorkspace,
      joinGroup,
      wake,
      withdrawQuestionsOf,
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
      withdrawQuestionsOf,
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
      reconcileQuestions,
      noteRestart,
      followPark,
      resumeHandoff,
      wake,
      armRecovery,
    });

    yield* runtimes.observe({
      onTurnStart: (thread, turnId) =>
        signals.offer({ type: "turnStart", thread, turnId }).pipe(Effect.asVoid),
      onTurnEnd: (thread, end) =>
        signals.offer({ type: "turnEnd", thread, end }).pipe(Effect.asVoid),
      onQuiet: (thread, quiet) =>
        signals.offer({ type: "quiet", thread, active: quiet !== undefined }).pipe(Effect.asVoid),
      onRetrying: (threadId, on) =>
        Effect.sync(() => void (on ? retrying.add(threadId) : retrying.delete(threadId))),
      onUserInput: (thread) =>
        forgetStopped(thread).pipe(
          Effect.andThen(signals.offer({ type: "userInput", thread })),
          Effect.asVoid,
        ),
      onLimitWait: (thread, wait, ended) =>
        signals.offer({ type: "limitWait", thread, wait, ended }).pipe(Effect.asVoid),
      onTurnHeld: (thread) => recordHeldStop(thread),
    });
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
          const at = effectiveCheckout(thread);
          const observed = withOwnedBranch(thread, at, state.branch);
          const latest =
            observed === thread
              ? thread
              : yield* runtimes
                  .updateThread(thread.id, (current) => withOwnedBranch(current, at, state.branch))
                  .pipe(Effect.orElseSucceed(() => thread));
          yield* signals.offer({ type: "gitState", thread: latest, state });
        }),
      onRound: () => Effect.void,
      onWatchedPr,
    });
    yield* kit.conditions.register(conditionHost);
    yield* runtimes.setSessionPolicy({
      forThread: policyFor,
      opening,
      reviving: admitting.reviving,
      modeAfterSwitch,
      switchHandoff: (thread) =>
        Effect.succeed(
          thread.role === "orchestrator" && thread.workspaceId !== undefined
            ? bootDelivery(thread.workspaceId)
            : undefined,
        ),
    });

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
      compactIdleBeforeStop: idleCompactor.compactBeforeStop,
      routineStates: (workspaceId) =>
        readOutbox(workspaceId).pipe(Effect.map((outbox) => outbox.routineRuns ?? {})),
      updateRoutineState: (workspaceId, id, change) =>
        updateOutbox(workspaceId, (outbox) => withRoutineRun(outbox, id, change)),
      editCharter,
      setRoutineAdmission,
      setWorkerAdmission: admitting.set,
      listWorkspaces: store.listWorkspaces,
      saveWorkspace,
      commitWorkspace,
      removeWorkspace,
      whileWorkspaceStays,
      open,
      openFromProfile,
      setCharter,
      setPaused,
      changeCharter,
      changePaused,
      launchUnlessPaused,
      workerRoster: (workspaceId) =>
        store
          .getWorkspace(workspaceId)
          .pipe(
            Effect.flatMap((state) =>
              state.charter.workerModels === undefined
                ? Effect.succeed(undefined)
                : rosterHere(state.charter.workerModels, state.charter).pipe(
                    Effect.map((here) => rosterOf(here.roster, here.unavailable, here.catalogue)),
                  ),
            ),
          ),
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
      handoff,
      sendAfterHandoff,
      cancelSwitch,
      retrySwitch,
      checkModelChange,
      userChoseMode: (threadId) =>
        Effect.asVoid(Effect.sync(() => kit.openedInAuto.delete(threadId))),
      reopen,
      orchestratorOpening: (charter) =>
        openModel(charter).pipe(
          Effect.catchTag("AgentUnavailable", (error) =>
            Effect.fail(new InvalidState({ message: error.message })),
          ),
        ),
      arrive,
      authorityOf,
      memoryReaderOf: (threadId) =>
        Effect.gen(function* () {
          const authority = yield* authorityOf(threadId);
          if (authority !== undefined) return authority.state.workspace.id;
          const thread = yield* findThread(threadId);
          if (thread === undefined || thread.role !== undefined) return undefined;
          return (yield* listeningWorkspace(thread))?.workspace.id;
        }),
      memoryClosedReason: (threadId) =>
        Effect.gen(function* () {
          const thread = yield* findThread(threadId);
          if (thread?.role === "orchestrator") {
            return "This thread isn't its workspace's orchestrator right now: another thread holds the workspace, so its memory isn't open here.";
          }
          if (thread === undefined || thread.spawnedBy === undefined) {
            return "This thread is neither a workspace's orchestrator nor a worker reporting to one, so there is no memory to read here.";
          }
          const holder = (yield* findWorkspace(thread.workspaceId))?.workspace.orchestratorThreadId;
          if (holder === undefined) {
            return "Your workspace has no orchestrator open right now (it may be starting a fresh session), so its memory isn't open. Try again once the orchestrator is back.";
          }
          return "The orchestrator that started you no longer holds this workspace (another thread took it over), so its memory isn't open to you. Report to it and ask the user to adopt you into the current orchestrator.";
        }),
      isDelegated: delegated,
      noteStop,
      isWorkerSend,
      resolveWorkerParent,
      checkWorkerMessage,
      pinRepos,
      spawnNeedsApproval,
      checkSpawnMachine,
      spawnModel,
      describeSpawn,
      spawnWorker,
      releaseHeldBrief,
      manageHeldSpawn,
      briefFooter,
      taskPreflight,
      prepareTaskOrchestrator,
      withTaskStartup,
      addRepoNeedsApproval,
      describeAddRepo,
      addWorkerRepo,
      fullAutonomyAllows: allowsAtFull,
      coordinationAllows: allowsCoordination,
      workerMergesOwn,
      listWorkers,
      setStageAs,
      setGroupAs,
      answerWorker,
      askQuestion,
      forwardQuestion,
      answerWorkerQuestion,
      withdrawQuestion,
      closeWorkerQuestion,
      recordUserAnswer,
      withdrawQuestionsOf,
      answerQuestionAsUser,
      dismissQuestionAsUser,
      userAnswers,
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
      withHeldReleases: (workspaceId, effect) => kit.heldLock.withLock(workspaceId, effect),
      memoryQuestions: yield* makeMemoryQuestions(kit),
    });
  }),
);
