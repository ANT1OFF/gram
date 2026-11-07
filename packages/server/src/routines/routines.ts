/**
 * Routines (docs/AGENTS_AND_FEATURES.md#routines): each of a workspace's routines, kept in its charter
 * (`OrchestratorCharter.routines`), comes due on its schedule and starts a worker in one of the
 * workspace's projects through the orchestrator's own `spawnWorker`, or puts its brief in the
 * orchestrator's next digest and wakes it. Either way it goes the way a wake does: as the server's
 * word, never as the user's, so what it starts has no more authority than any worker or digest.
 * What a routine is, the charter says; how its runs stand (next run, last run, its claim) the
 * workspace's outbox keeps, under the routine's id (`RoutineState`).
 *
 * A worker a routine starts is the workspace's orchestrator's worker like any other, spawned under
 * the same gates: the workspace's autonomy, its charter's worker models and cap, the limits that hold
 * or pause spawns, and every approval and merge rule after. Its spawn is `unattended`: what would ask
 * the user (one worker past the cap, the limit threshold's question) refuses instead, the cap checked
 * under the spawn's own lock, and the run is recorded as failed, saying so. A run never raises a card.
 *
 * The engine keeps one timer per routine, as the wakes do (`wakes/thread-wakes.ts`): it sleeps until
 * the routine's `nextRunAt` and runs it then.
 *
 * Each run is one occurrence, and a routine has at most one unsettled occurrence at a time, kept on
 * it as its `claim`. The claim is written before the run starts anything, and its `requestId`
 * (`routine:<id>:<slot>`) is the spawn's request id, so the worker it makes has one thread id
 * however often the run is retried. An occurrence moves through:
 *
 *   pending ──spawn──▶ held ──release──▶ spawning ──brief sent──▶ live ──finishes──▶ settled
 *      │                  │ (cancelled or dropped) ─────────────────────────────────▶ settled
 *      ├──spawn──▶ spawning (a crash here leaves a worker without its brief)
 *      └──refused, or the orchestrator noted────────────────────────────────────────▶ settled
 *
 * Its phase is read from durable facts alone, never remembered: a held brief whose request id is
 * the claim's (held), the thread that id names without its spawn's audit entry (spawning), with it
 * and live on the ledger (live), or neither (pending, unless it got as far as a brief or a thread,
 * then settled). It is read under `withHeldReleases`, the lock every release and cancel of a held
 * brief takes from taking the brief out to its worker existing, so the phase is never read in the
 * gap between held and spawning. A due run, or Run now:
 *
 * - held or live: starts nothing, recorded as skipped (Run now is refused);
 * - spawning: finishes making that worker (the spawn, retried with the claim's request id, sends the
 *   brief a crash kept from it), and records it as the run;
 * - pending: resumes it when it is this slot's (a restart cut it short), else drops it (a claim for a
 *   slot the schedule no longer has, or a Run now a restart cut short);
 * - settled, or none: a new occurrence for the slot, unless another worker of the routine is live or
 *   another brief of it is held.
 *
 * After its spawn the claim is kept while the occurrence is held, spawning or live, and cleared once
 * it is settled. Two more rules hold every run:
 *
 * - A run missed while Gram was closed runs once, a minute after the next start, never once for each
 *   time it missed: the next run is reckoned from when it ran (`nextRunAfter`). A routine with a
 *   claim is looked at then too, so a worker a Run now left without its brief is finished.
 * - A paused workspace pauses its routines: a run that falls due waits, marked `waiting`, and runs
 *   once when the workspace resumes.
 */
import {
  InvalidState,
  NotFound,
  ROUTINE_RUN_DETAIL_MAX,
  routineScheduleText,
  routineSlug,
  type ModelRef,
  type ProjectId,
  type RoutineClaim,
  type RoutineId,
  type RoutineRun,
  type RoutineSchedule,
  type RoutineState,
  type RoutineStatus,
  type Thread,
  type ThreadId,
  type WorkspaceId,
  type WorkspaceRoutine,
  type WorkspaceState,
} from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { EventHub } from "../events/event-hub.ts";
import { redactText } from "../logging/redact.ts";
import { isLiveWorker } from "../orchestration/ledger.ts";
import { readOutbox, workerThreadId } from "../orchestration/outbox.ts";
import { workerModelLabel } from "../orchestration/rules.ts";
import { Orchestration } from "../orchestration/service.ts";
import { withBriefFooter } from "../orchestration/user-words.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import type { Handlers } from "../rpc/handlers/common.ts";
import { localZone } from "../zone-time.ts";
import { nextRunAfter, runStamp } from "./schedule.ts";

/** How long after the server starts a run it missed while Gram was closed runs. */
export const ROUTINE_CATCH_UP_DELAY = Duration.minutes(1);
/** How soon a due run that waits on its workspace's pause looks again. */
export const ROUTINE_PAUSE_RETRY = Duration.minutes(1);

