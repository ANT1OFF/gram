// Gram's one place for calendar days (lint: `gram/no-day-math`). Wall-clock reading in an IANA time
// zone: the date a given instant is on there, and the instant a clock time on a date falls at.
// Daylight-saving changes move both, so nothing here assumes one offset for a whole day, and a
// local day is 23 or 25 hours long twice a year.
//
// A calendar day is a date (`Wall`, `dateKey`), and moving between days is `plusDays`. `DAY_MS` is
// only a duration: a rolling window, a lifetime, a retention age. A UTC day is always `DAY_MS`
// long, so UTC date arithmetic may use it too.

/** 24 hours, as a duration. Never "the same time tomorrow" in a local zone: use `plusDays`. */
export const DAY_MS = 86_400_000;

/** The machine's IANA zone, which the server's "today" is in. */
export const localZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

export interface Wall {
  readonly year: number;
  /** 0-based. */
  readonly month: number;
  readonly day: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The time zone's formatter, or `undefined` for a name `Intl` doesn't know. */
export const formatterOf = (zone: string): Intl.DateTimeFormat | undefined => {
  const known = formatters.get(zone);
  if (known !== undefined) return known;
  try {
    const made = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(zone, made);
    return made;
  } catch {
    return undefined;
  }
};

/** The wall clock in `zone` at `at`, as if it were UTC. */
const wallAsUtc = (format: Intl.DateTimeFormat, at: number): number => {
  const parts = Object.fromEntries(
    format.formatToParts(at).map((part) => [part.type, Number(part.value)]),
  ) as Record<string, number>;
  return Date.UTC(
    parts.year!,
    parts.month! - 1,
    parts.day!,
    parts.hour! % 24,
    parts.minute!,
    parts.second!,
  );
};

/** The date in `zone` at `at`. */
export const wallDate = (format: Intl.DateTimeFormat, at: number): Wall => {
  const wall = new Date(wallAsUtc(format, at));
  return { year: wall.getUTCFullYear(), month: wall.getUTCMonth(), day: wall.getUTCDate() };
};

/** Epoch ms of a wall-clock time in `zone`, settled twice so a DST change between is accounted for. */
export const zoned = (
  format: Intl.DateTimeFormat,
  date: Wall,
  hour: number,
  minute: number,
): number => {
  const asUtc = Date.UTC(date.year, date.month, date.day, hour, minute);
  const first = asUtc - (wallAsUtc(format, asUtc) - asUtc);
  return asUtc - (wallAsUtc(format, first) - first);
};

export const plusDays = (date: Wall, days: number): Wall => {
  const next = new Date(Date.UTC(date.year, date.month, date.day + days));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth(), day: next.getUTCDate() };
};

/** `date` as `YYYY-MM-DD`. */
export const dateKey = (date: Wall): string =>
  [
    String(date.year).padStart(4, "0"),
    String(date.month + 1).padStart(2, "0"),
    String(date.day).padStart(2, "0"),
  ].join("-");

/** The date `date` is on in the process's local zone, by the `Date`'s own local getters. */
export const localWall = (date: Date): Wall => ({
  year: date.getFullYear(),
  month: date.getMonth(),
  day: date.getDate(),
});

/**
 * The calendar day `now` falls on in `timeZone` (an IANA name): its `YYYY-MM-DD` date, and the real
 * local midnight that starts it. The start is worked out for that date, so a daylight-saving change
 * partway through the day leaves it where it was. Throws `RangeError` for an unknown zone.
 */
export const localDayOf = (
  now: number,
  timeZone: string,
): { readonly date: string; readonly start: number } => {
  const format = formatterOf(timeZone);
  if (format === undefined) throw new RangeError(`Unknown time zone ${timeZone}`);
  const day = wallDate(format, now);
  return { date: dateKey(day), start: zoned(format, day, 0, 0) };
};

/** Epoch ms of the local midnight that starts the day `now` is on in `timeZone`; see `localDayOf`. */
export const startOfLocalDay = (now: number, timeZone: string): number =>
  localDayOf(now, timeZone).start;
