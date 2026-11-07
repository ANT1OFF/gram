// Subscription limit history: the windows' readings over past weeks, downsampled into fixed
// buckets and kept by the server so the Usage page can chart them. Only the shares, resets and
// credit balances the app already reads, never a token, a login or an account identifier.

import * as Schema from "effect/Schema";
import { AgentKind } from "./domain.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The bucket a reading is kept in: one row per agent, window and quarter hour. */
export const LIMIT_HISTORY_BUCKET_MS = 15 * MINUTE;

/** How long a bucket is kept; past it the server prunes it. A little over the longest period. */
export const LIMIT_HISTORY_RETENTION_MS = 35 * DAY;

/** The periods the Usage page charts, in days. */
export const LIMIT_HISTORY_DAYS = [7, 30] as const;
export const LimitHistoryDays = Schema.Literals(LIMIT_HISTORY_DAYS);
export type LimitHistoryDays = typeof LimitHistoryDays.Type;

/** The step a period is served at: a quarter hour for a week, an hour for a month. */
export const limitHistoryStep = (days: LimitHistoryDays): number =>
  days <= 7 ? LIMIT_HISTORY_BUCKET_MS : HOUR;

/** The start of the bucket `at` falls in, for a step of `step` ms. */
export const limitHistoryBucket = (at: number, step = LIMIT_HISTORY_BUCKET_MS): number =>
  Math.floor(at / step) * step;

export const LimitHistoryQuery = Schema.Struct({ days: LimitHistoryDays });
export type LimitHistoryQuery = typeof LimitHistoryQuery.Type;

/** One bucket of a window: the share last read in it, the highest, and the reset it named. */
export const LimitHistoryPoint = Schema.Struct({
  /** Epoch ms the bucket starts. */
  at: Schema.Number,
  /** From 0 to 1: the last reading in the bucket. */
  utilization: Schema.Number,
  /** From 0 to 1: the highest reading in the bucket. */
  peak: Schema.Number,
  /** Epoch ms; absent when the agent gave none. */
  resetsAt: Schema.optionalKey(Schema.Number),
});
export type LimitHistoryPoint = typeof LimitHistoryPoint.Type;

/** One subscription window's buckets, oldest first. */
export const LimitHistorySeries = Schema.Struct({
  agent: AgentKind,
  /** The agent's name for it, one of `SUBSCRIPTION_LIMIT_WINDOWS`. */
  window: Schema.String,
  points: Schema.Array(LimitHistoryPoint),
});
export type LimitHistorySeries = typeof LimitHistorySeries.Type;

/** One bucket of an account's credits: the balance last read in it. */
export const CreditHistoryPoint = Schema.Struct({ at: Schema.Number, balance: Schema.Number });
export type CreditHistoryPoint = typeof CreditHistoryPoint.Type;

export const CreditHistorySeries = Schema.Struct({
  agent: AgentKind,
  points: Schema.Array(CreditHistoryPoint),
});
export type CreditHistorySeries = typeof CreditHistorySeries.Type;

/** What `app.usageLimitHistory` answers: every subscription window and credit balance kept. */
export const UsageLimitHistory = Schema.Struct({
  /** Epoch ms; the period runs from here to `to`. */
  from: Schema.Number,
  to: Schema.Number,
  /** The bucket width the points are at (`limitHistoryStep`). */
  step: Schema.Number,
  /** The oldest bucket kept for any series, so the page can say since when it records. */
  since: Schema.optionalKey(Schema.Number),
  windows: Schema.Array(LimitHistorySeries),
  credits: Schema.Array(CreditHistorySeries),
});
export type UsageLimitHistory = typeof UsageLimitHistory.Type;

/**
 * A credit balance as Codex gives it ("1250", "1,250.5") as a number, or `undefined` when it isn't
 * one: a balance the app can't read is never charted as zero.
 */
export const creditBalanceNumber = (balance: string | undefined): number | undefined => {
  if (balance === undefined) return undefined;
  const plain = balance.trim().replaceAll(",", "");
  if (!/^-?\d+(\.\d+)?$/.test(plain)) return undefined;
  const value = Number(plain);
  return Number.isFinite(value) ? value : undefined;
};

