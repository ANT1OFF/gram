/**
 * Routines (docs/AGENTS_AND_FEATURES.md#routines): a workspace's saved brief on a schedule. Each time one
 * comes due it starts a worker in one of the workspace's projects, through the orchestrator's own
 * `spawnWorker`, or puts its brief in the orchestrator's next digest and wakes it. Either way it goes
 * the way a wake does: as the server's word, never as the user's, so what it starts has no more
 * authority than any worker or digest.
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
import { randomUUID } from "node:crypto";
import {
  InvalidState,
  NotFound,
  ROUTINE_RUN_DETAIL_MAX,
  ROUTINES_PER_WORKSPACE_MAX,
  Routine,
  routineScheduleText,
  routineSlug,
  type RoutineAuthor,
  type RoutineDraft,
  type RoutineId,
  type RoutinePatch,
  type RoutineClaim,
  type RoutineRun,
  type Thread,
  type ThreadId,
  type WorkspaceId,
  type WorkspaceState,
} from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { EventHub } from "../events/event-hub.ts";
import { redactText } from "../logging/redact.ts";
import { isLiveWorker } from "../orchestration/ledger.ts";
import { readOutbox, workerThreadId } from "../orchestration/outbox.ts";
import { Orchestration } from "../orchestration/service.ts";
import { withBriefFooter } from "../orchestration/user-words.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { SqlClient, type SqlError } from "../platform/unstable.ts";
import type { Handlers } from "../rpc/handlers/common.ts";
import { localZone } from "../zone-time.ts";
import { knownZone, nextRunAfter, runStamp } from "./schedule.ts";

/** How long after the server starts a run it missed while Gram was closed runs. */
export const ROUTINE_CATCH_UP_DELAY = Duration.minutes(1);
/** How soon a due run that waits on its workspace's pause looks again. */
export const ROUTINE_PAUSE_RETRY = Duration.minutes(1);

/** Who is saving a routine: the user in Settings, or the thread whose tool call it is. */
export interface RoutineAuthorship {
  readonly by: RoutineAuthor;
  readonly threadId?: ThreadId | undefined;
}

export interface RoutinesShape {
  /** The workspace's routines, by name. */
  readonly list: (workspaceId: WorkspaceId) => Effect.Effect<ReadonlyArray<Routine>, NotFound>;
  readonly get: (id: RoutineId) => Effect.Effect<Routine, NotFound>;
  /** A new routine, scheduled from now when it is on. */
  readonly create: (
    workspaceId: WorkspaceId,
    draft: RoutineDraft,
    author: RoutineAuthorship,
  ) => Effect.Effect<Routine, NotFound | InvalidState>;
  /** Changes the fields given; a new schedule or turning it on reckons the next run from now. */
  readonly update: (
    id: RoutineId,
    patch: RoutinePatch,
  ) => Effect.Effect<Routine, NotFound | InvalidState>;
  readonly remove: (id: RoutineId) => Effect.Effect<void, NotFound>;
  /**
   * The user's Run now: a run off the schedule, which leaves `nextRunAt` where it was. Refused while
   * the workspace is paused or the last run's worker is live, rather than recorded as skipped.
   */
  readonly runNow: (id: RoutineId) => Effect.Effect<Routine, NotFound | InvalidState>;
  /**
   * Arms every stored routine, one that fell due while Gram was closed `ROUTINE_CATCH_UP_DELAY`
   * from now. Called once, after the app tools are registered: a run opens a worker's session,
   * which keeps the tool list it opened with.
   */
  readonly start: Effect.Effect<void>;
}

export class Routines extends Context.Service<Routines, RoutinesShape>()("@gram/server/Routines") {}

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Routine));
const valid = Schema.decodeUnknownOption(Routine);

/**
 * A name and brief as they are kept: the name trimmed, and either refused when nothing is left.
 * Normalised before any check, so what passes is what is saved.
 */
