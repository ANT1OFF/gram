// Workspace routines (docs/AGENTS_AND_FEATURES.md#routines): a brief kept in the workspace's charter
// and run on a schedule. Each time one comes due it starts a fresh worker in one of the workspace's
// projects, or puts its brief in the orchestrator's next digest. What a routine is lives in the
// charter (`OrchestratorCharter.routines`), so every way of changing it goes through the charter's
// one write path; how its runs went lives in the workspace's outbox (`RoutineState`), and the
// server's engine (`packages/server/src/routines/`) reckons when it next runs.

import * as Schema from "effect/Schema";
import { ModelRef } from "./domain.ts";
import { ProjectId, ThreadId } from "./ids.ts";

/** The most routines one workspace keeps. */
export const ROUTINES_MAX = 8;
export const ROUTINE_NAME_MAX = 64;
export const ROUTINE_BRIEF_MAX = 4000;
/** The shortest interval a routine repeats at: an hour, so a routine never floods a workspace. */
export const ROUTINE_MIN_INTERVAL_HOURS = 1;
/** The longest interval: a week. */
export const ROUTINE_MAX_INTERVAL_HOURS = 168;
/** The longest detail a run keeps. */
export const ROUTINE_RUN_DETAIL_MAX = 500;

/** A routine's id, stable across renames: the key its runs are kept under. */
export const RoutineId = Schema.NonEmptyString.pipe(Schema.brand("RoutineId"));
export type RoutineId = typeof RoutineId.Type;

/** A 24-hour wall-clock time on this computer, `HH:MM`. */
export const RoutineTime = Schema.String.check(Schema.isPattern(/^([01]\d|2[0-3]):[0-5]\d$/));

/** Days as `Date.getDay` counts them, Sunday first, for a weekly routine's `day`. */
export const ROUTINE_DAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** Every day, or Monday to Friday, at `at`. */
export const DailySchedule = Schema.Struct({
  every: Schema.Literals(["day", "weekday"]),
  at: RoutineTime,
});
/** One day a week at `at`: `day` 0 (Sunday) to 6, absent is Monday. */
export const WeeklySchedule = Schema.Struct({
  every: Schema.Literal("week"),
  at: RoutineTime,
  day: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 }))),
});
/** Every `hours` hours, from the last run (or from when it was turned on). */
export const IntervalSchedule = Schema.Struct({
  every: Schema.Literal("hours"),
  hours: Schema.Int.check(
    Schema.isBetween({
      minimum: ROUTINE_MIN_INTERVAL_HOURS,
      maximum: ROUTINE_MAX_INTERVAL_HOURS,
    }),
  ),
});
export const RoutineSchedule = Schema.Union([DailySchedule, WeeklySchedule, IntervalSchedule]);
export type RoutineSchedule = typeof RoutineSchedule.Type;

export const RoutineName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(ROUTINE_NAME_MAX),
  Schema.isPattern(/\S/),
);
export const RoutineBrief = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(ROUTINE_BRIEF_MAX),
  Schema.isPattern(/\S/),
);

