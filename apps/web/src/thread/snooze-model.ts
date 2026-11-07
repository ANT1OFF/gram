import { formatStamp, formatWakeTime } from "@/lib/time";

// When a snooze ends, worked out on the wall clock of a time zone (the viewer's, or a pinned one
// in tests): "tomorrow 09:00" is 09:00 on the next calendar day there, however long that night is
// across a daylight-saving change.

/** A calendar date, its month 0-based. */
interface Wall {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

export interface SnoozeZone {
  /** An IANA zone; absent for the viewer's own. */
  readonly timeZone?: string;
}

const formats = new Map<string | undefined, Intl.DateTimeFormat>();

const formatOf = (timeZone: string | undefined): Intl.DateTimeFormat => {
  let format = formats.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", {
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      weekday: "short",
      ...(timeZone === undefined ? {} : { timeZone }),
    });
    formats.set(timeZone, format);
  }
  return format;
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The wall clock at `at` in the zone, read as if it were UTC, and its weekday (0 is Sunday). */
const wallOf = (at: number, zone: SnoozeZone) => {
  const parts = formatOf(zone.timeZone).formatToParts(at);
  const num = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  const weekday = WEEKDAYS.indexOf(parts.find((p) => p.type === "weekday")?.value ?? "");
  const asUtc = Date.UTC(
    num("year"),
    num("month") - 1,
    num("day"),
    num("hour") % 24,
    num("minute"),
    num("second"),
  );
  return { asUtc, weekday, hour: num("hour") % 24 };
};

const dateOf = (at: number, zone: SnoozeZone): Wall => {
  const wall = new Date(wallOf(at, zone).asUtc);
  return { year: wall.getUTCFullYear(), month: wall.getUTCMonth(), day: wall.getUTCDate() };
};

const plusDays = (date: Wall, days: number): Wall => {
  const next = new Date(Date.UTC(date.year, date.month, date.day + days));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth(), day: next.getUTCDate() };
};

/** Epoch ms of `hour:minute` on `date` in the zone, settled twice across an offset change. */
export const wallTime = (date: Wall, hour: number, minute: number, zone: SnoozeZone): number => {
  const asUtc = Date.UTC(date.year, date.month, date.day, hour, minute);
  const first = asUtc - (wallOf(asUtc, zone).asUtc - asUtc);
  return asUtc - (wallOf(first, zone).asUtc - first);
};

export type SnoozePresetId = "hour" | "evening" | "tomorrow" | "nextWeek";

export interface SnoozePreset {
  readonly id: SnoozePresetId;
  readonly label: string;
  readonly at: number;
}

/** The evening snooze's hour, and the morning one's. */
const EVENING = 18;
const MORNING = 9;

/**
 * The quick snoozes from `now`: an hour from now; this evening at 18:00 while that is still ahead;
 * tomorrow at 09:00; and next week, Monday at 09:00.
 */
export const snoozePresets = (now: number, zone: SnoozeZone = {}): SnoozePreset[] => {
  const today = dateOf(now, zone);
  const evening = wallTime(today, EVENING, 0, zone);
  const { weekday } = wallOf(now, zone);
  // Days to the coming Monday: a Monday's next week is seven days on.
  const toMonday = (8 - weekday) % 7 || 7;
  return [
    { id: "hour", label: "1 hour", at: now + 3_600_000 },
    ...(evening > now ? [{ id: "evening" as const, label: "This evening", at: evening }] : []),
    { id: "tomorrow", label: "Tomorrow", at: wallTime(plusDays(today, 1), MORNING, 0, zone) },
    {
      id: "nextWeek",
      label: "Next week",
      at: wallTime(plusDays(today, toMonday), MORNING, 0, zone),
    },
  ];
};

/**
 * When a snooze ends, in 24-hour time: `18:00` today, `Fri 09:00` within the coming week, and the
 * date beyond it, where a weekday alone would be ambiguous.
 */
export const snoozeTime = (at: number, now: number, zone: SnoozeZone = {}): string =>
  at - now < 6 * 24 * 3_600_000 ? formatWakeTime(at, now, zone) : formatStamp(at, now, zone);

