// Waiting out a provider limit (`Thread.limitWait`): when a limit resets according to the agent's own
// words, when each waiting thread resumes, and how long a bare 429 waits before its next try.

import {
  LIMIT_SAME_WINDOW_MS,
  type AgentFailure,
  type LimitWait,
  type ThreadId,
} from "@gram/contracts";

import { DAY_MS, formatterOf, plusDays, wallDate, zoned } from "../zone-time.ts";

/** How long after a limit's reset its first thread resumes, so the provider has turned over. */
export const LIMIT_RESUME_DELAY_MS = 20_000;

/** The most extra delay one thread's resume takes on, so threads never resume in lockstep. */
export const LIMIT_RESUME_JITTER_MS = 10_000;

/** Workers resumed together after the orchestrator, per batch. */
const LIMIT_RESUME_BATCH = 3;

/** How long each batch of workers waits behind the one before it (the orchestrator's included). */
export const LIMIT_RESUME_BATCH_GAP_MS = 45_000;

/** How long a limit whose reset the agent didn't say waits before Gram tries again. */
export const LIMIT_UNKNOWN_RESET_MS = 30 * 60_000;

/** The first wait after a bare 429, doubled for each later one. */
export const BACKOFF_BASE_MS = 30_000;

/** The longest one backoff wait lasts. */
export const BACKOFF_MAX_DELAY_MS = 8 * 60_000;

/** Retries a bare 429 gets before it stands as an ordinary error. */
export const BACKOFF_MAX_ATTEMPTS = 5;

/**
 * A clock time this recently past is the reset that just went by, not tomorrow's: the limit
 * outlasted it, which a backoff waits out rather than a day.
 */
const JUST_PAST_MS = 10 * 60_000;

/** A reset further off than this is a misread, never a wait. */
const RESET_HORIZON_MS = 8 * DAY_MS;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const hour24 = (hour: number, meridiem: string | undefined): number => {
  const half = meridiem?.toLowerCase();
  if (half === "a") return hour % 12;
  if (half === "p") return (hour % 12) + 12;
  return hour;
};

// "resets 12:50pm (Europe/Oslo)", "resets Oct 9, 10am", "Try again at 3:05 PM.",
// "Try again at Oct 16th, 2026 3:05 PM."
const AT_TIME = new RegExp(
  String.raw`(?:\breset(?:s|ting)?(?:\s+at)?|\btry again at)\s+` +
    String.raw`(?:(?:on\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:(\d{4}),?\s+)?(?:at\s+)?)?` +
    String.raw`(\d{1,2})(?::(\d{2}))?\s*(?:([ap])\.?\s?m\b\.?)?` +
    String.raw`(?:\s*\(([A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+|UTC|GMT)\))?`,
  "i",
);

// "try again in 2 hours 5 minutes", "try again in 4 days 1 hour", "resets in 3h 20m".
const IN_DURATION =
  /\b(?:try again|resets?)\s+in\s+((?:\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,]*(?:and\s+)?)+)/i;

const UNIT_MS: ReadonlyArray<readonly [RegExp, number]> = [
  [/^d/i, DAY_MS],
  [/^h/i, 60 * 60_000],
  [/^m/i, 60_000],
  [/^s/i, 1000],
];

// Claude Code's older form: "Claude AI usage limit reached|1760000000".
const EPOCH = /limit reached\|(\d{10})\b/i;

/**
 * Epoch ms the limit in an agent's message resets, from Claude Code's "resets 12:50pm
 * (Europe/Oslo)" or "resets Oct 9, 10am", Codex's "Try again at 3:05 PM." or "try again in 2 hours",
 * or Claude's older `|epoch` form. A clock time with no zone of its own is in `localZone`, the zone the
 * CLI printed it in, since it runs on this machine. `undefined` when the message names no reset, one
 * that isn't still to come (a reset that has just passed says the limit outlasted it), or one more
 * than a week off.
 */