const normalised = <P extends { readonly name?: string; readonly brief?: string }>(fields: P) =>
  Effect.gen(function* () {
    const name = fields.name?.trim();
    if (name !== undefined && name === "") {
      return yield* new InvalidState({ message: "Give the routine a name." });
    }
    if (fields.brief !== undefined && fields.brief.trim() === "") {
      return yield* new InvalidState({ message: "Write the brief it runs with." });
    }
    return name === undefined ? fields : { ...fields, name };
  });
const encode = (routine: Routine) => JSON.stringify(Schema.encodeSync(Routine)(routine));

const run = <A>(effect: Effect.Effect<A, SqlError>) =>
  effect.pipe(Effect.catch((error) => Effect.die(error)));

const notFound = (id: string) =>
  new NotFound({ entity: "routine", id, message: "No such routine. It may have been removed." });

const detailOf = (text: string) => redactText(text).slice(0, ROUTINE_RUN_DETAIL_MAX);

/** The brief a routine's worker gets: where it came from, then the routine's words. */
export const routineBrief = (routine: Pick<Routine, "name" | "schedule" | "brief">): string =>
  [
    `This worker was started by the routine "${routine.name}" (${routineScheduleText(routine.schedule).toLowerCase()}), a brief saved in this workspace that runs on a schedule. It is not a message the user just sent.`,
    "",
    routine.brief,
  ].join("\n");

/** What the orchestrator's digest says when a routine for it comes due. */
export const routineNote = (routine: Pick<Routine, "name" | "schedule" | "brief">): string =>
  `Routine "${routine.name}" (${routineScheduleText(routine.schedule).toLowerCase()}) is due. Its saved brief: ${routine.brief}`;

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
      ? nextRunAfter(routine.schedule, ran.at, routine.timeZone)
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