/** The chip's words: "Snoozed until Fri 09:00". */
export const snoozedUntilText = (at: number, now: number, zone: SnoozeZone = {}): string =>
  `Snoozed until ${snoozeTime(at, now, zone)}`;

const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A date input's `YYYY-MM-DD` for `at` in the zone. */
export const dateInputValue = (at: number, zone: SnoozeZone = {}): string => {
  const { year, month, day } = dateOf(at, zone);
  return `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
};

/**
 * A custom snooze from a date (`YYYY-MM-DD`) and a 24-hour time (`HH:MM`), or why it can't be one:
 * a time that doesn't parse, or one already past.
 */
export const customSnooze = (
  date: string,
  time: string,
  now: number,
  zone: SnoozeZone = {},
): { readonly at: number } | { readonly error: string } => {
  const d = DATE.exec(date.trim());
  const t = TIME.exec(time.trim());
  if (d === null) return { error: "Pick a date" };
  if (t === null) return { error: "Write the time as HH:MM, from 00:00 to 23:59" };
  const at = wallTime(
    { year: Number(d[1]), month: Number(d[2]) - 1, day: Number(d[3]) },
    Number(t[1]),
    Number(t[2]),
    zone,
  );
  if (at <= now) return { error: "That time has already passed" };
  return { at };
};

/** The weekdays a typed snooze takes, Sunday first: the whole name, or any start of it from three letters. */
const DAY_WORDS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/**
 * A snooze typed in words, as the palette's Snooze thread step takes it: a day (`today`,
 * `tomorrow`, a weekday such as `fri` or `friday`), a 24-hour time (`14:00`, `9`), or both
 * (`fri 14:00`); or a span (`30m`, `2h`). A day alone is 09:00 that day; a time alone is the next
 * time the clock reads it; a weekday is the next one ahead, today's while its time is still ahead.
 * `undefined` for words it can't read, or a time already past.
 */
export const typedSnooze = (
  text: string,
  now: number,
  zone: SnoozeZone = {},
): number | undefined => {
  const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 2) return undefined;
  const span =
    words.length === 1 ? /^(\d{1,3})\s*(m|min|mins|h|hr|hrs|hours?)$/.exec(words[0]!) : null;
  if (span !== null) {
    const amount = Number(span[1]);
    if (amount === 0) return undefined;
    return now + amount * (span[2]!.startsWith("m") ? 60_000 : 3_600_000);
  }
  let day: "today" | "tomorrow" | number | undefined;
  let time: { hour: number; minute: number } | undefined;
  for (const word of words) {
    const clock = /^([01]?\d|2[0-3])(?::([0-5]\d))?$/.exec(word);
    if (clock !== null && time === undefined) {
      time = { hour: Number(clock[1]), minute: Number(clock[2] ?? 0) };
      continue;
    }
    if (day !== undefined) return undefined;
    if (word === "today") day = "today";
    else if (word === "tomorrow" || word === "tmr" || word === "tom") day = "tomorrow";
    else {
      const weekday = word.length >= 3 ? DAY_WORDS.findIndex((name) => name.startsWith(word)) : -1;
      if (weekday === -1) return undefined;
      day = weekday;
    }
  }
  const today = dateOf(now, zone);
  const { hour, minute } = time ?? { hour: MORNING, minute: 0 };
  if (day === undefined) {
    const at = wallTime(today, hour, minute, zone);
    return at > now ? at : wallTime(plusDays(today, 1), hour, minute, zone);
  }
  if (day === "today" || day === "tomorrow") {
    const at = wallTime(plusDays(today, day === "today" ? 0 : 1), hour, minute, zone);
    return at > now ? at : undefined;
  }
  const { weekday } = wallOf(now, zone);
  const ahead = (day - weekday + 7) % 7;
  const at = wallTime(plusDays(today, ahead), hour, minute, zone);
  return at > now ? at : wallTime(plusDays(today, ahead + 7), hour, minute, zone);
};
