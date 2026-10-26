// Workers: `list_workers`, a worker's `report`, the user's hold on a
// worker they type into (with the timer that lets it lapse), releasing or taking over a worker, and
// whether a worker may merge its own PR.
import {
  autonomyOf,
  InvalidState,
  type Thread,
  type ThreadId,
  type WorkerReport,
  type WorkspaceState,
  type WorkspaceId,
} from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import { redactText } from "../../logging/redact.ts";
import { filterWorkers, ledgerOf, visibleFeatures, type WorkerFacts } from "../ledger.ts";
import { wakesOf, withNotes } from "../outbox.ts";
import { ledgerQuestions } from "../worker-questions.ts";
import {
  fullAutonomyAllows,
  rosterOf,
  USER_HOLD_IDLE_MS,
  userHoldLapsesAt,
  workerMergesOwnAtFull,
} from "../rules.ts";
import {
  heldOf,
  workersOf,
  allowedWorkerModels,
  pausedFeatureOf,
  type OrchestrationKit,
} from "./kit.ts";
import { type OrchestrationShape } from "./shape.ts";
import type { LedgerWatch } from "./ledger-watch.ts";
import type { Digests } from "./digests.ts";

/** What workers take from the rest of the service. */
export interface WorkersDeps {
  readonly survey: LedgerWatch["survey"];
  readonly wakeFor: Digests["wakeFor"];
  readonly wake: Digests["wake"];
}