export interface RoutinesShape {
  /** The workspace's routines as its charter has them, by name, each with how its runs stand. */
  readonly list: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<ReadonlyArray<RoutineStatus>, NotFound>;
  /**
   * The user's Run now: a run off the schedule, which leaves the next run where it was. Refused
   * while the workspace is paused or a run of it is still going, rather than recorded as skipped.
   */
  readonly runNow: (
    workspaceId: WorkspaceId,
    id: RoutineId,
  ) => Effect.Effect<RoutineStatus, NotFound | InvalidState>;
  /**
   * Arms every routine, one that fell due while Gram was closed, or that has a claim, from
   * `ROUTINE_CATCH_UP_DELAY` on. Called once, after the app tools are registered: a run opens a
   * worker's session, which keeps the tool list it opened with.
   */
  readonly start: Effect.Effect<void>;
}

export class Routines extends Context.Service<Routines, RoutinesShape>()("@gram/server/Routines") {}

/**
 * A routine as the engine works on it: what the charter says, its run state from the outbox, and
 * which workspace it is in. `enabled` is the charter's `off` turned round.
 */
interface Routine extends RoutineState {
  readonly workspaceId: WorkspaceId;
  readonly id: RoutineId;
  readonly name: string;
  readonly brief: string;
  readonly schedule: RoutineSchedule;
  readonly project?: ProjectId | undefined;
  readonly model?: ModelRef | undefined;
  readonly target?: "orchestrator" | undefined;
  readonly enabled: boolean;
  /** The charter's generation for it now; `generation` is the one `nextRunAt` was reckoned for. */
  readonly charterGeneration: number;
}

/** The schedule as `RoutineState.scheduleKey` keeps it, to tell a new one from the one reckoned. */
const scheduleKeyOf = (schedule: RoutineSchedule) => JSON.stringify(schedule);

/**
 * Whether the routine's next run was reckoned for something it no longer is: none yet, another
 * schedule, or before an off and on (`generation`). Such a routine is reckoned again from now; a
 * run never starts on what it was.
 */
const stale = (routine: Routine) =>
  routine.nextRunAt === undefined ||
  routine.scheduleKey !== scheduleKeyOf(routine.schedule) ||
  (routine.generation ?? 0) !== routine.charterGeneration;

/** The routine reckoned again from `now`, for what it is now; a claim stays until it settles. */
const reckoned = (routine: Routine, now: number): Routine => {
  const { waiting: _waiting, ...rest } = routine;
  return {
    ...rest,
    nextRunAt: nextRunAfter(routine.schedule, now, localZone()),
    scheduleKey: scheduleKeyOf(routine.schedule),
    generation: routine.charterGeneration,
  };
};

/** The run state of `routine`, as the outbox keeps it. */
const stateOf = (routine: Routine): RoutineState => ({
  ...(routine.nextRunAt === undefined ? {} : { nextRunAt: routine.nextRunAt }),
  ...(routine.scheduleKey === undefined ? {} : { scheduleKey: routine.scheduleKey }),
  ...(routine.generation === undefined ? {} : { generation: routine.generation }),
  ...(routine.lastRun === undefined ? {} : { lastRun: routine.lastRun }),
  ...(routine.claim === undefined ? {} : { claim: routine.claim }),
  ...(routine.lastWorker === undefined ? {} : { lastWorker: routine.lastWorker }),
  ...(routine.lastHeld === undefined ? {} : { lastHeld: routine.lastHeld }),
  ...(routine.waiting === undefined ? {} : { waiting: routine.waiting }),
});

const notFound = (id: string) =>
  new NotFound({ entity: "routine", id, message: "No such routine. It may have been removed." });

const detailOf = (text: string) => redactText(text).slice(0, ROUTINE_RUN_DETAIL_MAX);

const timerKey = (workspaceId: WorkspaceId, id: RoutineId) => `${workspaceId}\u0000${id}`;

/** The brief a routine's worker gets: where it came from, the routine's words, and how to end. */
export const routineBrief = (routine: Pick<Routine, "name" | "schedule" | "brief">): string =>
  [
    `This worker was started by the scheduled routine "${routine.name.trim()}" (${routineScheduleText(routine.schedule)}), a brief kept in this workspace's charter. It is not a message the user just sent. Its brief:`,
    "",
    routine.brief.trim(),
    "",
    "When you are done, `report` what you found. If there was nothing to do, report `done` and say so in a line; don't open a pull request for nothing.",
  ].join("\n");

/** What the orchestrator's digest says when a routine for it comes due. */
export const routineNote = (routine: Pick<Routine, "name" | "schedule" | "brief">): string =>
  `Routine "${routine.name}" (${routineScheduleText(routine.schedule)}) is due. Its brief: ${routine.brief}`;

/**
 * The routine with `ran` recorded, its claim as the occurrence now stands (`undefined` once it
 * settled), and the next run reckoned from it unless `manual`.
 */
