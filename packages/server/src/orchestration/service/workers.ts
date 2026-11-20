// Workers: `list_workers`, a worker's `report`, the mark on a worker the user types into (with the
// timer that lets it lapse), and whether a worker may merge its own PR.
import {
  autonomyOf,
  type HostId,
  isPinned,
  type Thread,
  type ThreadId,
  type WorkerReport,
  type WorkspaceState,
  type WorkspaceId,
  defaultSlotOf,
  inlineText,
} from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import { redactText } from "../../logging/redact.ts";
import { filterWorkers, ledgerOf, visibleFeatures, type WorkerFacts } from "../ledger.ts";
import { wakesOf, withNotes } from "../outbox.ts";
import { ledgerQuestions } from "../worker-questions.ts";
import { slotHereNow } from "../../runtime/model-slots.ts";
import {
  coordinationAllows,
  fullAutonomyAllows,
  rosterOf,
  workerModelLabel,
  USER_HOLD_IDLE_MS,
  userHoldLapsesAt,
  workerMergesOwnAtFull,
} from "../rules.ts";
import { heldOf, workersOf, pausedFeatureOf, type OrchestrationKit } from "./kit.ts";
import { type OrchestrationShape } from "./shape.ts";
import type { LedgerWatch } from "./ledger-watch.ts";
import type { Digests } from "./digests.ts";
import { orchestratorsMachine, workerMachine, type NamedMachine } from "./spawning.ts";

/** What workers take from the rest of the service. */
export interface WorkersDeps {
  readonly survey: LedgerWatch["survey"];
  readonly wakeFor: Digests["wakeFor"];
}

/** A joined machine as `list_workers` weighs whether to list it. */
type ListedMachine = NamedMachine & { readonly name: string; readonly onlineSince?: number };

/**
 * The joined machines `list_workers` names: the ones a worker of this orchestrator may go on
 * (`workerMachine`), less machines an embedder started for workers that are offline and hold
 * none of this orchestration's workers. Such a machine was made for one worker and went with it,
 * and a deployment that starts many leaves a long tail of them; listing them only crowds the
 * orchestrator's reading. A machine one of its workers is on stays, online or not.
 */
export const machinesForOrchestrator = <M extends ListedMachine>(
  machines: ReadonlyArray<M>,
  context: {
    readonly own: HostId | undefined;
    readonly ownOwner: string | undefined;
    readonly headless: boolean;
    /** The machines this orchestration's workers are on. */
    readonly inUse: ReadonlySet<string>;
  },
): ReadonlyArray<M> =>
  machines.filter((machine) => {
    if (machine.id === context.own || context.inUse.has(machine.id)) return true;
    if ("error" in workerMachine(machine, context)) return false;
    return !(machine.onDemand === "worker" && machine.onlineSince === undefined);
  });

/** Listing workers, their reports, and the user's holds on them. */
/** `list_workers`' `machines`: the joined machines, left out while none is. */
const machinesListed = (
  machines: ReadonlyArray<{ readonly name: string; readonly onlineSince?: number }>,
) =>
  machines.length === 0
    ? {}
    : { machines: machines.map((m) => ({ name: m.name, online: m.onlineSince !== undefined })) };

/**
 * Each worker on another machine with that machine's name and whether it is dialled in, so the
 * orchestrator reads where a worker runs on its row rather than matching ids.
 */
export const withMachines = <W extends { readonly hostId?: HostId | undefined }>(
  workers: ReadonlyArray<W>,
  machines: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly onlineSince?: number;
  }>,
): ReadonlyArray<W & { readonly machine?: { readonly name: string; readonly online: boolean } }> =>
  workers.map((worker) => {
    const machine =
      worker.hostId === undefined ? undefined : machines.find((m) => m.id === worker.hostId);
    return machine === undefined
      ? worker
      : { ...worker, machine: { name: machine.name, online: machine.onlineSince !== undefined } };
  });

