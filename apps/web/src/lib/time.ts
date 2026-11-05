import { dateTimeFormat } from "./intl";

const UNITS: [limit: number, size: number, suffix: string][] = [
  [60_000, 1, "now"],
  [3_600_000, 60_000, "m"],
  [86_400_000, 3_600_000, "h"],
  [604_800_000, 86_400_000, "d"],
  [Number.POSITIVE_INFINITY, 604_800_000, "w"],
];

/** Gram's clock convention, including 00 at midnight in locales that default to AM/PM. */
export const CLOCK_TIME = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } as const;

/** A local 24-hour clock, with an optional locale and zone for callers and tests. */
export function formatClockTime(
  at: number,
  intl: { readonly locale?: string; readonly timeZone?: string } = {},
): string {
  return dateTimeFormat(intl.locale, {
    ...CLOCK_TIME,
    ...(intl.timeZone === undefined ? {} : { timeZone: intl.timeZone }),
  }).format(at);
}

/**
 * A log line's clock to the second, `14:03:12`, for events seconds apart (a browser's console and
 * network lines, a capture's start and end). 24-hour and in Latin digits, in any locale.
 */
export function formatLogTime(at: number, intl: { readonly timeZone?: string } = {}): string {
  return dateTimeFormat("en-GB", {
    numberingSystem: "latn",
    ...CLOCK_TIME,
    second: "2-digit",
    ...(intl.timeZone === undefined ? {} : { timeZone: intl.timeZone }),
  }).format(at);
}

/** A zone to read a time in, for tests; the viewer's own when absent. */
interface ZoneOption {
  readonly timeZone?: string;
}

