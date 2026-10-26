import {
  LIMIT_NO_RESET_TTL_MS,
  limitExpiresAt,
  nextLimitReading,
  type LimitRecord,
  type LimitSample,
  type ServerEvent,
} from "@gram/contracts";
import { create } from "zustand";

type UsageLimitEvent = Extract<ServerEvent, { type: "usageLimit" }>;

/** The subscriptions the meter knows: the CLIs' own logins, never a gateway's. */
export const LIMIT_PROVIDERS = ["claude", "codex"] as const;
export type LimitProvider = (typeof LIMIT_PROVIDERS)[number];

export const LIMIT_WINDOWS = ["fiveHour", "weekly"] as const;
export type LimitWindow = (typeof LIMIT_WINDOWS)[number];

/** The share of a window used from which the meter turns warning-coloured. */
const LIMIT_WARN_AT = 0.8;

/** How long a reading without a reset time stays current (`LIMIT_NO_RESET_TTL_MS`). */
export const NO_RESET_TTL_MS = LIMIT_NO_RESET_TTL_MS;

/** A reading no agent has repeated for this long shows its age. */
export const LIMIT_STALE_MS = 10 * 60 * 1000;

/**
 * The same reading again within this long changes nothing: agents report on every request, and
 * the age it would move on is shown to the minute.
 */
const REPEAT_QUIET_MS = 60 * 1000;

/** The latest reading of one provider's window. */
export interface UsageLimit {
  /** From 0 to 1. */
  readonly utilization: number;
  /** Epoch ms; absent when the agent gave none. */
  readonly resetsAt?: number;
  readonly status: UsageLimitEvent["status"];
  /** The agent goes on past the window on credits: a full window here is no stop. */
  readonly credits?: true;
  /** Epoch ms it stops counting: its reset, or `NO_RESET_TTL_MS` after it arrived without one. */
  readonly expiresAt: number;
  /** Epoch ms the latest reading arrived; absent in a reading made up for display. */
  readonly at?: number;
  /** The window's readings so far, one per change in use, for the forecast. */
  readonly samples?: ReadonlyArray<LimitSample>;
}

export type UsageLimits = {
  readonly [P in LimitProvider]?: { readonly [W in LimitWindow]?: UsageLimit };
};

/** The agent's window name as the meter's, or `undefined` for one it doesn't show (overage, per-model). */
export const limitWindowOf = (window: string): LimitWindow | undefined =>
  window === "five_hour" ? "fiveHour" : window === "seven_day" ? "weekly" : undefined;

const isProvider = (agent: string): agent is LimitProvider =>
  (LIMIT_PROVIDERS as readonly string[]).includes(agent);

/**
 * `limits` with `event`, read at `now`, in it, or `limits` itself when the reading isn't one the
 * meter shows: a gateway's, another agent's, another window's, one with no share used and not at
 * the limit, or one whose reset has already passed. A later reading replaces the window's last,
 * so the next plain reading clears a rejection.
 */
export function withReading(limits: UsageLimits, event: UsageLimitEvent, now: number): UsageLimits {
  const window = limitWindowOf(event.window);
  if (event.gateway === true || !isProvider(event.agent) || window === undefined) return limits;
  const before = limits[event.agent]?.[window];
  const reading = nextLimitReading(
    before === undefined
      ? undefined
      : {
          ...before,
          at: before.at ?? before.expiresAt - NO_RESET_TTL_MS,
          samples: before.samples ?? [],
        },
    event,
    now,
  );
  if (reading === undefined || (before !== undefined && reading.at === before.at)) return limits;
  // The same reading again soon after changes nothing, unless it moves a reset-less reading's
  // expiry on by more than that.
  if (
    before?.at !== undefined &&
    before.utilization === reading.utilization &&
    before.status === reading.status &&
    before.credits === reading.credits &&
    before.resetsAt === reading.resetsAt &&
    now - before.at < REPEAT_QUIET_MS
  )
    return limits;
  return { ...limits, [event.agent]: { ...limits[event.agent], [window]: limitOf(reading) } };
}

const limitOf = (reading: Omit<LimitRecord, "agent" | "window" | "profileId">): UsageLimit => ({
  utilization: reading.utilization,
  status: reading.status,
  ...(reading.resetsAt === undefined ? {} : { resetsAt: reading.resetsAt }),
  ...(reading.credits === true ? { credits: true as const } : {}),
  expiresAt: limitExpiresAt(reading),
  at: reading.at,
  samples: reading.samples,
});

