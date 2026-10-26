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

/** Notification dates in the viewer's locale and zone, always with a 24-hour clock. */
export function notificationTime(
  at: number,
  intl: { readonly locale?: string; readonly timeZone?: string } = {},
): string {
  return dateTimeFormat(intl.locale, {
    month: "short",
    day: "numeric",
    ...CLOCK_TIME,
    ...(intl.timeZone === undefined ? {} : { timeZone: intl.timeZone }),
  }).format(at);
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
 * When a message arrived, using the notification date convention in the viewer's locale and zone.
 * `formatMessageTime` retains the full date, seconds and offset for its hint.
 */
export function formatMessageStamp(
  epochMs: number,
  intl: { readonly locale?: string; readonly timeZone?: string } = {},
): string {
  return notificationTime(epochMs, intl);
}

const wakeTimeFormats = new Map<string | undefined, Intl.DateTimeFormat>();

/**
 * When a pending wake is due, for its chip: `14:30` on the day it is set from, `Fri 14:30` on
 * another (a wake is at most a week ahead), in the viewer's zone. `intl` pins the zone, for tests.
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