export const WorkspaceRoutine = Schema.Struct({
  /**
   * Its key, kept across renames. The charter's write path fills one in for a routine without it
   * (a settings change by chat names routines by name), the one it had when the name matches.
   */
  id: Schema.optionalKey(RoutineId),
  /** Unique within the workspace, case aside; how the user and the orchestrator name it. */
  name: RoutineName,
  /** The worker's brief, or what the orchestrator is told: as the user approved it. */
  brief: RoutineBrief,
  schedule: RoutineSchedule,
  /** The repo the worker works in; absent is the workspace's home project. */
  project: Schema.optionalKey(ProjectId),
  /** The worker's model; absent is the roster's default, as for a worker the user starts. */
  model: Schema.optionalKey(ModelRef),
  /** Puts the brief in the orchestrator's next digest instead of starting a worker. */
  target: Schema.optionalKey(Schema.Literal("orchestrator")),
  /** Kept but not run. */
  off: Schema.optionalKey(Schema.Literal(true)),
  /**
   * How many times it has been turned off or on, set by the charter's write path alone
   * (`withRoutineGenerations`): a run that finds another than the one its next run was reckoned
   * for reckons again from now rather than run, however quickly it went off and on again.
   */
  generation: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type WorkspaceRoutine = typeof WorkspaceRoutine.Type;

/** `name` as routines are compared: trimmed, case aside. */
export const routineNameKey = (name: string): string => name.trim().toLowerCase();

/** A workspace's routines, their names and ids unique. */
export const WorkspaceRoutines = Schema.Array(WorkspaceRoutine).check(
  Schema.isMaxLength(ROUTINES_MAX),
  Schema.makeFilter((routines: ReadonlyArray<WorkspaceRoutine>) => {
    const names = routines.map((routine) => routineNameKey(routine.name));
    if (new Set(names).size !== names.length) return "Each routine needs a name of its own.";
    const ids = routines.flatMap((routine) => (routine.id === undefined ? [] : [routine.id]));
    return new Set(ids).size === ids.length || "Each routine needs an id of its own.";
  }),
);

/**
 * `next`'s routines, each with an id: its own, else the one a routine of the same name had in
 * `prior`, else `newId()`. Names are trimmed. The charter's write path calls it on every save.
 */
export const withRoutineIds = (
  prior: ReadonlyArray<WorkspaceRoutine> | undefined,
  next: ReadonlyArray<WorkspaceRoutine> | undefined,
  newId: () => string,
): ReadonlyArray<WorkspaceRoutine> | undefined => {
  if (next === undefined) return undefined;
  const byName = new Map(
    (prior ?? []).flatMap((routine) =>
      routine.id === undefined ? [] : [[routineNameKey(routine.name), routine.id] as const],
    ),
  );
  const taken = new Set(next.flatMap((routine) => (routine.id === undefined ? [] : [routine.id])));
  return next.map((routine) => {
    const name = routine.name.trim();
    if (routine.id !== undefined) return name === routine.name ? routine : { ...routine, name };
    const known = byName.get(routineNameKey(name));
    const id = (known !== undefined && !taken.has(known) ? known : newId()) as RoutineId;
    taken.add(id);
    return { ...routine, id, name };
  });
};

/**
 * `next`'s routines with their generation as the charter's write path keeps it: the one each had in
 * `prior` (by id), one more when its `off` flipped, and none for a routine new to the charter.
 * Whatever generation `next` carries is ignored: only this sets it.
 */
export const withRoutineGenerations = (
  prior: ReadonlyArray<WorkspaceRoutine> | undefined,
  next: ReadonlyArray<WorkspaceRoutine> | undefined,
): ReadonlyArray<WorkspaceRoutine> | undefined => {
  if (next === undefined) return undefined;
  const before = new Map(
    (prior ?? []).flatMap((routine) => (routine.id === undefined ? [] : [[routine.id, routine]])),
  );
  return next.map((routine) => {
    const { generation: _given, ...rest } = routine;
    const was = routine.id === undefined ? undefined : before.get(routine.id);
    if (was === undefined) return rest;
    const flipped = (was.off === true) !== (routine.off === true);
    const generation = (was.generation ?? 0) + (flipped ? 1 : 0);
    return generation === 0 ? rest : { ...rest, generation };
  });
};

/** "weekdays at 09:00", "Mondays at 07:30", "every day at 18:00", "every 6 hours". */
export const routineScheduleText = (schedule: RoutineSchedule): string => {
  switch (schedule.every) {
    case "day":
      return `every day at ${schedule.at}`;
    case "weekday":
      return `weekdays at ${schedule.at}`;
    case "week":
      return `${ROUTINE_DAYS[schedule.day ?? 1]}s at ${schedule.at}`;
    default:
      return schedule.hours === 1 ? "every hour" : `every ${schedule.hours} hours`;
  }
};

/** `9:05` or `09:05` as `09:05`; `undefined` for anything else. */
const timeOf = (word: string | undefined) => {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(word ?? "");
  return match === null ? undefined : `${match[1]!.padStart(2, "0")}:${match[2]}`;
};

/**
 * A schedule as the routine tools take it, in a few words: `daily 09:00`, `weekdays 09:00`,
 * `weekly mon 09:00` or `every 6 hours` (24-hour, local time); what is wrong with it otherwise.
 */
export const parseRoutineSchedule = (
  text: string,
): { readonly schedule: RoutineSchedule } | { readonly error: string } => {
  const [kind, first, second, extra] = text.trim().toLowerCase().split(/\s+/);
  if ((kind === "daily" || kind === "weekdays") && second === undefined) {
    const at = timeOf(first);
    if (at !== undefined) return { schedule: { every: kind === "daily" ? "day" : "weekday", at } };
  }
  if (kind === "weekly" && extra === undefined) {
    const day = ROUTINE_DAYS.findIndex(
      (name) => first !== undefined && first.length >= 3 && name.toLowerCase().startsWith(first),
    );
    const at = timeOf(second);
    if (day >= 0 && at !== undefined) return { schedule: { every: "week", day, at } };
  }
  if (kind === "every" && extra === undefined && /^hours?$/.test(second ?? "")) {
    const hours = Number(first);
    if (
      Number.isInteger(hours) &&
      hours >= ROUTINE_MIN_INTERVAL_HOURS &&
      hours <= ROUTINE_MAX_INTERVAL_HOURS
    ) {
      return { schedule: { every: "hours", hours } };
    }
    return {
      error: `An interval is ${ROUTINE_MIN_INTERVAL_HOURS} to ${ROUTINE_MAX_INTERVAL_HOURS} whole hours.`,
    };
  }
  return {
    error: `"${text}" isn't a schedule: give "daily HH:MM", "weekdays HH:MM", "weekly mon HH:MM" or "every N hours" (24-hour, local time).`,
  };
};

/** A routine's slug, for the feature its workers go under: `routine-ci-triage`. */
export const routineSlug = (name: string): string => {
  // Split into words and cut by hand: a name is input, and `-+$` backtracks on long dash runs.
  let words = name
    .toLowerCase()
    .normalize("NFKD")
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "")
    .join("-")
    .slice(0, 40);
  while (words.endsWith("-")) words = words.slice(0, -1);
  return `routine-${words === "" ? "run" : words}`;
};

/**
 * How a run went. `started`: a worker started (`threadId`). `messaged`: the brief went to the
 * orchestrator. `held`: the worker's brief was held, and starts by itself (`heldId`). `skipped`:
 * nothing ran, `detail` says why. `failed`: it couldn't run, `detail` says why.
 */
export const RoutineRunOutcome = Schema.Literals([
  "started",
  "messaged",
  "held",
  "skipped",
  "failed",
]);
export type RoutineRunOutcome = typeof RoutineRunOutcome.Type;

export const RoutineRun = Schema.Struct({
  /** Epoch ms it ran. */
  at: Schema.Number,
  outcome: RoutineRunOutcome,
  detail: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(ROUTINE_RUN_DETAIL_MAX))),
  threadId: Schema.optionalKey(ThreadId),
  heldId: Schema.optionalKey(Schema.String),
  /** The user's Run now, not the schedule. */
  manual: Schema.optionalKey(Schema.Literal(true)),
});
export type RoutineRun = typeof RoutineRun.Type;