export const makeWorkers = (kit: OrchestrationKit, deps: WorkersDeps) => {
  const {
    requireAuthority,
    app,
    rosterFor,
    findThread,
    listeningWorkspace,
    store,
    hosts,
    updateMemo,
    holdTimers,
    orchestrationChanged,
    updateOutbox,
    signals,
    readOutbox,
    runtimes,
    findWorkspace,
  } = kit;
  const { survey, wakeFor } = deps;

  const listWorkers: OrchestrationShape["listWorkers"] = (callerId, options) =>
    Effect.gen(function* () {
      const { thread, state } = yield* requireAuthority("list_workers", callerId);
      const found = yield* survey(state, false);
      const ownWakes = wakesOf(found.outbox, thread.id);
      const machines = kit.joinedMachines();
      const own = orchestratorsMachine(thread);
      const ledger = ledgerOf({
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
      });
      return {
        ...ledger,
        features: ledger.features.map((feature) => ({
          ...feature,
          workers: withMachines(feature.workers, machines),
        })),
        ...(ownWakes.length === 0 ? {} : { wakes: ownWakes }),
        ...(app === undefined ? {} : { app }),
        ...machinesListed(
          machinesForOrchestrator(machines, {
            own,
            ownOwner: own === undefined ? undefined : kit.ownerOf(own),
            headless: kit.headless !== undefined,
            inUse: new Set(
              ledger.features.flatMap((feature) =>
                feature.workers.flatMap((worker) =>
                  worker.hostId === undefined ? [] : [worker.hostId],
                ),
              ),
            ),
          }),
        ),
        autonomy: autonomyOf(state.charter),
        workerModels: yield* rosterFor(thread, state.charter).pipe(
          Effect.map((here) => rosterOf(here.roster, here.unavailable, here.catalogue)),
        ),
        ...(yield* orchestratorSlot(thread, state)),
      };
    });

  /**
   * The orchestrator's own model slot, when it follows a tier: which, what the orchestrator runs
   * on, and why that isn't the tier's model when nothing here fills it (it opened on what stood in).
   */
  const orchestratorSlot = (thread: Thread, state: WorkspaceState) =>
    Effect.gen(function* () {
      const slot = state.charter.orchestratorModel ?? defaultSlotOf(yield* store.getSettings);
      if (slot === undefined || isPinned(slot)) return {};
      const here = yield* slotHereNow(hosts, slot);
      const runsOn = [
        workerModelLabel(thread.model),
        ...(thread.model.variant === undefined ? [] : [thread.model.variant]),
      ].join(" · ");
      return {
        orchestratorModel: {
          follows: `tier:${slot.tier}${slot.agent === undefined ? "" : `:${slot.agent}`}`,
          runsOn,
          ...(here.missing === undefined ? {} : { unavailable: here.missing }),
        },
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
        ...(input.learned === undefined ? {} : { learned: redactText(input.learned) }),
        ...(input.verify === undefined ? {} : { verify: input.verify }),
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
   * Clears the board's "the user is talking to it" flag other than by a report, which says enough
   * by itself: the flag lapsing. The worker was the orchestrator's throughout and nothing waited on
   * the flag, so the next digest says so without a wake of its own.
   */
  const endHold = (workspaceId: WorkspaceId, worker: Thread) =>
    Effect.gen(function* () {
      yield* FiberMap.remove(holdTimers, worker.id);
      const ended = yield* updateOutbox(workspaceId, (outbox) => {
        const memo = outbox.workers[worker.id];
        if (memo?.userIntervened !== true) return [outbox, false];
        const note = `"${inlineText(worker.title)}" [thread ${worker.id}] sat idle ${USER_HOLD_IDLE_MS / 60_000} minutes after the user last wrote to it, so they are likely done talking to it.`;
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
        data: { threadId: worker.id, by: "lapsed" },
      });
      yield* orchestrationChanged(workspaceId);
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
      yield* endHold(state.workspace.id, thread);
    });

  // ---------------------------------------------------------------------------------------
  // What an orchestrator does to its own workers without a card: always, and at full autonomy
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

  const allowsCoordination: OrchestrationShape["coordinationAllows"] = (callerId, targetId) =>
    Effect.gen(function* () {
      const caller = yield* findThread(callerId);
      const target = yield* findThread(targetId);
      if (caller === undefined || target === undefined) return false;
      const state = yield* findWorkspace(caller.workspaceId);
      return coordinationAllows({
        caller,
        target,
        workspace: state?.workspace,
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
    armHold,
    armHolds,
    onHoldDue,
    allowsAtFull,
    allowsCoordination,
    workerMergesOwn,
  };
};

/** What `makeWorkers` makes, for the parts whose `deps` take some of it. */
export type Workers = ReturnType<typeof makeWorkers>;