export const limitResetAt = (
  text: string,
  now: number,
  localZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone,
): number | undefined => readReset(text, now, localZone).at;

/**
 * `limitResetAt`'s reading, with `rolledFrom`: the time a clock time or yearless date named before
 * it was taken as the next one (tomorrow's, next year's), since that one had passed. A thread that
 * has already waited out that very time is reading the same reset again, not a new one.
 */
const readReset = (
  text: string,
  now: number,
  localZone: string,
): { readonly at: number | undefined; readonly rolledFrom?: number } => {
  const sane = (at: number | undefined) => ({ at: saneAt(at) });
  const saneAt = (at: number | undefined) =>
    at !== undefined && Number.isFinite(at) && at > now && at - now <= RESET_HORIZON_MS
      ? at
      : undefined;
  const epoch = EPOCH.exec(text);
  if (epoch !== null) return sane(Number(epoch[1]) * 1000);
  const span = IN_DURATION.exec(text);
  if (span !== null) {
    let total = 0;
    for (const [, amount, unit] of span[1]!.matchAll(/(\d+)\s*([a-z]+)/gi)) {
      const scale = UNIT_MS.find(([pattern]) => pattern.test(unit!))?.[1];
      if (scale !== undefined) total += Number(amount) * scale;
    }
    return sane(total > 0 ? now + total : undefined);
  }
  const match = AT_TIME.exec(text);
  if (match === null) return sane(undefined);
  const [, monthName, dayText, yearText, hourText, minuteText, meridiem, zoneName] = match;
  // A bare number with no minutes and no am/pm is a count, not a clock time.
  if (minuteText === undefined && meridiem === undefined) return sane(undefined);
  const hour = hour24(Number(hourText), meridiem);
  const minute = minuteText === undefined ? 0 : Number(minuteText);
  if (hour > 23 || minute > 59) return sane(undefined);
  const format =
    (zoneName === undefined ? undefined : formatterOf(zoneName)) ?? formatterOf(localZone);
  if (format === undefined) return sane(undefined);
  const today = wallDate(format, now);
  if (monthName !== undefined) {
    const month = MONTHS.indexOf(monthName.toLowerCase().slice(0, 3));
    const day = Number(dayText);
    const named = (year: number) => zoned(format, { year, month, day }, hour, minute);
    if (yearText !== undefined) return sane(named(Number(yearText)));
    // A date with no year is the next one: December's "Jan 2" is next year's.
    const thisYear = named(today.year);
    return thisYear > now - JUST_PAST_MS
      ? sane(thisYear)
      : { at: saneAt(named(today.year + 1)), rolledFrom: thisYear };
  }
  const at = zoned(format, today, hour, minute);
  // A time well past today is tomorrow's; one just past is a reset that came and went.
  return at > now - JUST_PAST_MS
    ? sane(at)
    : { at: saneAt(zoned(format, plusDays(today, 1), hour, minute)), rolledFrom: at };
};

/** What a failed turn's limit is: a reset to wait for, a bare 429 to back off from, or neither. */
export type LimitClass =
  | { readonly kind: "limit"; readonly resetsAt: number | undefined }
  | { readonly kind: "backoff" }
  | undefined;

/**
 * Whether `failure` is a limit to wait out. A subscription limit is the agent saying when it resets,
 * a reset the account's rejected readings carry (`knownReset`, the CLI's own structured reset), or
 * a usage limit the agent marks final; the later of the first two, so a weekly rejection outlasts a
 * sooner session reset. Only when neither names one does `otherWaits`, the reset other threads on
 * the account wait for, stand in: it may be another window's, or one long since lifted, never this
 * limit's own. A retryable rate limit with none of those is a bare 429. Every other failure, a
 * gateway's refusal included, stays an error. `waitedOut` is the reset the thread last waited for:
 * a limit met again names a new reset only when it is later than that one, and otherwise has
 * outlasted it, which backs off. The same clock time read again ("resets 12:50pm" after 12:50) is
 * that reset, never tomorrow's.
 */