/** Listing workers, their reports, and the user's holds on them. */
export const makeWorkers = (kit: OrchestrationKit, deps: WorkersDeps) => {
  const {
    requireAuthority,
    app,
    rosterAvailability,
    findThread,
    listeningWorkspace,
    store,
    updateMemo,
    holdTimers,
    orchestrationChanged,
    updateOutbox,
    signals,
    readOutbox,
    runtimes,
    findWorkspace,
  } = kit;
  const { survey, wakeFor, wake } = deps;

  const listWorkers: OrchestrationShape["listWorkers"] = (callerId, options) =>
    Effect.gen(function* () {
      const { thread, state } = yield* requireAuthority("list_workers", callerId);
      const found = yield* survey(state, false);
      const ownWakes = wakesOf(found.outbox, thread.id);
      return {
        ...ledgerOf({
          state,
          features: filterWorkers(
            visibleFeatures(found.features, (threadId) => found.lastActivityAt.get(threadId) ?? 0, {
              // Asking for archived workers by state is asking to see them.
              includeArchived:
                options.includeArchived === true || options.states?.includes("archived") === true,
              since: options.since,
            }),
            options,
          ),
          groups:
            options.includeArchived === true || options.states?.includes("archived") === true
              ? found.groups
              : found.groups.filter((group) => group.state !== "archived"),
          budget: found.budget,
          orchestratorEdits: found.outbox.orchestratorEdits,
          held: heldOf(found.outbox),
          questions: ledgerQuestions(found.outbox),
          now: found.now,
        }),
        ...(ownWakes.length === 0 ? {} : { wakes: ownWakes }),
        ...(app === undefined ? {} : { app }),
        autonomy: autonomyOf(state.charter),
        workerModels: rosterOf(
          allowedWorkerModels(thread, state.charter),
          yield* rosterAvailability(state.charter),
        ),
      };
    });

  const recordReport: OrchestrationShape["recordReport"] = (workerId, input) =>
    Effect.gen(function* () {
      const worker = yield* findThread(workerId);
      const state = worker === undefined ? undefined : yield* listeningWorkspace(worker);
      if (worker === undefined || state === undefined) return undefined;
      const report: WorkerReport = {
        threadId: workerId,
        state: input.state,
        summary: redactText(input.summary),
        ...(input.evidence === undefined
          ? {}
          : {
              evidence: {
                headSha: input.evidence.headSha,
                gate: redactText(input.evidence.gate).slice(0, 160),
                ...(input.evidence.pr === undefined
                  ? {}
                  : { pr: redactText(input.evidence.pr).slice(0, 200) }),
                nextStep: redactText(input.evidence.nextStep).slice(0, 240),
              },
            }),
        ...(input.prUrl === undefined ? {} : { prUrl: redactText(input.prUrl) }),
        ...(input.interface === undefined ? {} : { interface: redactText(input.interface) }),
        at: yield* Clock.currentTimeMillis,
      };
      yield* store.addWorkerReport(state.workspace.id, report);
      yield* updateMemo(state.workspace.id, workerId, (memo) => ({
        ...memo,
        userIntervened: false,
        reportInTurn: true,
      }));
      yield* FiberMap.remove(holdTimers, workerId);
      yield* orchestrationChanged(state.workspace.id);
      yield* wakeFor(
        state.workspace.id,
        { type: "report", worker: worker.title, state: input.state },
        worker,
      );
      return report;
    });

  /**
   * Ends the user's hold on a worker other than by a report, which says enough by itself: the
   * user handing it back, or the hold lapsing. The next digest says which, and one is scheduled,
   * since an orchestrator told nothing else would go on leaving the worker alone.
   */
  const endHold = (workspaceId: WorkspaceId, worker: Thread, by: "user" | "lapsed") =>
    Effect.gen(function* () {
      yield* FiberMap.remove(holdTimers, worker.id);
      const ended = yield* updateOutbox(workspaceId, (outbox) => {
        const memo = outbox.workers[worker.id];
        if (memo?.userIntervened !== true) return [outbox, false];
        const note =
          by === "user"
            ? `The user handed "${worker.title}" [thread ${worker.id}] back to you; you may message it again.`
            : `"${worker.title}" [thread ${worker.id}] sat idle ${USER_HOLD_IDLE_MS / 60_000} minutes after the user last wrote to it, so it is yours again; you may message it.`;
        return [
          withNotes(
            {
              ...outbox,
              workers: { ...outbox.workers, [worker.id]: { ...memo, userIntervened: false } },
            },
            [note],
          ),
          true,
        ];
      });
      if (!ended) return;
      yield* store.appendOrchestrationEvent(workspaceId, {
        at: yield* Clock.currentTimeMillis,
        kind: "released",
        data: { threadId: worker.id, by },
      });
      yield* orchestrationChanged(workspaceId);
      yield* wake(workspaceId, by === "user" ? "a worker was handed back" : "a hold lapsed", true);
    });

  const releaseWorker: OrchestrationShape["releaseWorker"] = (threadId) =>
    Effect.gen(function* () {
      const thread = yield* store.getThread(threadId);
      const state = yield* listeningWorkspace(thread);
      if (state === undefined) {
        return yield* new InvalidState({
          message: "This thread isn't a worker with an orchestrator listening.",
          threadId,
        });
      }
      yield* endHold(state.workspace.id, thread, "user");
    });

  // The user's hold has one way in, the one a typed message takes: queued as the runtime's
  // `onUserInput` is, so it lands in order with the turns and inputs around it.
  const takeOverWorker: OrchestrationShape["takeOverWorker"] = (threadId) =>
    Effect.gen(function* () {
      const thread = yield* store.getThread(threadId);
      if ((yield* listeningWorkspace(thread)) === undefined) {
        return yield* new InvalidState({
          message: "This thread isn't a worker with an orchestrator listening.",
          threadId,
        });
      }
      yield* signals.offer({ type: "userInput", thread });
    });

  /** Waits out `USER_HOLD_IDLE_MS` from the user's latest input, then looks again. */
  const armHold = (threadId: ThreadId, afterMs: number) =>
    FiberMap.run(
      holdTimers,
      threadId,
      Effect.sleep(Duration.millis(Math.max(0, afterMs))).pipe(
        Effect.andThen(signals.offer({ type: "holdDue", threadId })),
      ),
    ).pipe(Effect.asVoid);

  /** Arms the lapse of every hold on the workspace's workers, one overdue at once. */
  const armHolds = (state: WorkspaceState, threads: ReadonlyArray<Thread>) =>
    Effect.gen(function* () {
      const { workers } = yield* readOutbox(state.workspace.id);
      for (const worker of workersOf(threads, state)) {
        const memo = workers[worker.id];
        const lapsesAt = memo === undefined ? undefined : userHoldLapsesAt(memo);
        if (lapsesAt !== undefined) {
          yield* armHold(worker.id, lapsesAt - (yield* Clock.currentTimeMillis));
        }
      }
    });

  /**
   * A held worker that is done with its turn arms the lapse; one still in a turn, or waiting on a
   * request, is armed again by that turn's end.
   */
  const onHoldDue = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const thread = yield* findThread(threadId);
      const state = thread === undefined ? undefined : yield* listeningWorkspace(thread);
      if (thread === undefined || state === undefined) return;
      const memo = (yield* readOutbox(state.workspace.id)).workers[threadId];
      const lapsesAt = memo === undefined ? undefined : userHoldLapsesAt(memo);
      if (lapsesAt === undefined) return;
      const now = yield* Clock.currentTimeMillis;
      if (now < lapsesAt) return yield* armHold(threadId, lapsesAt - now);
      const status = yield* runtimes
        .status(threadId)
        .pipe(Effect.orElseSucceed((): WorkerFacts["status"] => "cold"));
      if (status !== "idle" && status !== "cold" && status !== "error") return;
      yield* endHold(state.workspace.id, thread, "lapsed");
    });

  // ---------------------------------------------------------------------------------------
  // Full autonomy's two delegations
  // ---------------------------------------------------------------------------------------

  const allowsAtFull: OrchestrationShape["fullAutonomyAllows"] = (callerId, targetId) =>
    Effect.gen(function* () {
      const caller = yield* findThread(callerId);
      const target = yield* findThread(targetId);
      if (caller === undefined || target === undefined) return false;
      const state = yield* findWorkspace(caller.workspaceId);
      return fullAutonomyAllows({
        caller,
        target,
        workspace: state?.workspace,
        charter: state?.charter,
        paused: state?.paused !== undefined || pausedFeatureOf(state, target) !== undefined,
      });
    }).pipe(Effect.catchCause(() => Effect.succeed(false)));

  const workerMergesOwn: OrchestrationShape["workerMergesOwn"] = (callerId) =>
    Effect.gen(function* () {
      const thread = yield* findThread(callerId);
      if (thread === undefined) return false;
      const state = yield* listeningWorkspace(thread);
      return workerMergesOwnAtFull({
        thread,
        workspace: state?.workspace,
        charter: state?.charter,
        paused: state?.paused !== undefined || pausedFeatureOf(state, thread) !== undefined,
      });
    }).pipe(Effect.catchCause(() => Effect.succeed(false)));

  return {
    listWorkers,
    recordReport,
    releaseWorker,
    takeOverWorker,
    armHold,
    armHolds,
    onHoldDue,
    allowsAtFull,
    workerMergesOwn,
  };
};

/** What `makeWorkers` makes, for the parts whose `deps` take some of it. */
export type Workers = ReturnType<typeof makeWorkers>;