/**
 * The readings the server kept, as it replays them to a client that connects: the subscription's
 * windows the meter shows, still current at `now`. They replace whatever the client had.
 */
export function limitsOf(records: ReadonlyArray<LimitRecord>, now: number): UsageLimits {
  let limits: UsageLimits = {};
  for (const record of records) {
    const window = limitWindowOf(record.window);
    if (record.profileId !== undefined || !isProvider(record.agent) || window === undefined)
      continue;
    const limit = limitOf(record);
    if (limit.expiresAt <= now) continue;
    limits = { ...limits, [record.agent]: { ...limits[record.agent], [window]: limit } };
  }
  return limits;
}

/**
 * A reading still current at `now`: one whose reset has passed says nothing about the new window,
 * and one without a reset lapses `NO_RESET_TTL_MS` after it came.
 */
export const currentLimit = (limit: UsageLimit | undefined, now: number): UsageLimit | undefined =>
  limit === undefined || limit.expiresAt <= now ? undefined : limit;

export interface TightestLimit {
  readonly provider: LimitProvider;
  readonly window: LimitWindow;
  readonly limit: UsageLimit;
}

/** The current reading closest to its limit; on a tie, the one that resets first. */
export function tightestLimit(limits: UsageLimits, now: number): TightestLimit | undefined {
  let best: TightestLimit | undefined;
  for (const provider of LIMIT_PROVIDERS)
    for (const window of LIMIT_WINDOWS) {
      const limit = currentLimit(limits[provider]?.[window], now);
      if (limit === undefined) continue;
      if (
        best === undefined ||
        limit.utilization > best.limit.utilization ||
        (limit.utilization === best.limit.utilization &&
          (limit.resetsAt ?? Infinity) < (best.limit.resetsAt ?? Infinity))
      )
        best = { provider, window, limit };
    }
  return best;
}

/** The soonest expiry after `now` among the readings, when the meter next has to look again. */
export function nextExpiry(limits: UsageLimits, now: number): number | undefined {
  let soonest: number | undefined;
  for (const provider of LIMIT_PROVIDERS)
    for (const window of LIMIT_WINDOWS) {
      const at = limits[provider]?.[window]?.expiresAt;
      if (at !== undefined && at > now && (soonest === undefined || at < soonest)) soonest = at;
    }
  return soonest;
}

/**
 * The soonest moment after `now` the meter reads differently with no new reading: one expires, or
 * one turns stale (`LIMIT_STALE_MS`).
 */
export function nextLimitChange(limits: UsageLimits, now: number): number | undefined {
  let soonest = nextExpiry(limits, now);
  for (const provider of LIMIT_PROVIDERS)
    for (const window of LIMIT_WINDOWS) {
      const at = limits[provider]?.[window]?.at;
      const staleAt = at === undefined ? undefined : at + LIMIT_STALE_MS;
      if (staleAt !== undefined && staleAt > now && (soonest === undefined || staleAt < soonest))
        soonest = staleAt;
    }
  return soonest;
}

/** When the newest reading arrived, or 0 with none. */
export function latestReadingAt(limits: UsageLimits): number {
  let latest = 0;
  for (const provider of LIMIT_PROVIDERS)
    for (const window of LIMIT_WINDOWS)
      latest = Math.max(latest, limits[provider]?.[window]?.at ?? 0);
  return latest;
}

export const limitWarns = (limit: UsageLimit): boolean =>
  limit.status === "rejected" || limit.utilization >= LIMIT_WARN_AT;

/** Whether no agent has repeated `limit` for `LIMIT_STALE_MS`, so its age is worth showing. */
export const limitStale = (limit: UsageLimit, now: number): boolean =>
  limit.at !== undefined && now - limit.at >= LIMIT_STALE_MS;

interface UsageLimitsState {
  /** The latest reading per provider and window. */
  readonly limits: UsageLimits;
  record(event: UsageLimitEvent): void;
  /** Puts the server's kept readings in place of the client's (`usageLimits.snapshot`). */
  replace(records: ReadonlyArray<LimitRecord>): void;
}

/**
 * Subscription limits as app state: the readings the server kept, replayed when the client
 * connects, then every `usageLimit` reading it forwards. Only the latest per provider and window
 * is kept, with that window's samples for the forecast.
 */
export const useUsageLimits = create<UsageLimitsState>()((set) => ({
  limits: {},
  record: (event) =>
    set((s) => {
      const limits = withReading(s.limits, event, Date.now());
      return limits === s.limits ? s : { limits };
    }),
  replace: (records) => set({ limits: limitsOf(records, Date.now()) }),
}));
