import type { RoutineSchedule } from "@gram/contracts";
import { formatterOf, plusDays, wallDate, zoned, type Wall } from "../zone-time.ts";

export const HOUR_MS = 3_600_000;

/** The date's weekday as `Date.getDay` counts it: 0 is Sunday. */
export const weekdayOf = (date: Wall): number =>
  new Date(Date.UTC(date.year, date.month, date.day)).getUTCDay();

const runsOn = (schedule: Exclude<RoutineSchedule, { every: "hours" }>, weekday: number) =>
  schedule.every === "day" ||
  (schedule.every === "weekday" && weekday >= 1 && weekday <= 5) ||
  (schedule.every === "week" && weekday === (schedule.day ?? 1));

/**
 * The first instant strictly after `after` the schedule falls due, in `zone`: an interval's is
 * `after` plus its hours, the others the next of their times. Throws `RangeError` for a zone `Intl`
 * doesn't know.
 */
export const nextRunAfter = (schedule: RoutineSchedule, after: number, zone: string): number => {
  if (schedule.every === "hours") return after + schedule.hours * HOUR_MS;
  const format = formatterOf(zone);
  if (format === undefined) throw new RangeError(`Unknown time zone ${zone}`);
  const [hour = 0, minute = 0] = schedule.at.split(":").map(Number);
  const today = wallDate(format, after);
  for (let offset = 0; offset <= 8; offset++) {
    const date = plusDays(today, offset);
    if (!runsOn(schedule, weekdayOf(date))) continue;
    const at = zoned(format, date, hour, minute);
    if (at > after) return at;
  }
  throw new RangeError("No next run found");
};

const two = (value: string | undefined) => (value ?? "0").padStart(2, "0");

/** `at` as `YYYYMMDD-HHMM` in `zone`, for a run's branch name. */
export const runStamp = (at: number, zone: string): string => {
  const format = formatterOf(zone);
  if (format === undefined) return new Date(at).toISOString().slice(0, 16).replace(/\D/g, "");
  const parts = Object.fromEntries(format.formatToParts(at).map((part) => [part.type, part.value]));
  return `${parts.year}${two(parts.month)}${two(parts.day)}-${two(String(Number(parts.hour) % 24))}${two(parts.minute)}`;
};
