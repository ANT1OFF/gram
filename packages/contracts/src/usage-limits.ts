// Subscription limits as app state: the latest reading of each window the CLIs report, kept by the
// server across restarts and replayed to every client that connects, and the forecast drawn from it.

import * as Schema from "effect/Schema";
import { rateLimitFields } from "./agent.ts";
import { AgentKind } from "./domain.ts";

/** The agents' names for the windows the meter shows; overage and per-model windows are left out. */
export const SUBSCRIPTION_LIMIT_WINDOWS = ["five_hour", "seven_day"] as const;
export type SubscriptionLimitWindow = (typeof SUBSCRIPTION_LIMIT_WINDOWS)[number];

export const isSubscriptionLimitWindow = (window: string): window is SubscriptionLimitWindow =>
  (SUBSCRIPTION_LIMIT_WINDOWS as readonly string[]).includes(window);

/**
 * How long a reading without a reset time stays current. Agents report on every turn, so a live
 * window is read again well within it, while a rejection that named no reset can't hold the meter
 * at 100% for the rest of the session.
 */
export const LIMIT_NO_RESET_TTL_MS = 60 * 60 * 1000;

/** The most samples a window keeps; past it the oldest go. */
export const LIMIT_SAMPLES_MAX = 120;

/**
 * Two readings whose resets lie further apart than this are of different windows. Within it they
 * are one window whose reported reset moved a little, as a rolling window's does.
 */
export const LIMIT_SAME_WINDOW_MS = 10 * 60 * 1000;

/** A share that falls by more than this starts a new window, whatever the reset says. */
const LIMIT_DROP = 0.1;

/** One change in a window's use: when it was read and the share used then. */
export const LimitSample = Schema.Struct({ at: Schema.Number, utilization: Schema.Number });
export type LimitSample = typeof LimitSample.Type;

/** The latest reading of one window, and how its use rose since the window began. */
export const LimitReading = Schema.Struct({
  status: rateLimitFields.status,
  /** From 0 to 1. */
  utilization: Schema.Number,
  /** Epoch ms; absent when the agent gave none. */
  resetsAt: Schema.optionalKey(Schema.Number),
  /** The latest reading said turns go on past the window on credits (`rateLimitFields.credits`). */
  credits: Schema.optionalKey(Schema.Literal(true)),
  /** Epoch ms the latest reading arrived. */
  at: Schema.Number,
  /** The window's readings, oldest first, one for each change in use, at most `LIMIT_SAMPLES_MAX`. */
  samples: Schema.Array(LimitSample),
});
export type LimitReading = typeof LimitReading.Type;

/** A reading with what it is of: one agent's window, on its own login or a gateway profile's. */
export const LimitRecord = Schema.Struct({
  agent: AgentKind,
  /** The gateway profile it came through; absent for the CLI's own login, the subscription. */
  profileId: Schema.optionalKey(Schema.String),
  /** The agent's name for it, one of `SUBSCRIPTION_LIMIT_WINDOWS`. */
  window: Schema.String,
  ...LimitReading.fields,
});
export type LimitRecord = typeof LimitRecord.Type;

/** What one report of a limit says, as `usageLimit` carries it. */
export interface LimitReport {
  readonly status: LimitReading["status"];
  readonly utilization?: number | undefined;
  readonly resetsAt?: number | undefined;
  readonly credits?: true | undefined;
}

/** A CLI-owned account query's normalized subscription window. */
export interface SubscriptionLimitReport extends LimitReport {
  readonly window: SubscriptionLimitWindow;
  readonly utilization: number;
  readonly resetsAt?: number;
  readonly credits?: true;
}

/** Epoch ms a reading stops counting: its reset, or `LIMIT_NO_RESET_TTL_MS` after it arrived. */
export const limitExpiresAt = (reading: Pick<LimitReading, "resetsAt" | "at">): number =>
  reading.resetsAt ?? reading.at + LIMIT_NO_RESET_TTL_MS;

/** Whether `reading` still says anything at `now`. */
export const limitCurrent = (
  reading: Pick<LimitReading, "resetsAt" | "at"> | undefined,
  now: number,
): boolean => reading !== undefined && limitExpiresAt(reading) > now;

/**
 * `before` with `report`, which arrived at `now`, in it; `before` itself when the report says
 * nothing the meter can use (no share and not at the limit, or a reset already past). A report of a
 * new window (its reset moved past `LIMIT_SAME_WINDOW_MS`, or its share fell) starts the samples
 * over; one of the same window adds a sample when its share changed.
 */