const recorded = (
  routine: Routine,
  ran: RoutineRun,
  manual: boolean,
  claim: RoutineClaim | undefined,
): Routine => {
  const {
    waiting: _waiting,
    lastRun: _lastRun,
    nextRunAt: _nextRunAt,
    claim: _claim,
    lastWorker,
    lastHeld: _lastHeld,
    ...rest
  } = routine;
  const nextRunAt = manual
    ? routine.nextRunAt
    : routine.enabled
      ? nextRunAfter(routine.schedule, ran.at, localZone())
      : undefined;
  const worker = claim?.threadId ?? (ran.outcome === "started" ? ran.threadId : lastWorker);
  const held = claim?.threadId === undefined ? claim?.heldId : undefined;
  return {
    ...rest,
    lastRun: manual ? { ...ran, manual: true } : ran,
    ...(nextRunAt === undefined ? {} : { nextRunAt }),
    ...(claim === undefined ? {} : { claim }),
    ...(worker === undefined ? {} : { lastWorker: worker }),
    ...(held === undefined ? {} : { lastHeld: held }),
  };
};

/** The routine without its claim: its occurrence settled, or was for a slot it no longer has. */
const withoutClaim = (routine: Routine, threadId?: ThreadId): Routine => {
  const { claim: _claim, lastHeld: _held, ...rest } = routine;
  return threadId === undefined ? rest : { ...rest, lastWorker: threadId };
};

/** Where an occurrence stands; see the lifecycle above. */
export type Phase =
  | { readonly phase: "pending" }
  | { readonly phase: "held"; readonly heldId: string }
  | { readonly phase: "spawning"; readonly threadId: ThreadId }
  | { readonly phase: "live"; readonly threadId: ThreadId; readonly title: string }
  | { readonly phase: "settled"; readonly threadId?: ThreadId };

/** The durable facts an occurrence's phase is read from, gathered by `phaseOf`. */
export interface OccurrenceFacts {
  /** The claim as kept: whether it was seen held, or seen to make a worker. */
  readonly claim: Pick<RoutineClaim, "heldId" | "threadId">;
  /** The held brief whose request id is the claim's, if one is in the outbox. */
  readonly heldId: string | undefined;
  /** The spawn of the claim's request id was begun: its thread id is in the outbox's requests. */
  readonly requested: boolean;
  /** The thread the claim's request id names: absent when no row has it. */
  readonly thread:
    | {
        readonly id: ThreadId;
        readonly title: string;
        /** Still this routine's worker in its workspace: not detached or moved. */
        readonly mine: boolean;
        /** Its spawn finished: the spawn's audit entry is there. */
        readonly spawned: boolean;
        /** Not parked, and live on the ledger (or not on it yet). */
        readonly live: boolean;
      }
    | undefined;
  /** The thread the claim's request id names was closed. */
  readonly closed: boolean;
}

/**
 * Where an occurrence stands, from its facts alone. A brief still held wins; then the thread its
 * request id names; and with neither, it is pending only while nothing durable says it got further
 * (it was seen held or making a worker, or that worker was closed), else it settled.
 */
export const occurrencePhase = (facts: OccurrenceFacts): Phase => {
  if (facts.heldId !== undefined) return { phase: "held", heldId: facts.heldId };
  const thread = facts.thread;
  if (thread === undefined) {
    const got =
      facts.claim.heldId !== undefined || facts.claim.threadId !== undefined || facts.closed;
    return got ? { phase: "settled" } : { phase: "pending" };
  }
  if (!thread.mine) return { phase: "settled" };
  if (!thread.spawned) return { phase: "spawning", threadId: thread.id };
  return thread.live
    ? { phase: "live", threadId: thread.id, title: thread.title }
    : { phase: "settled", threadId: thread.id };
};

/** Whether `phase` still holds the routine back: its brief waits, or its worker is made or live. */
const unsettled = (phase: Phase) =>
  phase.phase === "held" || phase.phase === "spawning" || phase.phase === "live";

/** The charter's routines that have ids: the write path gives every saved one one. */
const charterRoutines = (state: WorkspaceState) =>
  (state.charter.routines ?? []).flatMap((routine) =>
    routine.id === undefined ? [] : [routine as WorkspaceRoutine & { readonly id: RoutineId }],
  );

const routineOf = (
  workspaceId: WorkspaceId,
  routine: WorkspaceRoutine & { readonly id: RoutineId },
  state: RoutineState | undefined,
): Routine => ({
  ...state,
  workspaceId,
  id: routine.id,
  name: routine.name,
  brief: routine.brief,
  schedule: routine.schedule,
  ...(routine.project === undefined ? {} : { project: routine.project }),
  ...(routine.model === undefined ? {} : { model: routine.model }),
  ...(routine.target === undefined ? {} : { target: routine.target }),
  enabled: routine.off !== true,
  charterGeneration: routine.generation ?? 0,
});

const statusOf = (routine: Routine, charterRoutine: WorkspaceRoutine): RoutineStatus => ({
  routine: charterRoutine,
  id: routine.id,
  state: stateOf(routine),
});