export const RoutinesLive = Layer.effect(
  Routines,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* ThreadStore;
    const hub = yield* EventHub;
    const orchestration = yield* Orchestration;
    /** Per routine id, the timer that runs it when it falls due. */
    const timers = yield* FiberMap.make<string>();
    /** Every save, removal and run, one at a time: a run reads the routine it records on. */
    const lock = yield* Semaphore.make(1);
    const routines = new Map<string, Routine>();
    /** Whether `start` has armed the stored routines; nothing runs before it. */
    let started = false;

    const changed = (workspaceId: WorkspaceId) =>
      hub.publish({ type: "routines.changed", workspaceId });

    const write = (routine: Routine) =>
      Effect.gen(function* () {
        const data = encode(routine);
        yield* run(
          sql`INSERT INTO routines (id, workspace_id, data) VALUES (${routine.id}, ${routine.workspaceId}, ${data})
            ON CONFLICT(id) DO UPDATE SET data = excluded.data, workspace_id = excluded.workspace_id`,
        );
        routines.set(routine.id, routine);
      });

    const drop = (routine: Routine) =>
      Effect.gen(function* () {
        yield* run(sql`DELETE FROM routines WHERE id = ${routine.id}`);
        routines.delete(routine.id);
        yield* FiberMap.remove(timers, routine.id);
      });

    const workspaceOf = (workspaceId: WorkspaceId) =>
      store.getWorkspace(workspaceId).pipe(Effect.option, Effect.map(Option.getOrUndefined));

    /** Runs `id` once `after` has passed, or at its `nextRunAt`; nothing while it is off. */
    const arm = (routine: Routine, after?: Duration.Duration): Effect.Effect<void> =>
      Effect.gen(function* () {
        const scheduled = routine.enabled && routine.nextRunAt !== undefined;
        if (!scheduled && after === undefined) {
          return yield* FiberMap.remove(timers, routine.id);
        }
        const now = yield* Clock.currentTimeMillis;
        const wait = after ?? Duration.millis(Math.max(0, routine.nextRunAt! - now));
        yield* FiberMap.run(
          timers,
          routine.id,
          Effect.sleep(wait).pipe(Effect.andThen(due(routine.id))),
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
        const target = routine.target;
        if (target.kind === "orchestrator") {
          // Once per occurrence: a run a restart cut short after its note doesn't queue it twice.
          yield* orchestration.addNote(
            workspaceId,
            routineNote(routine),
            `routine "${routine.name}" is due`,
            claim.requestId,
          );
          return { at: now, outcome: "messaged" } satisfies RoutineRun;
        }
        if (!state.workspace.projectIds.includes(target.projectId)) {
          return {
            at: now,
            outcome: "failed",
            detail:
              "Its project is no longer one of the workspace's. Edit the routine to pick another.",
          } satisfies RoutineRun;
        }
        const words = routineSlug(routine.name).slice("routine-".length);
        const input = {
          project: target.projectId,
          feature: routineSlug(routine.name),
          title: routine.name,
          brief: withBriefFooter(routineBrief(routine), yield* orchestration.briefFooter(holder)),
          branch: `routine/${words}-${runStamp(claim.slot, routine.timeZone)}`,
          ...(target.model === undefined ? {} : { model: target.model }),
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

    /** Tells the orchestrator's next digest of a run that couldn't start, quietly. */
    const noteFailure = (routine: Routine, ran: RoutineRun) =>
      ran.outcome !== "failed"
        ? Effect.void
        : orchestration.noteQuietly(
            routine.workspaceId,
            `Routine "${routine.name}" couldn't run: ${ran.detail ?? "no reason given"}`,
          );

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
          const stale =
            phase.phase === "settled" ||
            (phase.phase === "pending" && (last.manual === true || last.slot !== stored.nextRunAt));
          if (!stale) return undefined;
          const next = withoutClaim(stored, phase.phase === "settled" ? phase.threadId : undefined);
          yield* write(next);
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
    const due = (id: string): Effect.Effect<void> =>
      lock
        .withPermits(1)(
          Effect.gen(function* () {
            const stored = routines.get(id);
            if (stored === undefined) return;
            const state = yield* workspaceOf(stored.workspaceId);
            if (state === undefined) return yield* drop(stored);
            const now = yield* Clock.currentTimeMillis;
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
              else if (routines.get(id) !== stored) yield* changed(stored.workspaceId);
              return yield* arm(routines.get(id) ?? stored);
            }
            const outcome = yield* runOnce(stored, state, now, false);
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
              Effect.annotateLogs({ routineId: id, cause: String(cause) }),
            ),
          ),
        );

    const list: RoutinesShape["list"] = (workspaceId) =>
      Effect.gen(function* () {
        yield* store.getWorkspace(workspaceId);
        return [...routines.values()]
          .filter((routine) => routine.workspaceId === workspaceId)
          .toSorted((a, b) => a.name.localeCompare(b.name));
      });

    const get: RoutinesShape["get"] = (id) => {
      const routine = routines.get(id);
      return routine === undefined ? Effect.fail(notFound(id)) : Effect.succeed(routine);
    };

    /**
     * Refuses a routine its workspace can't run (a project outside it, a name taken, a bad zone) or
     * that wouldn't read back: what is saved always decodes, so a restart never drops it.
     */
    const check = (state: WorkspaceState, routine: Routine) =>
      Effect.gen(function* () {
        if (Option.isNone(valid(routine))) {
          return yield* new InvalidState({
            message: "That routine isn't complete: it needs a name, a brief and a schedule.",
          });
        }
        if (routine.target.kind === "worker") {
          if (!state.workspace.projectIds.includes(routine.target.projectId)) {
            return yield* new InvalidState({
              message: `That project isn't one of the "${state.workspace.name}" workspace's.`,
            });
          }
        }
        const name = routine.name.trim().toLowerCase();
        const taken = [...routines.values()].some(
          (other) =>
            other.id !== routine.id &&
            other.workspaceId === routine.workspaceId &&
            other.name.trim().toLowerCase() === name,
        );
        if (taken) {
          return yield* new InvalidState({
            message: `This workspace already has a routine named "${routine.name}".`,
          });
        }
        if (!knownZone(routine.timeZone)) {
          return yield* new InvalidState({ message: `Unknown time zone ${routine.timeZone}.` });
        }
      });

    const create: RoutinesShape["create"] = (workspaceId, given, author) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const draft = yield* normalised(given);
          const state = yield* store.getWorkspace(workspaceId);
          const count = [...routines.values()].filter(
            (routine) => routine.workspaceId === workspaceId,
          ).length;
          if (count >= ROUTINES_PER_WORKSPACE_MAX) {
            return yield* new InvalidState({
              message: `A workspace keeps at most ${ROUTINES_PER_WORKSPACE_MAX} routines; remove one first.`,
            });
          }
          const now = yield* Clock.currentTimeMillis;
          const timeZone = localZone();
          const enabled = draft.enabled ?? true;
          const routine: Routine = {
            id: randomUUID() as RoutineId,
            workspaceId,
            name: draft.name,
            brief: draft.brief,
            target: draft.target,
            schedule: draft.schedule,
            enabled,
            timeZone,
            createdAt: now,
            updatedAt: now,
            createdBy: author.by,
            ...(author.threadId === undefined ? {} : { createdByThread: author.threadId }),
            ...(enabled ? { nextRunAt: nextRunAfter(draft.schedule, now, timeZone) } : {}),
          };
          yield* check(state, routine);
          yield* write(routine);
          yield* arm(routine);
          yield* changed(workspaceId);
          return routine;
        }),
      );

    const update: RoutinesShape["update"] = (id, given) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const patch = yield* normalised(given);
          const before = yield* get(id);
          const state = yield* store.getWorkspace(before.workspaceId);
          const now = yield* Clock.currentTimeMillis;
          const { nextRunAt: _next, waiting: _waiting, ...rest } = before;
          const merged = {
            ...rest,
            ...(patch.name === undefined ? {} : { name: patch.name }),
            ...(patch.brief === undefined ? {} : { brief: patch.brief }),
            ...(patch.target === undefined ? {} : { target: patch.target }),
            ...(patch.schedule === undefined ? {} : { schedule: patch.schedule }),
            ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
            // Saved again, it is read in the zone the machine is in now.
            timeZone: localZone(),
            updatedAt: now,
          };
          // Turned on, or given a new time: reckoned from now, so a change never runs a missed one.
          const rescheduled =
            (patch.enabled === true && !before.enabled) ||
            (patch.schedule !== undefined &&
              JSON.stringify(patch.schedule) !== JSON.stringify(before.schedule)) ||
            merged.timeZone !== before.timeZone;
          const nextRunAt = !merged.enabled
            ? undefined
            : rescheduled || before.nextRunAt === undefined
              ? nextRunAfter(merged.schedule, now, merged.timeZone)
              : before.nextRunAt;
          const routine: Routine = {
            ...merged,
            ...(nextRunAt === undefined ? {} : { nextRunAt }),
            ...(before.waiting !== undefined && nextRunAt === before.nextRunAt
              ? { waiting: before.waiting }
              : {}),
          };
          yield* check(state, routine);
          yield* write(routine);
          yield* arm(routine);
          yield* changed(routine.workspaceId);
          return routine;
        }),
      );

    const remove: RoutinesShape["remove"] = (id) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const routine = yield* get(id);
          yield* drop(routine);
          yield* changed(routine.workspaceId);
        }),
      );

    const runNow: RoutinesShape["runNow"] = (id) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const routine = yield* get(id);
          const state = yield* store.getWorkspace(routine.workspaceId);
          if (state.paused !== undefined) {
            return yield* new InvalidState({
              message: "The workspace is paused. Resume it to run its routines.",
            });
          }
          const now = yield* Clock.currentTimeMillis;
          const outcome = yield* runOnce(routine, state, now, true);
          if ("busy" in outcome) {
            if (outcome.routine !== routine) yield* changed(routine.workspaceId);
            return yield* new InvalidState({ message: outcome.busy });
          }
          yield* record(outcome.routine, outcome.ran);
          // A resumed scheduled run moved the next run on: its timer follows.
          if (outcome.routine.nextRunAt !== routine.nextRunAt) yield* arm(outcome.routine);
          return outcome.routine;
        }),
      );

    // What a previous run left; a row that no longer decodes is dropped.
    for (const row of yield* run(
      sql<{ id: string; data: string }>`SELECT id, data FROM routines`,
    )) {
      const routine = decode(row.data);
      if (Option.isNone(routine)) {
        yield* Effect.logWarning("dropping a routine that no longer decodes").pipe(
          Effect.annotateLogs({ routineId: row.id }),
        );
        yield* run(sql`DELETE FROM routines WHERE id = ${row.id}`);
        continue;
      }
      routines.set(routine.value.id, routine.value);
    }

    // A resumed workspace's waiting routines run at once, not at the next look; a removed one's go.
    yield* hub
      .internalEvents(
        (event) => event.type === "orchestration.changed" || event.type === "workspaces.changed",
        "routines",
      )
      .pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            for (const routine of routines.values()) {
              if (event.type === "orchestration.changed") {
                if (routine.workspaceId !== event.workspaceId || routine.waiting !== "paused") {
                  continue;
                }
                const state = yield* workspaceOf(routine.workspaceId);
                if (state !== undefined && state.paused === undefined && started) {
                  yield* arm(routine, Duration.zero);
                }
                continue;
              }
              if ((yield* workspaceOf(routine.workspaceId)) === undefined) {
                yield* lock.withPermits(1)(drop(routine));
                yield* changed(routine.workspaceId);
              }
            }
          }),
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
          event.type !== "thread.upsert"
            ? Effect.void
            : lock.withPermits(1)(
                Effect.gen(function* () {
                  const thread = event.thread;
                  const routine = routines.get(thread.spawnedBy?.routine?.id ?? "");
                  const claim = routine?.claim;
                  if (routine === undefined || claim?.heldId === undefined) return;
                  if (claim.threadId !== undefined) return;
                  if (thread.id !== workerThreadId(routine.workspaceId, claim.requestId)) return;
                  const { lastHeld: _held, ...rest } = routine;
                  yield* write({
                    ...rest,
                    claim: { ...claim, threadId: thread.id },
                    lastWorker: thread.id,
                  });
                  yield* changed(routine.workspaceId);
                }),
              ),
        ),
        Effect.forkScoped,
      );

    const start: RoutinesShape["start"] = Effect.gen(function* () {
      if (started) return;
      started = true;
      const now = yield* Clock.currentTimeMillis;
      for (const routine of routines.values()) {
        // Missed while Gram was closed: once, shortly after the start, never once per miss. One
        // with a claim is looked at then too, whatever its next run: its occurrence may need its
        // worker finished, or may have settled while Gram was closed.
        const missed =
          routine.enabled && routine.nextRunAt !== undefined && routine.nextRunAt <= now;
        yield* missed || routine.claim !== undefined
          ? arm(routine, ROUTINE_CATCH_UP_DELAY)
          : arm(routine);
      }
    });

    return Routines.of({ list, get, create, update, remove, runNow, start });
  }),
);

/** `routine.*`: Settings' list, its saves and removals, and Run now; the user's own. */
export const routineHandlers = Effect.gen(function* () {
  const routines = yield* Routines;
  return {
    "routine.list": ({ workspaceId }) => routines.list(workspaceId),
    "routine.create": ({ workspaceId, draft }) =>
      routines.create(workspaceId, draft, { by: "user" }),
    "routine.update": ({ id, patch }) => routines.update(id, patch),
    "routine.remove": ({ id }) => routines.remove(id),
    "routine.run": ({ id }) => routines.runNow(id),
  } satisfies Partial<Handlers>;
});
