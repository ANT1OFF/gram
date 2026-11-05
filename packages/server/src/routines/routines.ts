/**
 * Routines (docs/AGENTS_AND_FEATURES.md#routines): a workspace's saved brief on a schedule. Each time one
 * comes due it starts a worker in one of the workspace's projects, through the orchestrator's own
 * `spawnWorker`, or puts its brief in the orchestrator's next digest and wakes it. Either way it goes
 * the way a wake does: as the server's word, never as the user's, so what it starts has no more
 * authority than any worker or digest.
 *
 * A worker a routine starts is the workspace's orchestrator's worker like any other, spawned under
 * the same gates: the workspace's autonomy, its charter's worker models and cap, the limits that hold
 * or pause spawns, and every approval and merge rule after. A run that would need the user's card
 * (one worker past the cap) doesn't start one; it is recorded as failed, saying so.
 *
 * The engine keeps one timer per routine, as the wakes do (`wakes/thread-wakes.ts`): it sleeps until
 * the routine's `nextRunAt` and runs it then. Three rules hold every run:
 *
 * - A run missed while Gram was closed runs once, a minute after the next start, never once for each
 *   time it missed: the next run is reckoned from when it ran (`nextRunAfter`).
 * - While the worker its last run started is still live (or its held brief still waits), a due run
 *   starts nothing and is recorded as skipped.
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
  type RoutineRun,
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

/** The routine with `ran` recorded, and the next run reckoned from it unless `manual`. */
const recorded = (routine: Routine, ran: RoutineRun, manual: boolean): Routine => {
  const {
    waiting: _waiting,
    lastRun: _lastRun,
    nextRunAt: _nextRunAt,
    lastWorker,
    lastHeld,
    ...rest
  } = routine;
  const nextRunAt = manual
    ? routine.nextRunAt
    : routine.enabled
      ? nextRunAfter(routine.schedule, ran.at, routine.timeZone)
      : undefined;
  // A skipped or failed run keeps the worker it waits for; a new start or hold replaces it.
  const worker =
    ran.outcome === "started" ? ran.threadId : ran.outcome === "held" ? undefined : lastWorker;
  const held =
    ran.outcome === "held" ? ran.heldId : ran.outcome === "started" ? undefined : lastHeld;
  return {
    ...rest,
    lastRun: manual ? { ...ran, manual: true } : ran,
    ...(nextRunAt === undefined ? {} : { nextRunAt }),
    ...(worker === undefined ? {} : { lastWorker: worker }),
    ...(held === undefined ? {} : { lastHeld: held }),
  };
};

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
        if (!routine.enabled || routine.nextRunAt === undefined) {
          return yield* FiberMap.remove(timers, routine.id);
        }
        const now = yield* Clock.currentTimeMillis;
        const wait = after ?? Duration.millis(Math.max(0, routine.nextRunAt - now));
        yield* FiberMap.run(
          timers,
          routine.id,
          Effect.sleep(wait).pipe(Effect.andThen(due(routine.id))),
        );
      });

    /**
     * Why a run now would start a second worker beside one still going, or `undefined`: the worker
     * the last started run made is live on the ledger, or the brief its held run left still waits.
     */
    const overlap = (routine: Routine, state: WorkspaceState) =>
      Effect.gen(function* () {
        if (routine.lastWorker === undefined && routine.lastHeld === undefined) return undefined;
        const ledger = yield* orchestration
          .ledger(state.workspace.id)
          .pipe(Effect.option, Effect.map(Option.getOrUndefined));
        if (routine.lastHeld !== undefined) {
          if (ledger?.held?.some((held) => held.id === routine.lastHeld) === true) {
            return "The brief its last run left held is still waiting to start.";
          }
        }
        if (routine.lastWorker === undefined) return undefined;
        const thread = yield* store
          .getThread(routine.lastWorker)
          .pipe(Effect.option, Effect.map(Option.getOrUndefined));
        if (thread === undefined || thread.parked) return undefined;
        const entry = ledger?.features
          .flatMap((feature) => feature.workers)
          .find((worker) => worker.threadId === routine.lastWorker);
        if (entry === undefined || !isLiveWorker(entry)) return undefined;
        return `The worker from its last run, "${thread.title}", is still live.`;
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
    const execute = (routine: Routine, state: WorkspaceState, now: number) =>
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
          yield* orchestration.addNote(
            workspaceId,
            routineNote(routine),
            `routine "${routine.name}" is due`,
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
          branch: `routine/${words}-${runStamp(now, routine.timeZone)}`,
          ...(target.model === undefined ? {} : { model: target.model }),
          clientRequestId: `routine:${routine.id}:${now}`,
          atLimit: "stay" as const,
          routine: { id: routine.id, name: routine.name },
        };
        // A spawn the user's card would decide (past the charter's cap) isn't one a schedule makes.
        if (yield* orchestration.spawnNeedsApproval(holder, input)) {
          const card = yield* orchestration.describeSpawn(holder, input);
          return {
            at: now,
            outcome: "failed",
            detail: detailOf(`It needs your approval, so no worker started: ${card}`),
          } satisfies RoutineRun;
        }
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
            return {
              at: now,
              outcome: "started",
              threadId: spawned.threadId,
              ...(spawned.queued === undefined ? {} : { detail: detailOf(spawned.queued) }),
            };
          }),
          Effect.catch((e) =>
            Effect.succeed({
              at: now,
              outcome: "failed",
              detail: detailOf(e.message.replace(/^[a-z_]+: /, "")),
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

    /** The routine's run comes due: it runs, waits on a pause, or is skipped behind a live one. */
    const due = (id: string): Effect.Effect<void> =>
      lock
        .withPermits(1)(
          Effect.gen(function* () {
            const routine = routines.get(id);
            if (routine === undefined || !routine.enabled || routine.nextRunAt === undefined)
              return;
            const now = yield* Clock.currentTimeMillis;
            if (now < routine.nextRunAt) return yield* arm(routine);
            const state = yield* workspaceOf(routine.workspaceId);
            if (state === undefined) return yield* drop(routine);
            if (state.paused !== undefined) {
              if (routine.waiting !== "paused") {
                yield* write({ ...routine, waiting: "paused" });
                yield* changed(routine.workspaceId);
              }
              return yield* arm(routine, ROUTINE_PAUSE_RETRY);
            }
            const busy = yield* overlap(routine, state);
            const ran: RoutineRun =
              busy !== undefined
                ? { at: now, outcome: "skipped", detail: busy }
                : yield* execute(routine, state, now);
            const next = recorded(routine, ran, false);
            yield* write(next);
            yield* arm(next);
            yield* changed(routine.workspaceId);
            yield* noteFailure(routine, ran);
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

    /** Refuses a routine its workspace can't run: a project outside it, a name taken, a bad zone. */
    const check = (state: WorkspaceState, routine: Routine) =>
      Effect.gen(function* () {
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

    const create: RoutinesShape["create"] = (workspaceId, draft, author) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
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
            name: draft.name.trim(),
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

    const update: RoutinesShape["update"] = (id, patch) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const before = yield* get(id);
          const state = yield* store.getWorkspace(before.workspaceId);
          const now = yield* Clock.currentTimeMillis;
          const { nextRunAt: _next, waiting: _waiting, ...rest } = before;
          const merged = {
            ...rest,
            ...(patch.name === undefined ? {} : { name: patch.name.trim() }),
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
          const busy = yield* overlap(routine, state);
          if (busy !== undefined) return yield* new InvalidState({ message: busy });
          const now = yield* Clock.currentTimeMillis;
          const ran = yield* execute(routine, state, now);
          const next = recorded(routine, ran, true);
          yield* write(next);
          yield* changed(routine.workspaceId);
          yield* noteFailure(routine, ran);
          return next;
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

    const start: RoutinesShape["start"] = Effect.gen(function* () {
      if (started) return;
      started = true;
      const now = yield* Clock.currentTimeMillis;
      for (const routine of routines.values()) {
        if (!routine.enabled || routine.nextRunAt === undefined) continue;
        // Missed while Gram was closed: once, shortly after the start, never once per miss.
        yield* routine.nextRunAt <= now ? arm(routine, ROUTINE_CATCH_UP_DELAY) : arm(routine);
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