export const RoutinesLive = Layer.effect(
  Routines,
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const hub = yield* EventHub;
    const orchestration = yield* Orchestration;
    /** Per workspace and routine id, the timer that runs it when it falls due. */
    const timers = yield* FiberMap.make<string>();
    /** The keys `timers` holds a timer under, which `FiberMap` doesn't list. */
    const armed = new Set<string>();
    const disarm = (key: string) =>
      Effect.sync(() => armed.delete(key)).pipe(Effect.andThen(FiberMap.remove(timers, key)));
    /** Every run and every look at the charters, one at a time: a run reads the state it records. */
    const lock = yield* Semaphore.make(1);
    /** Whether `start` has armed the routines; nothing runs before it. */
    let started = false;

    const changed = (workspaceId: WorkspaceId) =>
      hub.publish({ type: "routines.changed", workspaceId });

    const workspaceOf = (workspaceId: WorkspaceId) =>
      store.getWorkspace(workspaceId).pipe(Effect.option, Effect.map(Option.getOrUndefined));

    /** The routine `id` of the workspace as its charter and outbox have it now. */
    const load = (state: WorkspaceState, id: RoutineId) =>
      Effect.gen(function* () {
        const routine = charterRoutines(state).find((each) => each.id === id);
        if (routine === undefined) return undefined;
        const states = yield* orchestration.routineStates(state.workspace.id);
        return routineOf(state.workspace.id, routine, states[id]);
      });

    /** Stores the routine's run state in its workspace's outbox. */
    /**
     * Stores the routine's run state. Every engine write runs under `lock`, so they are one at a
     * time; the one writer outside it is the charter's prune of a removed routine. So a write finds
     * the state it read, or none: and one that finds none brings nothing back (`create` aside, for
     * the reckoning that starts a routine's state), so a run in flight can't revive a routine
     * removed meanwhile.
     */
    const write = (routine: Routine, create = false) =>
      orchestration
        .updateRoutineState(routine.workspaceId, routine.id, (current) =>
          current === undefined && !create ? undefined : stateOf(routine),
        )
        .pipe(Effect.asVoid);

    /** Runs the routine once `after` has passed, or at its `nextRunAt`; nothing while it is off. */
    const arm = (routine: Routine, after?: Duration.Duration): Effect.Effect<void> =>
      Effect.gen(function* () {
        const key = timerKey(routine.workspaceId, routine.id);
        const scheduled = routine.enabled && routine.nextRunAt !== undefined;
        if (!scheduled && after === undefined) return yield* disarm(key);
        const now = yield* Clock.currentTimeMillis;
        const wait = after ?? Duration.millis(Math.max(0, routine.nextRunAt! - now));
        armed.add(key);
        yield* FiberMap.run(
          timers,
          key,
          Effect.sleep(wait).pipe(Effect.andThen(due(routine.workspaceId, routine.id))),
        );
      });

    /** The workspace's ledger rows by thread, to tell a live worker from a finished one. */
    const ledgerRows = (workspaceId: WorkspaceId) =>
      orchestration.ledger(workspaceId).pipe(
        Effect.option,
        Effect.map(
          (ledger) =>
            new Map(
              (Option.getOrUndefined(ledger)?.features ?? [])
                .flatMap((feature) => feature.workers)
                .map((worker) => [worker.threadId as string, worker]),
            ),
        ),
      );

    type Rows = Effect.Success<ReturnType<typeof ledgerRows>>;

    /** Whether `thread` is a live worker: not parked, and live on the ledger (or not on it yet). */
    const liveWorker = (thread: Thread, rows: Rows) => {
      if (thread.parked) return false;
      const row = rows.get(thread.id);
      return row === undefined || isLiveWorker(row);
    };

    /**
     * Where `claim`'s occurrence stands, from durable facts alone. Read under `withHeldReleases`,
     * so a held brief being released is never between the outbox and its worker.
     */
    const phaseOf = (routine: Routine, claim: RoutineClaim, rows: Rows) =>
      Effect.gen(function* () {
        const workspaceId = routine.workspaceId;
        const outbox = readOutbox(yield* store.getOutbox(workspaceId)).state;
        const held = (outbox.heldBriefs ?? []).find(
          (brief) => brief.input.clientRequestId === claim.requestId,
        );
        const requested = outbox.requests[claim.requestId];
        const threadId = requested ?? workerThreadId(workspaceId, claim.requestId);
        const thread = Option.getOrUndefined(yield* store.getThread(threadId).pipe(Effect.option));
        // A spawn ends with its audit entry, as `spawnFor` finds a crash cut short by.
        const spawned =
          thread !== undefined &&
          (yield* store.listOrchestrationEvents(workspaceId, thread.createdAt)).some(
            (event) =>
              event.kind === "spawn" &&
              (event.data as { readonly threadId?: unknown } | null)?.threadId === thread.id,
          );
        const closed =
          thread === undefined &&
          requested !== undefined &&
          (yield* store.listClosed).some((each) => each.thread.id === threadId);
        return occurrencePhase({
          claim,
          heldId: held?.id,
          requested: requested !== undefined,
          closed,
          thread:
            thread === undefined
              ? undefined
              : {
                  id: thread.id,
                  title: thread.title,
                  mine:
                    thread.workspaceId === workspaceId &&
                    thread.spawnedBy?.routine?.id === routine.id,
                  spawned,
                  live: liveWorker(thread, rows),
                },
        });
      });

    /**
     * Why another of the routine's workers or briefs, not `claim`'s, holds a new run back: a worker
     * it started is live (one a finished worker resumed since, say), or a brief of it is held.
     */
    const otherBusy = (routine: Routine, claim: RoutineClaim | undefined, rows: Rows) =>
      Effect.gen(function* () {
        const outbox = readOutbox(yield* store.getOutbox(routine.workspaceId)).state;
        if (
          (outbox.heldBriefs ?? []).some(
            (brief) =>
              brief.input.routine?.id === routine.id &&
              brief.input.clientRequestId !== claim?.requestId,
          )
        ) {
          return { why: "A brief from its last run is held, waiting to start.", live: undefined };
        }
        const live = (yield* store.listThreads).find(
          (thread) =>
            thread.workspaceId === routine.workspaceId &&
            thread.spawnedBy?.routine?.id === routine.id &&
            liveWorker(thread, rows),
        );
        return live === undefined
          ? undefined
          : { why: `The worker from its last run, "${live.title}", is still live.`, live };
      });

    /** The orchestrator thread that follows the run, or why there is none. */
    const holderOf = (state: WorkspaceState) =>
      Effect.gen(function* () {
        const holder = state.workspace.orchestratorThreadId;
        if (holder === undefined) return undefined;
        const thread = yield* store.getThread(holder).pipe(Effect.option);
        return thread._tag === "Some" ? holder : undefined;
      });

    /** Starts what the routine is for, and says how it went. */
    const execute = (
      routine: Routine,
      state: WorkspaceState,
      now: number,
      claim: NonNullable<Routine["claim"]>,
    ) =>
      Effect.gen(function* () {
        const holder = yield* holderOf(state);
        if (holder === undefined) {
          return {
            at: now,
            outcome: "failed",
            detail:
              "The workspace has no orchestrator open to follow the run. Open its orchestrator, and the next run goes through.",
          } satisfies RoutineRun;
        }
        const workspaceId = state.workspace.id;
        if (routine.target === "orchestrator") {
          // Once per occurrence: a run a restart cut short after its note doesn't queue it twice.
          yield* orchestration.addNote(
            workspaceId,
            routineNote(routine),
            `routine "${routine.name}" is due`,
            claim.requestId,
          );
          return { at: now, outcome: "messaged" } satisfies RoutineRun;
        }
        const project = routine.project ?? state.workspace.homeProjectId;
        if (!state.workspace.projectIds.includes(project)) {
          return {
            at: now,
            outcome: "failed",
            detail:
              "Its project is no longer one of the workspace's. Edit the routine to pick another.",
          } satisfies RoutineRun;
        }
        const words = routineSlug(routine.name).slice("routine-".length);
        const input = {
          project,
          feature: routineSlug(routine.name),
          title: routine.name,
          brief: withBriefFooter(routineBrief(routine), yield* orchestration.briefFooter(holder)),
          branch: `routine/${words}-${runStamp(claim.slot, localZone())}`,
          ...(routine.model === undefined ? {} : { model: workerModelLabel(routine.model) }),
          // The claim's, kept before this call: a retry after a restart gets the same worker back.
          clientRequestId: claim.requestId,
          atLimit: "stay" as const,
          routine: { id: routine.id, name: routine.name },
          // Nobody answers a card for a schedule: what would ask is refused, under the spawn lock.
          unattended: true as const,
        };
        return yield* orchestration.spawnWorker(holder, input).pipe(
          Effect.map((spawned): RoutineRun => {
            if ("held" in spawned) {
              return {
                at: now,
                outcome: "held",
                heldId: spawned.id,
                detail: detailOf(spawned.note),
              };
            }
            if ("routeOffer" in spawned) {
              return {
                at: now,
                outcome: "failed",
                detail: "A usage limit stops its model. Pick another model for the routine.",
              };
            }
            const detail =
              spawned.existing === true
                ? "Finished starting the worker a restart had cut short."
                : spawned.queued;
            return {
              at: now,
              outcome: "started",
              threadId: spawned.threadId,
              ...(detail === undefined ? {} : { detail: detailOf(detail) }),
            };
          }),
          Effect.catch((e) =>
            Effect.succeed({
              at: now,
              outcome: "failed",
              detail: detailOf(e.message.replace(/^[a-z_]+: /, "").replace(/^[a-z_]+: /, "")),
            } satisfies RoutineRun),
          ),
        );
      });

    /**
     * Tells the orchestrator's next digest how a run went, quietly: the worker it started (its
     * brief is the routine's, so follow it like your own) or why it couldn't run. A skip or a
     * message to the orchestrator itself needs no note.
     */
    const noteFailure = (routine: Routine, ran: RoutineRun) =>
      ran.outcome === "failed"
        ? orchestration.noteQuietly(
            routine.workspaceId,
            `Routine "${routine.name}" (${routineScheduleText(routine.schedule)}) couldn't run: ${ran.detail ?? "no reason given"}`,
          )
        : ran.outcome === "started" && ran.threadId !== undefined
          ? orchestration.noteQuietly(
              routine.workspaceId,
              `Routine "${routine.name}" (${routineScheduleText(routine.schedule)}) started worker [thread ${ran.threadId}]. Follow it like your own; its brief is the routine's.`,
            )
          : Effect.void;

    /**
     * Runs `claim`'s occurrence (a new one, a resumed one, or one whose worker a crash left without
     * its brief), then reads where it stands: its claim stays while it is unsettled.
     */
    const runClaim = (
      routine: Routine,
      state: WorkspaceState,
      now: number,
      claim: RoutineClaim,
      manual: boolean,
    ) =>
      Effect.gen(function* () {
        yield* write({ ...routine, claim });
        const ran = yield* execute(routine, state, now, claim);
        const reached: RoutineClaim = {
          ...claim,
          ...(ran.outcome === "held" && ran.heldId !== undefined ? { heldId: ran.heldId } : {}),
          ...(ran.outcome === "started" && ran.threadId !== undefined
            ? { threadId: ran.threadId }
            : {}),
        };
        const phase = yield* phaseOf(routine, reached, yield* ledgerRows(routine.workspaceId));
        const kept: RoutineClaim | undefined = !unsettled(phase)
          ? undefined
          : phase.phase === "held"
            ? { ...reached, heldId: phase.heldId }
            : { ...reached, threadId: phase.threadId };
        return { routine: recorded(routine, ran, manual, kept), ran };
      });

    /**
     * One run of the routine, scheduled or Run now (`manual`), under `withHeldReleases`: the last
     * occurrence first, until it settles, then a new one. What it ran, or why it is busy.
     */
    const runOnce = (stored: Routine, state: WorkspaceState, now: number, manual: boolean) =>
      orchestration.withHeldReleases(
        stored.workspaceId,
        Effect.gen(function* (): Effect.fn.Return<
          | { readonly routine: Routine; readonly ran: RoutineRun }
          | { readonly routine: Routine; readonly busy: string }
          | { readonly routine: Routine; readonly stale: true }
        > {
          let routine = stored;
          const rows = yield* ledgerRows(routine.workspaceId);
          const last = routine.claim;
          if (last !== undefined) {
            const phase = yield* phaseOf(routine, last, rows);
            switch (phase.phase) {
              case "held":
                return {
                  routine: { ...routine, claim: { ...last, heldId: phase.heldId } },
                  busy: "A brief from its last run is held, waiting to start.",
                };
              case "live":
                return {
                  routine: { ...routine, claim: { ...last, threadId: phase.threadId } },
                  busy: `The worker from its last run, "${phase.title}", is still live.`,
                };
              case "spawning":
                // Its worker exists without its brief: finished, as the spawn's retry does.
                return yield* runClaim(routine, state, now, last, last.manual === true);
              case "pending":
                if (last.manual !== true && last.slot === routine.nextRunAt) {
                  return yield* runClaim(routine, state, now, last, false);
                }
                routine = withoutClaim(routine);
                break;
              case "settled":
                routine = withoutClaim(routine, phase.threadId);
                break;
            }
          }
          // Under the held-release lock, just before anything starts: the routine as the charter
          // has it now. Turned off, off and on, or rescheduled while this run waited: nothing new.
          if (!manual) {
            const current = yield* store.getWorkspace(routine.workspaceId).pipe(
              Effect.map((each) => charterRoutines(each).find((r) => r.id === routine.id)),
              Effect.orElseSucceed(() => undefined),
            );
            if (
              current === undefined ||
              current.off === true ||
              (current.generation ?? 0) !== routine.charterGeneration ||
              scheduleKeyOf(current.schedule) !== scheduleKeyOf(routine.schedule)
            ) {
              return { routine, stale: true as const };
            }
          }
          const busy = yield* otherBusy(routine, undefined, rows);
          if (busy !== undefined) {
            const shown =
              busy.live === undefined ? routine : { ...routine, lastWorker: busy.live.id };
            if (shown !== stored) yield* write(shown);
            return { routine: shown, busy: busy.why };
          }
          const claim: RoutineClaim = manual
            ? { requestId: `routine:${routine.id}:manual:${now}`, slot: now, manual: true }
            : {
                requestId: `routine:${routine.id}:${routine.nextRunAt}`,
                slot: routine.nextRunAt!,
              };
          return yield* runClaim(routine, state, now, claim, manual);
        }),
      );

    /**
     * Settles the routine's claim between its runs, when it has one: finishes a worker a crash left
     * without its brief, and drops a claim that settled or is stale. Nothing new starts.
     */
    const settleOnly = (stored: Routine, state: WorkspaceState, now: number) =>
      orchestration.withHeldReleases(
        stored.workspaceId,
        Effect.gen(function* () {
          const last = stored.claim;
          if (last === undefined) return undefined;
          const phase = yield* phaseOf(stored, last, yield* ledgerRows(stored.workspaceId));
          if (phase.phase === "spawning") {
            // Recorded as the run it was: a scheduled one moves the schedule on past its slot.
            return yield* runClaim(stored, state, now, last, last.manual === true);
          }
          const done =
            phase.phase === "settled" ||
            (phase.phase === "pending" && (last.manual === true || last.slot !== stored.nextRunAt));
          if (!done) return undefined;
          const next = withoutClaim(stored, phase.phase === "settled" ? phase.threadId : undefined);
          yield* write(next);
          yield* changed(stored.workspaceId);
          return undefined;
        }),
      );

    /** Saves a run, tells the windows, notes a failure for the orchestrator; arms nothing. */
    const record = (routine: Routine, ran: RoutineRun) =>
      Effect.gen(function* () {
        yield* write(routine);
        yield* changed(routine.workspaceId);
        yield* noteFailure(routine, ran);
      });

    /**
     * The routine's run comes due: it runs, waits on a pause, or is skipped behind a live one. Before
     * it is due, a routine with a claim only has the claim settled. This runs in the routine's own
     * timer fiber, which arming the next run replaces, so the run is saved, told and noted first and
     * the next run armed last.
     */
    const due = (workspaceId: WorkspaceId, id: RoutineId): Effect.Effect<void> =>
      lock
        .withPermits(1)(
          Effect.gen(function* () {
            const state = yield* workspaceOf(workspaceId);
            const stored = state === undefined ? undefined : yield* load(state, id);
            if (state === undefined || stored === undefined) {
              return yield* disarm(timerKey(workspaceId, id));
            }
            const now = yield* Clock.currentTimeMillis;
            // Waited on the lock while it went off and on, or got a new schedule: reckoned again
            // from now, never run on the time it had before.
            if (stored.enabled && stale(stored)) {
              const next = reckoned(stored, now);
              yield* write(next, true);
              yield* changed(workspaceId);
              return yield* arm(next);
            }
            const isDue =
              stored.enabled && stored.nextRunAt !== undefined && now >= stored.nextRunAt;
            if (state.paused !== undefined) {
              if (!isDue) return yield* arm(stored);
              if (stored.waiting !== "paused") {
                const waiting: Routine = { ...stored, waiting: "paused" };
                yield* write(waiting);
                yield* changed(stored.workspaceId);
                return yield* arm(waiting, ROUTINE_PAUSE_RETRY);
              }
              return yield* arm(stored, ROUTINE_PAUSE_RETRY);
            }
            if (!isDue) {
              const recovered = yield* settleOnly(stored, state, now);
              if (recovered !== undefined) yield* record(recovered.routine, recovered.ran);
              return yield* arm((yield* load(state, id)) ?? stored);
            }
            const outcome = yield* runOnce(stored, state, now, false);
            if ("stale" in outcome) {
              // Changed under it: the engine's look at the charter change reckons it again.
              const fresh = yield* load(state, id);
              if (fresh === undefined || !fresh.enabled)
                return yield* disarm(timerKey(workspaceId, id));
              const next = reckoned(fresh, now);
              yield* write(next, true);
              yield* changed(workspaceId);
              return yield* arm(next);
            }
            const next =
              "busy" in outcome
                ? recorded(
                    outcome.routine,
                    { at: now, outcome: "skipped", detail: outcome.busy },
                    false,
                    outcome.routine.claim,
                  )
                : outcome.routine;
            yield* record(
              next,
              "busy" in outcome
                ? { at: now, outcome: "skipped", detail: outcome.busy }
                : outcome.ran,
            );
            yield* arm(next);
          }),
        )
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("routine run failed").pipe(
              Effect.annotateLogs({ workspaceId, routineId: id, cause: String(cause) }),
            ),
          ),
        );

    /**
     * Brings the timers in line with the workspaces' charters: a routine added, turned on, or given
     * a new schedule is reckoned from now (never run for a time it missed); one removed or turned
     * off stops. With `catchUp`, the start's look: a run that fell due while Gram was closed, or a
     * routine with a claim, is looked at `ROUTINE_CATCH_UP_DELAY` from now, once.
     */
    const sync = (only: WorkspaceId | undefined, catchUp: boolean) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const states = yield* store.listWorkspaces;
          const live = new Set<string>();
          for (const state of states) {
            const workspaceId = state.workspace.id;
            const all = charterRoutines(state);
            const routines = all.filter((routine) => routine.off !== true);
            for (const routine of routines) live.add(timerKey(workspaceId, routine.id));
            if (only !== undefined && workspaceId !== only) continue;
            if (all.length === 0) continue;
            const runs = yield* orchestration.routineStates(workspaceId);
            let touched = false;
            // Off: no next run, so turning it back on reckons from then, never from a time it
            // missed; its claim and what its runs did stay, so a run still going is followed to
            // its end, and one a crash left half made is finished at the start's look.
            for (const charterRoutine of all.filter((routine) => routine.off === true)) {
              const stored = runs[charterRoutine.id];
              if (stored === undefined) continue;
              const routine = routineOf(workspaceId, charterRoutine, stored);
              if (routine.claim !== undefined) live.add(timerKey(workspaceId, routine.id));
              if (stored.nextRunAt !== undefined || stored.waiting !== undefined) {
                const { nextRunAt: _next, waiting: _waiting, ...rest } = routine;
                yield* write(rest);
                touched = true;
              }
              if (catchUp && routine.claim !== undefined) {
                yield* arm(routine, ROUTINE_CATCH_UP_DELAY);
              }
            }
            for (const charterRoutine of routines) {
              let routine = routineOf(workspaceId, charterRoutine, runs[charterRoutine.id]);
              if (stale(routine)) {
                // New, back on (however briefly it was off), or a new schedule: from now.
                routine = reckoned(routine, now);
                yield* write(routine, true);
                touched = true;
              }
              const missed = routine.nextRunAt! <= now;
              const resumed = routine.waiting === "paused" && state.paused === undefined;
              if (catchUp && (missed || routine.claim !== undefined)) {
                yield* arm(routine, ROUTINE_CATCH_UP_DELAY);
              } else if (resumed && started) {
                yield* arm(routine, Duration.zero);
              } else if (!armed.has(timerKey(workspaceId, routine.id)) || touched) {
                yield* arm(routine);
              }
            }
            if (touched) yield* changed(workspaceId);
          }
          // Routines removed or turned off, or of a workspace that went.
          // Deleting the key being visited is safe while a Set is iterated.
          for (const key of armed) {
            if (!live.has(key)) yield* disarm(key);
          }
        }),
      );

    const list: RoutinesShape["list"] = (workspaceId) =>
      Effect.gen(function* () {
        const state = yield* store.getWorkspace(workspaceId);
        const runs = yield* orchestration.routineStates(workspaceId);
        return charterRoutines(state)
          .map((routine) => statusOf(routineOf(workspaceId, routine, runs[routine.id]), routine))
          .toSorted((a, b) => a.routine.name.localeCompare(b.routine.name));
      });

    const runNow: RoutinesShape["runNow"] = (workspaceId, id) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const state = yield* store.getWorkspace(workspaceId);
          const routine = yield* load(state, id);
          if (routine === undefined) return yield* notFound(id);
          if (state.paused !== undefined) {
            return yield* new InvalidState({
              message: "The workspace is paused. Resume it to run its routines.",
            });
          }
          const now = yield* Clock.currentTimeMillis;
          const outcome = yield* runOnce(routine, state, now, true);
          if ("busy" in outcome) {
            if (outcome.routine !== routine) yield* changed(workspaceId);
            return yield* new InvalidState({ message: outcome.busy });
          }
          // Run now doesn't recheck the schedule (its own click is the go-ahead), so never stale.
          if ("stale" in outcome) {
            return yield* new InvalidState({ message: "The routine changed; try again." });
          }
          yield* record(outcome.routine, outcome.ran);
          // A resumed scheduled run moved the next run on: its timer follows.
          if (outcome.routine.nextRunAt !== routine.nextRunAt) yield* arm(outcome.routine);
          const charterRoutine = charterRoutines(state).find((each) => each.id === id)!;
          return statusOf(outcome.routine, charterRoutine);
        }),
      );

    // A charter change (a routine added, edited, turned off or removed) and a resume come as
    // `orchestration.changed`; a workspace removed as `workspaces.changed`.
    yield* hub
      .internalEvents(
        (event) => event.type === "orchestration.changed" || event.type === "workspaces.changed",
        "routines",
      )
      .pipe(
        Stream.runForEach((event) =>
          !started
            ? Effect.void
            : sync(event.type === "orchestration.changed" ? event.workspaceId : undefined, false),
        ),
        Effect.forkScoped,
      );

    // A held brief of a routine's run that starts later (the user's release, a reset, a probe) is
    // the routine's worker from then on: its row shows it. Display only: a run reads the phase from
    // the facts under `withHeldReleases`, never from this.
    yield* hub
      .internalEvents(
        (event) => event.type === "thread.upsert" && event.thread.spawnedBy?.routine !== undefined,
        "routine workers",
      )
      .pipe(
        Stream.runForEach((event) =>
          event.type !== "thread.upsert" || event.thread.workspaceId === undefined
            ? Effect.void
            : lock.withPermits(1)(
                Effect.gen(function* () {
                  const thread = event.thread;
                  const workspaceId = thread.workspaceId!;
                  const id = thread.spawnedBy?.routine?.id as RoutineId | undefined;
                  if (id === undefined) return;
                  const updated = yield* orchestration.updateRoutineState(
                    workspaceId,
                    id,
                    (state) => {
                      const claim = state?.claim;
                      if (state === undefined || claim?.heldId === undefined) return state;
                      if (claim.threadId !== undefined) return state;
                      if (thread.id !== workerThreadId(workspaceId, claim.requestId)) return state;
                      const { lastHeld: _held, ...rest } = state;
                      return {
                        ...rest,
                        claim: { ...claim, threadId: thread.id },
                        lastWorker: thread.id,
                      };
                    },
                  );
                  if (updated?.lastWorker === thread.id) yield* changed(workspaceId);
                }),
              ),
        ),
        Effect.forkScoped,
      );

    const start: RoutinesShape["start"] = Effect.gen(function* () {
      if (started) return;
      yield* sync(undefined, true);
      started = true;
    });

    return Routines.of({ list, runNow, start });
  }),
);

/** `routine.*`: Settings' list with each routine's runs, and its Run now; the user's own. */
export const routineHandlers = Effect.gen(function* () {
  const routines = yield* Routines;
  return {
    "routine.list": ({ workspaceId }) => routines.list(workspaceId),
    "routine.run": ({ workspaceId, id }) => routines.runNow(workspaceId, id),
  } satisfies Partial<Handlers>;
});
