// When a routine next comes due. Daily and weekly times are wall-clock times in the routine's IANA
// zone, so a daylight-saving change moves the instant and never the time it reads: a 09:00 routine
// runs at 09:00 on both sides of the change. A time the change skips (02:30 the night clocks go
// forward) runs at the instant `zoned` settles on, once; a time it repeats runs once too, since the
// next run is always looked for after the one that ran.
import { ROUTINE_DAYS, type RoutineDay, type RoutineSchedule } from "@gram/contracts";
import { formatterOf, plusDays, wallDate, zoned, type Wall } from "../zone-time.ts";

export const HOUR_MS = 3_600_000;

/** The date's weekday, Monday first, as `ROUTINE_DAYS` names it. */
export const weekdayOf = (date: Wall): RoutineDay =>
  ROUTINE_DAYS[(new Date(Date.UTC(date.year, date.month, date.day)).getUTCDay() + 6) % 7]!;

const clockOf = (time: string): { readonly hour: number; readonly minute: number } => {
  const [hour = "0", minute = "0"] = time.split(":");
  return { hour: Number(hour), minute: Number(minute) };
};

/**
 * The first instant strictly after `after` the schedule falls due, in `zone`: an interval's is
 * `after` plus its hours, a daily or weekly one's the next of its times. Throws `RangeError` for a
 * zone `Intl` doesn't know.
 */
export const nextRunAfter = (schedule: RoutineSchedule, after: number, zone: string): number => {
  if (schedule.kind === "interval") return after + schedule.hours * HOUR_MS;
  const format = formatterOf(zone);
  if (format === undefined) throw new RangeError(`Unknown time zone ${zone}`);
  const { hour, minute } = clockOf(schedule.time);
  const today = wallDate(format, after);
  // `today` is `after`'s date in the zone, so an earlier date's time is never after it.
  for (let offset = 0; offset <= 8; offset++) {
    const date = plusDays(today, offset);
    if (schedule.kind === "weekly" && weekdayOf(date) !== schedule.day) continue;
    const at = zoned(format, date, hour, minute);
    if (at > after) return at;
  }
  // Unreachable: some day in the next eight is the weekday, at a time after `after`.
  throw new RangeError("No next run found");
};

/** Whether `zone` is a time zone `Intl` knows. */
export const knownZone = (zone: string): boolean => formatterOf(zone) !== undefined;

const two = (value: string | undefined) => (value ?? "0").padStart(2, "0");

/** `at` as `YYYYMMDD-HHMM` in `zone`, for a run's branch name. */
export const runStamp = (at: number, zone: string): string => {
  const format = formatterOf(zone);
  if (format === undefined) return new Date(at).toISOString().slice(0, 16).replace(/\D/g, "");
  const parts = Object.fromEntries(format.formatToParts(at).map((part) => [part.type, part.value]));
  return `${parts.year}${two(parts.month)}${two(parts.day)}-${two(String(Number(parts.hour) % 24))}${two(parts.minute)}`;
};
