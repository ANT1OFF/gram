// Routines: a workspace's saved brief on a schedule. Each time one comes due it starts a worker in
// one of the workspace's projects, or puts its brief in the orchestrator's next digest. The server's
// engine (`packages/server/src/routines/`) keeps the schedule; this module is the shape both sides
// read, and the words a schedule is said in.
import * as Schema from "effect/Schema";
import { ProjectId, ThreadId, WorkspaceId } from "./ids.ts";

/** A routine's id. */
export const RoutineId = Schema.NonEmptyString.pipe(Schema.brand("RoutineId"));
export type RoutineId = typeof RoutineId.Type;

/** The longest name a routine takes: a short sidebar-sized label. */
export const ROUTINE_NAME_MAX = 60;
/** The longest brief a routine keeps. */
export const ROUTINE_BRIEF_MAX = 6_000;
/** How many routines one workspace may keep. */
export const ROUTINES_PER_WORKSPACE_MAX = 20;
/** The shortest interval a routine repeats at: an hour, so a routine never floods a workspace. */
export const ROUTINE_MIN_INTERVAL_HOURS = 1;
/** The longest interval: a week, the same as a weekly routine. */
export const ROUTINE_MAX_INTERVAL_HOURS = 168;
/** The longest detail a run keeps. */
export const ROUTINE_RUN_DETAIL_MAX = 500;

/** A 24-hour wall-clock time, `HH:MM`. */
export const RoutineTime = Schema.String.check(Schema.isPattern(/^([01]\d|2[0-3]):[0-5]\d$/));
export type RoutineTime = typeof RoutineTime.Type;

/** The days of the week, Monday first, as a weekly routine names one. */
export const ROUTINE_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export const RoutineDay = Schema.Literals(ROUTINE_DAYS);
export type RoutineDay = typeof RoutineDay.Type;

/** Every day at `time`, in the routine's time zone. */
export const DailySchedule = Schema.Struct({ kind: Schema.Literal("daily"), time: RoutineTime });
/** Every week on `day` at `time`, in the routine's time zone. */
export const WeeklySchedule = Schema.Struct({
  kind: Schema.Literal("weekly"),
  day: RoutineDay,
  time: RoutineTime,
});
/** Every `hours` hours from the last run (or from when it was turned on). */
export const IntervalSchedule = Schema.Struct({
  kind: Schema.Literal("interval"),
  hours: Schema.Int.check(
    Schema.isBetween({
      minimum: ROUTINE_MIN_INTERVAL_HOURS,
      maximum: ROUTINE_MAX_INTERVAL_HOURS,
    }),
  ),
});
export const RoutineSchedule = Schema.Union([DailySchedule, WeeklySchedule, IntervalSchedule]);
export type RoutineSchedule = typeof RoutineSchedule.Type;

/**
 * What a due routine does: start a worker in one of the workspace's projects, on one of its worker
 * models (`agent:model`, else the charter's default), or put its brief in the orchestrator's next
 * digest and wake it.
 */
export const RoutineWorkerTarget = Schema.Struct({
  kind: Schema.Literal("worker"),
  projectId: ProjectId,
  model: Schema.optionalKey(Schema.NonEmptyString),
});
export const RoutineOrchestratorTarget = Schema.Struct({ kind: Schema.Literal("orchestrator") });
export const RoutineTarget = Schema.Union([RoutineWorkerTarget, RoutineOrchestratorTarget]);
export type RoutineTarget = typeof RoutineTarget.Type;

/**
 * How a run went. `started`: a worker started (`threadId`). `messaged`: the brief went to the
 * orchestrator. `held`: the worker's brief was held (a provider failure on its model), and starts
 * by itself (`heldId`). `skipped`: nothing ran, `detail` says why (the last run's worker is still
 * live). `failed`: it couldn't run, `detail` says why.
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

/** Who made a routine: the user in Settings, the orchestrator, or a worker the user approved. */
export const RoutineAuthor = Schema.Literals(["user", "orchestrator", "worker"]);
export type RoutineAuthor = typeof RoutineAuthor.Type;

export const RoutineName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(ROUTINE_NAME_MAX),
);
export const RoutineBrief = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(ROUTINE_BRIEF_MAX),
);

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