/**
 * A routine's one unsettled run (its occurrence), kept before the run starts anything and until it
 * settles: while its brief is held, its worker is being made, or its worker is live. Its
 * `requestId`, named by the routine and the slot it is for, is the spawn's request id, so the worker
 * it makes has one id however often the run is retried. See `routines/routines.ts` for the lifecycle.
 */
export const RoutineClaim = Schema.Struct({
  requestId: Schema.String,
  /** The scheduled time it is for; a Run now's is when it was clicked. */
  slot: Schema.Number,
  manual: Schema.optionalKey(Schema.Literal(true)),
  /** It was held as this brief: once that brief is gone and no worker came of it, it settled. */
  heldId: Schema.optionalKey(Schema.String),
  /** It made this worker: once that worker is gone or finished, it settled. */
  threadId: Schema.optionalKey(ThreadId),
});
export type RoutineClaim = typeof RoutineClaim.Type;

/** How a routine's runs stand, kept in the workspace's outbox under its id. */
export const RoutineState = Schema.Struct({
  /** Epoch ms it next comes due; absent while it is off. Past it, it runs at once. */
  nextRunAt: Schema.optionalKey(Schema.Number),
  /** The schedule `nextRunAt` was reckoned for: a new one reckons again from now. */
  scheduleKey: Schema.optionalKey(Schema.String),
  /** The routine's generation `nextRunAt` was reckoned for: an off and on since reckons again. */
  generation: Schema.optionalKey(Schema.Int),
  lastRun: Schema.optionalKey(RoutineRun),
  claim: Schema.optionalKey(RoutineClaim),
  /** The worker its latest run made, a held brief released since included. */
  lastWorker: Schema.optionalKey(ThreadId),
  /** The held brief its latest run left, while it waits. */
  lastHeld: Schema.optionalKey(Schema.String),
  /** Due, and waiting on its workspace's pause: it runs once when the workspace resumes. */
  waiting: Schema.optionalKey(Schema.Literal("paused")),
});
export type RoutineState = typeof RoutineState.Type;

/** A routine as Settings lists it: what the charter has, and how its runs stand. */
export const RoutineStatus = Schema.Struct({
  routine: WorkspaceRoutine,
  id: RoutineId,
  state: RoutineState,
});
export type RoutineStatus = typeof RoutineStatus.Type;