export const classifyLimit = (
  failure: AgentFailure,
  detail: string,
  now: number,
  knownReset: number | undefined,
  localZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone,
  waitedOut?: number,
  otherWaits?: number,
): LimitClass => {
  if (failure.kind !== "rateLimit") return undefined;
  const fresh = (at: number | undefined) =>
    at !== undefined && at > now && (waitedOut === undefined || at > waitedOut) ? at : undefined;
  const read = readReset(detail, now, localZone);
  const again =
    read.rolledFrom !== undefined && waitedOut !== undefined && read.rolledFrom <= waitedOut;
  const candidates = [again ? undefined : fresh(read.at), fresh(knownReset)].filter(
    (at): at is number => at !== undefined,
  );
  const resetsAt = candidates.length === 0 ? fresh(otherWaits) : Math.max(...candidates);
  if (resetsAt !== undefined) return { kind: "limit", resetsAt };
  if (waitedOut !== undefined || failure.retryable) return { kind: "backoff" };
  return { kind: "limit", resetsAt: undefined };
};

/** A small spread from the thread's id, the same on every plan, so a re-plan never reshuffles it. */
const jitterOf = (threadId: string, span: number = LIMIT_RESUME_JITTER_MS): number => {
  let hash = 0;
  for (let i = 0; i < threadId.length; i++) hash = (hash * 31 + threadId.charCodeAt(i)) | 0;
  return Math.abs(hash) % (span + 1);
};

/** The delay before backoff retry `attempt` (1-based): doubling, capped, with the thread's jitter. */
export const backoffDelay = (threadId: string, attempt: number): number =>
  Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1), BACKOFF_MAX_DELAY_MS) +
  jitterOf(threadId, 5000);

/** One waiting thread, as the plan orders it. */
export interface Waiter {
  readonly threadId: ThreadId;
  readonly wait: LimitWait;
  /** An orchestrator resumes before its account's workers. */
  readonly orchestrator: boolean;
}

/**
 * When each of one account's `limit` waiters resumes: the orchestrators first, a little past the
 * reset, then the workers in batches of `LIMIT_RESUME_BATCH`, longest waiting first, each batch
 * `LIMIT_RESUME_BATCH_GAP_MS` behind the one before (the first batch leads with no orchestrator), so the account doesn't meet its limit again
 * the moment it lifts. `reset` is the account's latest known reset.
 */
export const resumePlan = (
  waiters: ReadonlyArray<Waiter>,
  reset: number,
): ReadonlyMap<ThreadId, number> => {
  const ordered = waiters.toSorted(
    (a, b) =>
      Number(b.orchestrator) - Number(a.orchestrator) ||
      a.wait.since - b.wait.since ||
      a.threadId.localeCompare(b.threadId),
  );
  const plan = new Map<ThreadId, number>();
  // With no orchestrator waiting, the first batch of workers goes first.
  const lead = ordered.some((each) => each.orchestrator) ? 1 : 0;
  let worker = 0;
  for (const each of ordered) {
    const batch = each.orchestrator ? 0 : Math.floor(worker++ / LIMIT_RESUME_BATCH) + lead;
    plan.set(
      each.threadId,
      reset + LIMIT_RESUME_DELAY_MS + batch * LIMIT_RESUME_BATCH_GAP_MS + jitterOf(each.threadId),
    );
  }
  return plan;
};

/**
 * When each worker the user's resume of a paused workspace lets go of goes, `workers` in their
 * order: in batches of `LIMIT_RESUME_BATCH`, the first `LIMIT_RESUME_BATCH_GAP_MS` after `now`, so
 * the orchestrator, woken at once, goes first; each with its thread's jitter, as a limit's resume.
 */
