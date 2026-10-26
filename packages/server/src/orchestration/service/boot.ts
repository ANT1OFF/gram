// Boot: what the service does once at start, before any other
// signal: setting aside an outbox it can't read, rebuilding the in-memory state from the store, and
// arming every timer, delivery and resume a restart left owed.
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
    deliverOwedQuestions,
    noteRestart,
    followPark,
    resumeHandoff,
    wake,
    armRecovery,
  } = deps;

  /** After a restart: forget a delivery the crash interrupted, and catch each orchestrator up once. */
  const onBoot = Effect.gen(function* () {
    const threads = yield* store.listThreads;
    const settings = yield* store.getSettings;
    const cutOff = new Set<ThreadId>(runtimes.cutAtBoot.map((turn) => turn.threadId));
    // First, so the states read below carry the pause and no restart acts on an empty outbox.
    for (const state of yield* store.listWorkspaces) yield* quarantineOutbox(state.workspace.id);
    for (const state of yield* store.listWorkspaces) {
      const holder = state.workspace.orchestratorThreadId;
      if (holder === undefined || !threads.some((thread) => thread.id === holder)) continue;
      orchestrators.set(holder, state.workspace.id);
      // The pairs the last digest told of, so a restart doesn't wake on each of them again.
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
        // Which repo each of its other worktrees is, so the ledger can place its PRs at once.
        yield* sampleExtras(worker);
        // When a request was asked isn't stored, so one that outlived a restart counts from now.
        for (const request of yield* store.listRequests(worker.id)) {
          yield* onRequest(worker.id, request.id, request.kind);
        }
      }
      // Every worker is cold after a restart, and no turn will end to arm a hold that was left.
      yield* armHolds(state, threads);
      // One that fell due while the app was down fires now.
      yield* armAlarms(state.workspace.id);
      // And a limit pause whose window reset meanwhile resumes now.
      yield* armLimitResume(state.workspace.id);
      // A resume's batches carry on where they were; one past its time goes now.
      if (state.paused === undefined) yield* armPauseResumes(state.workspace.id);
      // And a question whose triage ran out meanwhile goes to the user now.
      yield* armQuestionTimers(state.workspace.id);
      // A decision whose notice a crash cut off, or a send failed, reaches its worker now.
      yield* deliverOwedQuestions(state.workspace.id);
      // Nor will the turn a report was filed in end: the next turn is one of its own.
      yield* updateOutbox(state.workspace.id, (outbox) => {
        const reported = Object.entries(outbox.workers).filter(([, memo]) => memo.reportInTurn);
        if (reported.length === 0) return [outbox, undefined];
        const workers = { ...outbox.workers };
        for (const [id, { reportInTurn: _, ...memo }] of reported) workers[id] = memo;
        return [{ ...outbox, workers }, undefined];
      });
      // Noted while paused too: the note waits in the outbox for the first digest after the
      // resume, when nothing will say it again.
      const restartNoted = yield* noteRestart(
        state,
        threads,
        cutOff,
        continueAfterRestart(settings),
      );
      // The turn that carried it died with the process, so the same generation is built again.
      yield* updateOutbox(state.workspace.id, (outbox) => {
        if (outbox.inFlight === undefined) return [outbox, undefined];
        const { inFlight: _, ...rest } = outbox;
        return [rest, undefined];
      });
      const thread = threads.find((each) => each.id === holder);
      if (thread !== undefined) {
        // The park first: it gives up a handoff that would otherwise resume in a parked thread.
        yield* followPark(state.workspace.id, thread);
        yield* resumeHandoff(state.workspace.id, thread);
      }
      if (state.paused === undefined && thread?.parked !== true) {
        // A worker cut off mid-turn reads `working` before and after, which no diff shows, and a
        // note left waiting (a wake that fell due) was owed a digest before the restart.
        const left = yield* readOutbox(state.workspace.id);
        const noted = left.notes.length > 0 || (left.dueWakes ?? []).length > 0;
        yield* wake(state.workspace.id, AWAY_REASON, restartNoted || noted);
      }
      // Its looks died with the process, and the user was told of the pause before it.
      if (state.paused !== undefined && inErrorPause(state.paused)) {
        recovering.set(state.workspace.id, 0);
        yield* armRecovery(state.workspace.id);
      }
    }
    // Last, once the restart continuation has passed over each worker with a queue: that queue
    // is what continues it.
    yield* runtimes.sendQueuedAtBoot;
  });

  return { onBoot };
};