/** English month abbreviations, so `Sep` reads the same in every engine and locale. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `at`'s day and 24-hour clock in the viewer's zone (or `intl.timeZone`), in Latin digits. */
function stampParts(at: number, intl: ZoneOption) {
  const parts = dateTimeFormat("en-GB", {
    numberingSystem: "latn",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    ...CLOCK_TIME,
    ...(intl.timeZone === undefined ? {} : { timeZone: intl.timeZone }),
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  return {
    year: part("year"),
    day: `${Number(part("day"))} ${MONTHS[Number(part("month")) - 1]}`,
    time: `${part("hour")}:${part("minute")}`,
  };
}

/**
 * A date alone, for a day heading or a date column: `14 Jun`, with the year when it isn't `now`'s
 * (`14 Jun 2025`). The viewer's zone, or `intl.timeZone`'s; never a weekday or a US order.
 */
export function formatDay(at: number, now = Date.now(), intl: ZoneOption = {}): string {
  const due = stampParts(at, intl);
  return due.year === stampParts(now, intl).year ? due.day : `${due.day} ${due.year}`;
}

/**
 * Gram's one way to show a point in time: its 24-hour clock alone today (`09:42`, `00:00`), else
 * the date before it (`14 Jun 08:00`), with the year when it isn't this one (`14 Jun 2025 08:00`).
 * "Today" is `now`'s day in the viewer's zone, or `intl.timeZone`'s. The other forms are each for
 * one job: a relative time (`agoText`), a message's full hint (`formatMessageTime`), a log line's
 * seconds (`formatLogTime`), a wake's weekday (`formatWakeTime`) and a bare clock
 * (`formatClockTime`).
 */
export function formatStamp(at: number, now = Date.now(), intl: ZoneOption = {}): string {
  const due = stampParts(at, intl);
  const today = stampParts(now, intl);
  if (due.year === today.year && due.day === today.day) return due.time;
  return due.year === today.year ? `${due.day} ${due.time}` : `${due.day} ${due.year} ${due.time}`;
}

/** When a notification came: `formatStamp`. */
export function notificationTime(at: number, now = Date.now(), intl: ZoneOption = {}): string {
  return formatStamp(at, now, intl);
}

/** Compact sidebar time: `now`, `5m`, `3h`, `2d`, `6w`. */
export function formatRelative(epochMs: number, now = Date.now()): string {
  const elapsed = Math.max(0, now - epochMs);
  for (const [limit, size, suffix] of UNITS) {
    if (elapsed < limit) return size === 1 ? suffix : `${Math.floor(elapsed / size)}${suffix}`;
  }
  return "";
}

/** `formatRelative`'s units, spelled out. */
const UNIT_WORDS: Readonly<Record<string, string>> = {
  m: "minute",
  h: "hour",
  d: "day",
  w: "week",
};

/**
 * How long ago `at` was, as a sentence says it: `just now` under a minute, then `5m ago`, `3h ago`,
 * `2d ago`, `6w ago` (`formatRelative`). `long` spells the unit out, `3 hours ago`, for a line read
 * as prose. Every "ago" the app shows is this one. An ISO time is read as one; one that doesn't
 * parse shows as itself.
 */
export function agoText(
  at: number | string,
  now = Date.now(),
  { long = false }: { readonly long?: boolean } = {},
): string {
  const epochMs = typeof at === "string" ? Date.parse(at) : at;
  if (Number.isNaN(epochMs)) return String(at);
  const compact = formatRelative(epochMs, now);
  if (compact === "now") return "just now";
  if (!long) return `${compact} ago`;
  const count = Number.parseInt(compact, 10);
  return `${count} ${UNIT_WORDS[compact.slice(-1)]}${count === 1 ? "" : "s"} ago`;
}

const MESSAGE_TIME = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  timeZoneName: "longOffset",
} as const;

/** One formatter per zone: a transcript formats every message it renders, and builds are slow. */
const messageTimeFormats = new Map<string | undefined, Intl.DateTimeFormat>();

/** `epochMs` split into `MESSAGE_TIME`'s parts in the viewer's zone, or `intl.timeZone`'s. */
function messageTimeParts(epochMs: number, intl: { readonly timeZone?: string }) {
  let format = messageTimeFormats.get(intl.timeZone);
  if (format === undefined) {
    // `en-US` only for its Latin digits: callers put the parts back in an order of their own.
    format = new Intl.DateTimeFormat("en-US", {
      ...MESSAGE_TIME,
      ...(intl.timeZone === undefined ? {} : { timeZone: intl.timeZone }),
    });
    messageTimeFormats.set(intl.timeZone, format);
  }
  const parts = format.formatToParts(epochMs);
  return (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
}

/**
 * When a message arrived, for its hover hint: `2026-10-06 14:37:12 UTC+02:00`, in the viewer's
 * zone with its offset. Always with the date, since a thread spans days, and the same digits in any
 * locale. `intl` pins the zone, for tests.
 */
export function formatMessageTime(
  epochMs: number,
  intl: { readonly timeZone?: string } = {},
): string {
  const part = messageTimeParts(epochMs, intl);
  // Engines differ on UTC itself, `GMT` or `GMT+00:00`: both read as the latter.
  const zone = part("timeZoneName");
  const offset = zone === "GMT" ? "UTC+00:00" : zone.replace(/^GMT/, "UTC");
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")} ${offset}`;
}

/**
 * When a message arrived, under it: `formatStamp`. `formatMessageTime` keeps the full date, seconds
 * and offset for its hint.
 */
export function formatMessageStamp(
  epochMs: number,
  now = Date.now(),
  intl: ZoneOption = {},
): string {
  return formatStamp(epochMs, now, intl);
}

const wakeTimeFormats = new Map<string | undefined, Intl.DateTimeFormat>();

/**
 * When a pending wake is due, for its chip: `14:30` on the day it is set from, `Fri 14:30` on
 * another (a wake is at most a week ahead), in the viewer's zone. `intl` pins the zone, for tests.
 * The one weekday form left: within that week the weekday is unambiguous, and it keeps a worker's
 * wait label ("Waiting · until Fri 14:30") inside its four words, which `formatStamp`'s date would
 * not.
 */
export function formatWakeTime(
  at: number,
  now = Date.now(),
  intl: { readonly timeZone?: string } = {},
): string {
  let format = wakeTimeFormats.get(intl.timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      ...(intl.timeZone === undefined ? {} : { timeZone: intl.timeZone }),
    });
    wakeTimeFormats.set(intl.timeZone, format);
  }
  const parts = (epochMs: number) => {
    const all = format.formatToParts(epochMs);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      all.find((p) => p.type === type)?.value ?? "";
    return {
      day: `${part("year")}-${part("month")}-${part("day")}`,
      weekday: part("weekday"),
      time: `${part("hour")}:${part("minute")}`,
    };
  };
  const due = parts(at);
  return due.day === parts(now).day ? due.time : `${due.weekday} ${due.time}`;
}