export const pauseResumePlan = (
  workers: ReadonlyArray<ThreadId>,
  now: number,
): ReadonlyMap<ThreadId, number> =>
  new Map(
    workers.map((threadId, index) => [
      threadId,
      now +
        (Math.floor(index / LIMIT_RESUME_BATCH) + 1) * LIMIT_RESUME_BATCH_GAP_MS +
        jitterOf(threadId),
    ]),
  );

/**
 * When the `index`th (from 0) of what a lifted limit lets go starts, from `now`: in batches of
 * `LIMIT_RESUME_BATCH`, the first at once and each next one `LIMIT_RESUME_BATCH_GAP_MS` on, as a
 * limit's resume spaces its workers.
 */
export const releaseBatchAt = (index: number, now: number): number =>
  now + Math.floor(index / LIMIT_RESUME_BATCH) * LIMIT_RESUME_BATCH_GAP_MS;

/** Which release batch, from 1, the `count`th worker let go in a wave takes. */
const batchOf = (count: number) => Math.floor(count / LIMIT_RESUME_BATCH) + 1;

/** Workers let go from a hold together: when the first went, and how many have since. */
export interface ReleaseWave {
  readonly start: number;
  readonly count: number;
}

/**
 * When a worker a hold kept back resumes, once let go: in batches of `LIMIT_RESUME_BATCH`, the
 * first a `LIMIT_RESUME_BATCH_GAP_MS` after the wave began, so its orchestrator, let go with it,
 * goes first. A wave whose batches are all past is over, and the next release starts another.
 */
export const releaseSlot = (
  wave: ReleaseWave | undefined,
  now: number,
): { readonly at: number; readonly wave: ReleaseWave } => {
  const current =
    wave !== undefined && now < wave.start + batchOf(wave.count) * LIMIT_RESUME_BATCH_GAP_MS
      ? wave
      : { start: now, count: 0 };
  return {
    at: current.start + batchOf(current.count) * LIMIT_RESUME_BATCH_GAP_MS,
    wave: { start: current.start, count: current.count + 1 },
  };
};

/** "12:50": a resume time on the 24-hour clock, in the machine's own zone. */
export const clockText = (at: number): string =>
  new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });

const dayOf = (at: number): string => new Date(at).toDateString();

/** "12:50" today, "Sat 21:00" on another day: a resume time as `clockText`, with its day if not today. */
export const resumeText = (at: number, now: number): string =>
  dayOf(at) === dayOf(now)
    ? clockText(at)
    : `${new Date(at).toLocaleDateString("en-GB", { weekday: "short" })} ${clockText(at)}`;

/** How often a resume a hold kept back asks again. */
export const LIMIT_HELD_RECHECK_MS = 60_000;

/** What a resumed thread is sent, as the user's own "continue" would be. */
export const LIMIT_RESUME_TEXT = "The usage limit has reset. Continue where you left off.";

/** The login a thread's limits count against, as `Runtime.quota` names it: `agent/profileId`. */
export const accountOf = (model: {
  readonly agent: string;
  readonly profileId?: string | undefined;
}): string => `${model.agent}/${model.profileId ?? ""}`;

/** What a sender is told of input queued behind a limit: not a failure, and when it goes. */
export const limitQueuedNote = (wait: Pick<LimitWait, "resumeAt">, now: number): string =>
  `It waits out a usage limit, so this is queued and goes when it resumes at about ${resumeText(wait.resumeAt, now)} (local time). That isn't a failure; nothing to do.`;

/** "1 h 12 min", "25 min", "under a minute". */
export const spanText = (ms: number): string => {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "under a minute";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours === 0 ? `${rest} min` : rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
};

/** A reading older than this says nothing about whether a limit still applies now. */
export const LIMIT_FRESH_MS = 5 * 60_000;

/** The least time between two early releases of one account, doubled for each that follows. */
export const LIMIT_EARLY_GAP_MS = 10 * 60_000;

/** The longest gap between two early releases of one account. */
export const LIMIT_EARLY_GAP_MAX_MS = 2 * 60 * 60_000;