/**
 * Buckets at `step` from finer ones, oldest first: each keeps the last reading in it, the highest
 * peak, and the last reset named.
 */
export function coarsenLimitPoints(
  points: ReadonlyArray<LimitHistoryPoint>,
  step: number,
): LimitHistoryPoint[] {
  const out: LimitHistoryPoint[] = [];
  for (const point of points) {
    const at = limitHistoryBucket(point.at, step);
    const last = out.at(-1);
    if (last === undefined || last.at !== at) {
      out.push({ ...point, at });
      continue;
    }
    out[out.length - 1] = {
      at,
      utilization: point.utilization,
      peak: Math.max(last.peak, point.peak),
      ...(point.resetsAt !== undefined
        ? { resetsAt: point.resetsAt }
        : last.resetsAt !== undefined
          ? { resetsAt: last.resetsAt }
          : {}),
    };
  }
  return out;
}

/** As `coarsenLimitPoints`, for a credit balance: the last balance in each bucket. */
export function coarsenCreditPoints(
  points: ReadonlyArray<CreditHistoryPoint>,
  step: number,
): CreditHistoryPoint[] {
  const out: CreditHistoryPoint[] = [];
  for (const point of points) {
    const at = limitHistoryBucket(point.at, step);
    if (out.at(-1)?.at === at) out[out.length - 1] = { at, balance: point.balance };
    else out.push({ at, balance: point.balance });
  }
  return out;
}

export interface CreditBurn {
  /** Credits spent over the span: the falls in balance, top-ups left out. */
  readonly spent: number;
  /** Credits added over the span: the rises in balance. */
  readonly added: number;
  /** Epoch ms of the first and last balance the burn is measured between. */
  readonly from: number;
  readonly to: number;
  /** Spent per day over that span, when it is at least a day long. */
  readonly perDay?: number;
}

/**
 * How fast an account spends its credits over `points`: the sum of every fall in balance (a top-up
 * is a rise, counted apart so it never reads as negative spend), and per day once the readings span
 * a day. `undefined` with fewer than two balances.
 */
export function creditBurn(points: ReadonlyArray<CreditHistoryPoint>): CreditBurn | undefined {
  const first = points[0];
  const last = points.at(-1);
  if (first === undefined || last === undefined || points.length < 2) return undefined;
  let spent = 0;
  let added = 0;
  for (let i = 1; i < points.length; i++) {
    const change = points[i]!.balance - points[i - 1]!.balance;
    if (change < 0) spent -= change;
    else added += change;
  }
  const span = last.at - first.at;
  return {
    spent,
    added,
    from: first.at,
    to: last.at,
    ...(span >= DAY ? { perDay: (spent * DAY) / span } : {}),
  };
}

/** Each subscription window's length, for an even pace through it. */
export const LIMIT_WINDOW_MS: Readonly<Record<string, number>> = {
  five_hour: 5 * HOUR,
  seven_day: 7 * DAY,
};

export interface LimitPace {
  /** From 0 to 1: how much of the window has gone by at `now`. */
  readonly elapsed: number;
  /** Used minus elapsed: above 0 the window is filling faster than an even pace. */
  readonly ahead: number;
}

/**
 * Where a window stands against an even pace through it: the share of its length gone by (from its
 * reset and length) beside the share used. `undefined` without a reset, for a window whose length
 * isn't known, or once the reset has passed.
 */
export function limitPace(
  window: string,
  reading: { readonly utilization: number; readonly resetsAt?: number | undefined },
  now: number,
): LimitPace | undefined {
  const length = LIMIT_WINDOW_MS[window];
  if (length === undefined || reading.resetsAt === undefined || reading.resetsAt <= now) return;
  const elapsed = Math.min(1, Math.max(0, 1 - (reading.resetsAt - now) / length));
  return { elapsed, ahead: reading.utilization - elapsed };
}
