// Workspace routines (docs/AGENTS_AND_FEATURES.md#routines): a brief the user approved, started as
// a fresh worker on a schedule. The schedule and its arithmetic live here, pure; the server keeps
// when each last ran and starts the worker.

import * as Schema from "effect/Schema";
import { ModelRef } from "./domain.ts";
import { ProjectId } from "./ids.ts";

/** The most routines one workspace keeps. */
export const ROUTINES_MAX = 8;
export const ROUTINE_NAME_MAX = 64;
export const ROUTINE_BRIEF_MAX = 4000;

/** How often a routine runs: every day, Monday to Friday, or one day a week. */
export const RoutineEvery = Schema.Literals(["day", "weekday", "week"]);
export type RoutineEvery = typeof RoutineEvery.Type;

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

export const RoutineSchedule = Schema.Struct({
  every: RoutineEvery,
  /** 24-hour local time on this computer, `HH:MM`. */
  at: Schema.String.check(Schema.isPattern(/^([01]\d|2[0-3]):[0-5]\d$/)),
  /** For `week`: the day, 0 (Sunday) to 6. Ignored otherwise; absent is Monday. */
  day: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 }))),
});
export type RoutineSchedule = typeof RoutineSchedule.Type;

export const WorkspaceRoutine = Schema.Struct({
  /** Unique within the workspace, case aside; how the user and the orchestrator name it. */
  name: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(ROUTINE_NAME_MAX),
    Schema.isPattern(/\S/),
  ),
  /** The worker's brief, as the user approved it. */
  brief: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(ROUTINE_BRIEF_MAX),
    Schema.isPattern(/\S/),
  ),
  schedule: RoutineSchedule,
  /** The repo the worker works in; absent is the workspace's home project. */
  project: Schema.optionalKey(ProjectId),
  /** The worker's model; absent is the roster's default, as for a worker the user starts. */
  model: Schema.optionalKey(ModelRef),
  /** Kept but not run. */
  off: Schema.optionalKey(Schema.Literal(true)),
});
export type WorkspaceRoutine = typeof WorkspaceRoutine.Type;

/** A workspace's routines, their names unique regardless of case. */
export const WorkspaceRoutines = Schema.Array(WorkspaceRoutine).check(
  Schema.isMaxLength(ROUTINES_MAX),
  Schema.makeFilter((routines: ReadonlyArray<WorkspaceRoutine>) => {
    const names = routines.map((routine) => routine.name.trim().toLowerCase());
    return new Set(names).size === names.length || "Each routine needs a name of its own.";
  }),
);

const runsOn = (schedule: RoutineSchedule, weekday: number): boolean =>
  schedule.every === "day" ||
  (schedule.every === "weekday" && weekday >= 1 && weekday <= 5) ||
  (schedule.every === "week" && weekday === (schedule.day ?? 1));

/**
 * The first run strictly after `after` (epoch ms), in this computer's local time. A day without
 * the hour, at a daylight-saving change, runs at the hour the clock reaches instead.
 */
export const nextRoutineRun = (schedule: RoutineSchedule, after: number): number => {
  const [hours, minutes] = schedule.at.split(":").map(Number) as [number, number];
  const day = new Date(after);
  day.setHours(0, 0, 0, 0);
  // Eight days covers a weekly routine whose day is today but whose hour has passed.
  for (let offset = 0; offset <= 8; offset++) {
    const candidate = new Date(day.getFullYear(), day.getMonth(), day.getDate() + offset);
    if (!runsOn(schedule, candidate.getDay())) continue;
    candidate.setHours(hours, minutes, 0, 0);
    if (candidate.getTime() > after) return candidate.getTime();
  }
  // Unreachable for a decoded schedule: every kind runs at least once in any eight days.
  return after + 7 * 24 * 60 * 60 * 1000;
};

/** "weekdays at 09:00", "Mondays at 07:30", "every day at 18:00". */
export const routineScheduleText = (schedule: RoutineSchedule): string =>
  schedule.every === "day"
    ? `every day at ${schedule.at}`
    : schedule.every === "weekday"
      ? `weekdays at ${schedule.at}`
      : `${ROUTINE_DAYS[schedule.day ?? 1]}s at ${schedule.at}`;