/** What a thread resumed early is sent: the limit didn't reset, it stopped applying. */
export const LIMIT_CLEARED_TEXT = "The usage limit no longer applies. Continue where you left off.";

/** One window's reading, as `UsageLimitReadings.current` has it. */
export interface AccountReading {
  readonly agent: string;
  readonly profileId?: string | undefined;
  readonly window: string;
  readonly status: string;
  readonly utilization: number;
  readonly credits?: true | undefined;
  /** Epoch ms the window resets; absent when the agent gave none. */
  readonly resetsAt?: number | undefined;
  /** Epoch ms it was read. */
  readonly at: number;
}

/**
 * Whether fresh readings say `account`'s limit no longer applies at `now`, though a thread waits
 * on it: at least one of its windows was read since its latest limit (`hitAt`) and within
 * `LIMIT_FRESH_MS`, and none of its windows is rejected, or full with no credits to go on with. No
 * reading, or only old ones, is never a release; neither is any window at its limit, however fresh
 * the others are.
 */
export const limitClearedBy = (
  readings: ReadonlyArray<AccountReading>,
  account: string,
  hitAt: number,
  now: number,
): boolean => {
  const own = readings.filter((reading) => accountOf(reading) === account);
  return (
    own.some((reading) => reading.at > hitAt && now - reading.at <= LIMIT_FRESH_MS) &&
    own.every(
      (reading) =>
        reading.status !== "rejected" && (reading.utilization < 1 || reading.credits === true),
    )
  );
};

/**
 * An account's early releases: when the last one was, how many since a turn went through, and the
 * reset each of the account's windows named then (`windowsOf`).
 */
export interface EarlyReleases {
  readonly at: number;
  readonly count: number;
  readonly windows: ReadonlyMap<string, number>;
}

/** The reset each of `account`'s windows names in `readings`, for `limitTurnedOver` to compare. */
export const windowsOf = (
  readings: ReadonlyArray<AccountReading>,
  account: string,
): ReadonlyMap<string, number> =>
  new Map(
    readings.flatMap((reading) =>
      accountOf(reading) === account && reading.resetsAt !== undefined
        ? [[reading.window, reading.resetsAt] as const]
        : [],
    ),
  );

/**
 * Whether `account`'s readings are of other windows than the ones its last early release (`last`)
 * went on: a window read fresh since then (`LIMIT_FRESH_MS`) names a reset more than
 * `LIMIT_SAME_WINDOW_MS` from the one it named then. The window reset early, or the CLI was signed
 * in to another login, whose windows are its own: the release that met the limit again said nothing
 * of these, so its spacing (`earlyReleaseDue`) doesn't hold them back. A window with no reset then
 * or now, or one not read then, is no evidence either way.
 */
export const limitTurnedOver = (
  readings: ReadonlyArray<AccountReading>,
  account: string,
  last: EarlyReleases | undefined,
  now: number,
): boolean =>
  last !== undefined &&
  readings.some((reading) => {
    if (accountOf(reading) !== account || reading.resetsAt === undefined) return false;
    if (reading.at <= last.at || now - reading.at > LIMIT_FRESH_MS) return false;
    const before = last.windows.get(reading.window);
    return before !== undefined && Math.abs(reading.resetsAt - before) > LIMIT_SAME_WINDOW_MS;
  });

/**
 * When `account` may next be released early: at once the first time, then `LIMIT_EARLY_GAP_MS`
 * after the last, doubling with each release a limit met again, so a limit the readings can't see
 * (a model's own window) is retried a few times, further apart, and never in a loop.
 */
export const earlyReleaseDue = (last: Pick<EarlyReleases, "at" | "count"> | undefined): number =>
  last === undefined
    ? -Infinity
    : last.at + Math.min(LIMIT_EARLY_GAP_MS * 2 ** (last.count - 1), LIMIT_EARLY_GAP_MAX_MS);