export const Routine = Schema.Struct({
  id: RoutineId,
  workspaceId: WorkspaceId,
  name: RoutineName,
  brief: RoutineBrief,
  target: RoutineTarget,
  schedule: RoutineSchedule,
  enabled: Schema.Boolean,
  /** The IANA zone its daily and weekly times are read in: the machine's when it was saved. */
  timeZone: Schema.String,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  createdBy: RoutineAuthor,
  /** The thread that made it, for one an agent made. */
  createdByThread: Schema.optionalKey(ThreadId),
  lastRun: Schema.optionalKey(RoutineRun),
  /**
   * The worker its latest started run made, kept past skipped and failed runs: while it is live,
   * no run starts another.
   */
  lastWorker: Schema.optionalKey(ThreadId),
  /** The held brief its latest held run left, which counts as live until it starts or goes. */
  lastHeld: Schema.optionalKey(Schema.String),
  /** Epoch ms it next comes due; absent while it is off. Past it, it runs at once. */
  nextRunAt: Schema.optionalKey(Schema.Number),
  /**
   * The routine's one unsettled run (its occurrence), kept before the run starts anything and
   * until it settles: while its brief is held, its worker is being made, or its worker is live. Its
   * `requestId`, named by the routine and the slot it is for, is the spawn's request id, so the
   * worker it makes has one id however often the run is retried; `heldId` and `threadId` say how
   * far it got. See `routines/routines.ts` for the lifecycle.
   */
  claim: Schema.optionalKey(RoutineClaim),
  /** Due, and waiting on its workspace's pause: it runs once when the workspace resumes. */
  waiting: Schema.optionalKey(Schema.Literal("paused")),
});
export type Routine = typeof Routine.Type;

/** What makes a routine, from Settings or `routine_create`. */
export const RoutineDraft = Schema.Struct({
  name: RoutineName,
  brief: RoutineBrief,
  target: RoutineTarget,
  schedule: RoutineSchedule,
  enabled: Schema.optionalKey(Schema.Boolean),
});
export type RoutineDraft = typeof RoutineDraft.Type;

/** A change to a routine: only the fields given change. */
export const RoutinePatch = Schema.Struct({
  name: Schema.optionalKey(RoutineName),
  brief: Schema.optionalKey(RoutineBrief),
  target: Schema.optionalKey(RoutineTarget),
  schedule: Schema.optionalKey(RoutineSchedule),
  enabled: Schema.optionalKey(Schema.Boolean),
});
export type RoutinePatch = typeof RoutinePatch.Type;

/** A weekday's full name, Monday first: `Monday` for `mon`. */
export const ROUTINE_DAY_NAMES: Readonly<Record<RoutineDay, string>> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

/** A schedule in words: "Daily at 09:00", "Mondays at 09:00", "Every 6 hours". */
export const routineScheduleText = (schedule: RoutineSchedule): string => {
  switch (schedule.kind) {
    case "daily":
      return `Daily at ${schedule.time}`;
    case "weekly":
      return `${ROUTINE_DAY_NAMES[schedule.day]}s at ${schedule.time}`;
    default:
      return schedule.hours === 1 ? "Every hour" : `Every ${schedule.hours} hours`;
  }
};

/**
 * A routine's slug, for the feature its workers go under: `routine-ci-triage`. Split into words and
 * cut by hand, with no anchored repetition: a name is input, and `-+$` backtracks on long dash runs.
 */
export const routineSlug = (name: string): string => {
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

/** `9:05` or `09:05` as `09:05`; `undefined` for anything else. */
const timeOf = (word: string | undefined) => {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(word ?? "");
  return match === null ? undefined : `${match[1]!.padStart(2, "0")}:${match[2]}`;
};

/**
 * A schedule as the routine tools take it, in a few words: `daily 09:00`, `weekly mon 09:00` or
 * `every 6 hours` (24-hour, local time); what is wrong with it otherwise.
 */
export const parseRoutineSchedule = (
  text: string,
): { readonly schedule: RoutineSchedule } | { readonly error: string } => {
  const words = text.trim().toLowerCase().split(/\s+/);
  const [kind, first, second, extra] = words;
  if (kind === "daily" && second === undefined) {
    const time = timeOf(first);
    if (time !== undefined) return { schedule: { kind: "daily", time } };
  }
  if (kind === "weekly" && extra === undefined) {
    const day = ROUTINE_DAYS.find((each) => first?.startsWith(each) === true);
    const time = timeOf(second);
    if (day !== undefined && time !== undefined) return { schedule: { kind: "weekly", day, time } };
  }
  if (kind === "every" && extra === undefined && /^hours?$/.test(second ?? "")) {
    const hours = Number(first);
    if (
      Number.isInteger(hours) &&
      hours >= ROUTINE_MIN_INTERVAL_HOURS &&
      hours <= ROUTINE_MAX_INTERVAL_HOURS
    ) {
      return { schedule: { kind: "interval", hours } };
    }
    return {
      error: `An interval is ${ROUTINE_MIN_INTERVAL_HOURS} to ${ROUTINE_MAX_INTERVAL_HOURS} whole hours.`,
    };
  }
  return {
    error: `"${text}" isn't a schedule: give "daily HH:MM", "weekly mon HH:MM" or "every N hours" (24-hour, local time).`,
  };
};
