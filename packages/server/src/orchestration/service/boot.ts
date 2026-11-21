import { continueAfterRestart, type ThreadId, type WorkspaceId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { workersOf, inErrorPause, AWAY_REASON, type OrchestrationKit } from "./kit.ts";
import type { Digests } from "./digests.ts";
import type { HandoffPart } from "./handoff.ts";
import type { Workers } from "./workers.ts";
import type { Pauses } from "./pauses.ts";
import type { WakeAlarms } from "./wake-alarms.ts";
import type { WorkerQuestions } from "./questions.ts";
import type { Observers } from "./observers.ts";

/** What boot takes from the rest of the service. */
export interface BootDeps {
  readonly quarantineOutbox: Pauses["quarantineOutbox"];
  readonly onRequest: Observers["onRequest"];
  readonly armHolds: Workers["armHolds"];
  readonly armAlarms: WakeAlarms["armAlarms"];
  readonly armLimitResume: (workspaceId: WorkspaceId) => Effect.Effect<void>;
  readonly armPauseResumes: Pauses["armPauseResumes"];
  readonly reconcileQuestions: WorkerQuestions["reconcileQuestions"];
  readonly armQuestionTimers: WorkerQuestions["armQuestionTimers"];
  readonly deliverOwedQuestions: WorkerQuestions["deliverOwedQuestions"];
  readonly noteRestart: Observers["noteRestart"];
  readonly followPark: Pauses["followPark"];
  readonly resumeHandoff: HandoffPart["resumeHandoff"];
  readonly wake: Digests["wake"];
  readonly armRecovery: Pauses["armRecovery"];
}

/** The boot signal's handler. */
export const makeBoot = (kit: OrchestrationKit, deps: BootDeps) => {
  const {
    store,
    runtimes,
    orchestrators,
    readOutbox,
    knownOverlaps,
    workerWorkspaces,
    parkedWorkers,
    completedSeen,
    sampleExtras,
    updateOutbox,
    recovering,
  } = kit;
  const {
    quarantineOutbox,
    onRequest,
    armHolds,
    armAlarms,
    armLimitResume,
    armPauseResumes,
    armQuestionTimers,
    reconcileQuestions,
    deliverOwedQuestions,
    noteRestart,
    followPark,
    resumeHandoff,
    wake,
    armRecovery,
  } = deps;

  const onBoot = Effect.gen(function* () {
    const threads = yield* store.listThreads;
    const settings = yield* store.getSettings;
    const cutOff = new Set<ThreadId>(runtimes.cutAtBoot.map((turn) => turn.threadId));
    for (const state of yield* store.listWorkspaces) yield* quarantineOutbox(state.workspace.id);
    for (const state of yield* store.listWorkspaces) {
      yield* reconcileQuestions(state.workspace.id);
      const holder = state.workspace.orchestratorThreadId;
      if (holder === undefined || !threads.some((thread) => thread.id === holder)) continue;
      orchestrators.set(holder, state.workspace.id);
      const { snapshot } = yield* readOutbox(state.workspace.id);
      knownOverlaps.set(
        state.workspace.id,
        new Set(
          Object.entries(snapshot).flatMap(([threadId, worker]) =>
            worker.overlapsWith.map((other) => [threadId, other].toSorted().join(" ")),
          ),
        ),
      );
      for (const worker of workersOf(threads, state)) {
        workerWorkspaces.set(worker.id, state.workspace.id);
        if (worker.parked) parkedWorkers.add(worker.id);
        if (worker.completedAt !== undefined) completedSeen.add(worker.id);
        yield* sampleExtras(worker);
        for (const request of yield* store.listRequests(worker.id)) {
          yield* onRequest(worker.id, request.id, request.kind);
        }
      }
      yield* armHolds(state, threads);
      yield* armAlarms(state.workspace.id);
      yield* armLimitResume(state.workspace.id);
      if (state.paused === undefined) yield* armPauseResumes(state.workspace.id);
      yield* armQuestionTimers(state.workspace.id);
      yield* deliverOwedQuestions(state.workspace.id);
      yield* updateOutbox(state.workspace.id, (outbox) => {
        const reported = Object.entries(outbox.workers).filter(([, memo]) => memo.reportInTurn);
        if (reported.length === 0) return [outbox, undefined];
        const workers = { ...outbox.workers };
        for (const [id, { reportInTurn: _, ...memo }] of reported) workers[id] = memo;
        return [{ ...outbox, workers }, undefined];
      });
      const restartNoted = yield* noteRestart(
        state,
        threads,
        cutOff,
        continueAfterRestart(settings),
      );
      yield* updateOutbox(state.workspace.id, (outbox) => {
        if (outbox.inFlight === undefined) return [outbox, undefined];
        const { inFlight: _, ...rest } = outbox;
        return [rest, undefined];
      });
      const thread = threads.find((each) => each.id === holder);
      if (thread !== undefined) {
        yield* followPark(state.workspace.id, thread);
        yield* resumeHandoff(state.workspace.id, thread);
      }
      if (state.paused === undefined && thread?.parked !== true) {
        const left = yield* readOutbox(state.workspace.id);
        const noted = left.notes.length > 0 || (left.dueWakes ?? []).length > 0;
        yield* wake(state.workspace.id, AWAY_REASON, restartNoted || noted);
      }
      if (state.paused !== undefined && inErrorPause(state.paused)) {
        recovering.set(state.workspace.id, 0);
        yield* armRecovery(state.workspace.id);
      }
    }
    yield* runtimes.sendQueuedAtBoot;
  });

  return { onBoot };
};