export function nextLimitReading(
  before: LimitReading | undefined,
  report: LimitReport,
  now: number,
  options: { readonly snapshot?: boolean } = {},
): LimitReading | undefined {
  const share = report.utilization ?? (report.status === "rejected" ? 1 : undefined);
  if (share === undefined) return before;
  if (report.resetsAt !== undefined && report.resetsAt <= now) return before;
  const utilization = Math.min(1, Math.max(0, share));
  const last = before?.samples.at(-1);
  const sameWindow =
    before !== undefined &&
    limitCurrent(before, now) &&
    (before.resetsAt === undefined ||
      report.resetsAt === undefined ||
      Math.abs(before.resetsAt - report.resetsAt) <= LIMIT_SAME_WINDOW_MS) &&
    (last === undefined || utilization >= last.utilization - LIMIT_DROP);
  const kept = sameWindow ? before.samples : [];
  const samples =
    sameWindow && last !== undefined && last.utilization === utilization
      ? kept
      : [...kept, { at: now, utilization }].slice(-LIMIT_SAMPLES_MAX);
  const resetsAt = report.resetsAt ?? (sameWindow ? before.resetsAt : undefined);
  return {
    // An account metadata percentage isn't admission proof. A turn's explicit allowed event
    // can clear a rejection, but a still-exhausted snapshot of the same window cannot.
    status:
      options.snapshot === true && sameWindow && before.status === "rejected" && utilization >= 1
        ? "rejected"
        : report.status,
    utilization,
    ...(resetsAt === undefined ? {} : { resetsAt }),
    ...(report.credits === true ? { credits: true as const } : {}),
    at: now,
    samples,
  };
}

/** How far back the forecast takes its pace from. */
export const FORECAST_SPAN_MS = 60 * 60 * 1000;
/** The least a window must have been watched for before it is forecast. */
export const FORECAST_MIN_SPAN_MS = 15 * 60 * 1000;
/** The shares a forecast names, the first one not reached yet. */
export const FORECAST_TARGETS = [0.9, 1] as const;

export interface LimitForecast {
  /** The share it reaches, from `FORECAST_TARGETS`. */
  readonly target: number;
  /** Epoch ms it gets there at the pace of the last hour. */
  readonly at: number;
}

/**
 * When the window reaches its next target share at the pace of the last hour (`FORECAST_SPAN_MS`),
 * or `undefined` when there is too little to tell: a window watched for under
 * `FORECAST_MIN_SPAN_MS`, use that didn't rise, no reset to measure against, or a pace that only
 * gets there after the reset. The pace is the rise since the start of that hour, or since the first
 * sample when the window began within it, over the time to `now`.
 */
export function limitForecast(reading: LimitReading, now: number): LimitForecast | undefined {
  const target = FORECAST_TARGETS.find((each) => reading.utilization < each);
  const [first] = reading.samples;
  if (target === undefined || first === undefined || reading.resetsAt === undefined) return;
  const from = now - FORECAST_SPAN_MS;
  let base = first;
  for (const sample of reading.samples) if (sample.at <= from) base = sample;
  const start = Math.max(base.at, from);
  const rise = reading.utilization - base.utilization;
  if (now - start < FORECAST_MIN_SPAN_MS || rise <= 0) return;
  const at = now + ((target - reading.utilization) * (now - start)) / rise;
  return at < reading.resetsAt ? { target, at } : undefined;
}

/**
 * The approval card a spawn raises when a limit its worker would run against has reached the
 * workspace's threshold: Allow keeps spawning until the reset, Deny pauses new workers until then.
 */
export const LIMIT_PAUSE_TOOL = "mcp__gram__limit_pause";

/** The card's input, which the web reads to word it in the user's own time. */
export const LimitPauseInput = Schema.Struct({
  agent: AgentKind,
  window: Schema.String,
  /** The share used, as a whole percent. */
  usedPct: Schema.Int,
  /** The workspace's threshold (`OrchestratorCharter.pauseAtLimitPct`). */
  pauseAtPct: Schema.Int,
  /** Epoch ms; absent when the agent gave no reset. */
  resetsAt: Schema.optionalKey(Schema.Number),
});
export type LimitPauseInput = typeof LimitPauseInput.Type;
