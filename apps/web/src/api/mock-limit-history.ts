import {
  coarsenCreditPoints,
  coarsenLimitPoints,
  LIMIT_HISTORY_BUCKET_MS,
  limitHistoryBucket,
  limitHistoryStep,
  LIMIT_WINDOW_MS,
  type AgentKind,
  type CreditHistoryPoint,
  type LimitHistoryDays,
  type LimitHistoryPoint,
  type LimitHistorySeries,
  type UsageLimitHistory,
} from "@gram/contracts";

import { MOCK_LIMITS_KEY, mockLimitSeeds } from "./mock-limits";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A fixed pseudo-random share from 0 to 1 for `n`, so the invented history is the same each run. */
const noise = (n: number): number => {
  const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
};

/** Whether the app was open to read a limit at `at`: the waking hours, as a real day has. */
const watched = (at: number): boolean => {
  const hour = new Date(at).getUTCHours();
  return hour >= 7 && hour < 22;
};

/**
 * One window's invented quarter hours over `days` before `now`, ending on the kept reading the
 * meter shows. Each past window, counted back from the current reset, fills toward a peak of its
 * own and drops at its reset; a 5-hour window often goes unused, and nothing is read overnight.
 */
function windowPoints(
  window: string,
  current: { readonly utilization: number; readonly resetsAt?: number },
  days: number,
  now: number,
): LimitHistoryPoint[] {
  const length = LIMIT_WINDOW_MS[window];
  if (length === undefined || current.resetsAt === undefined) return [];
  const from = now - days * DAY;
  const points: LimitHistoryPoint[] = [];
  for (let reset = current.resetsAt, n = 0; reset - length > from - length; reset -= length, n++) {
    const start = reset - length;
    const live = n === 0;
    const used = window === "five_hour" ? noise(start / HOUR) < 0.45 : true;
    if (!live && !used) continue;
    // The current window ends on the kept reading; a past one at a peak of its own.
    const top = live
      ? current.utilization
      : window === "five_hour"
        ? 0.25 + noise(start / HOUR + 7) * 0.75
        : 0.45 + noise(start / DAY + 3) * 0.5;
    const until = live ? now : reset - LIMIT_HISTORY_BUCKET_MS;
    let peak = 0;
    for (
      let at = limitHistoryBucket(Math.max(start, from));
      at <= until;
      at += LIMIT_HISTORY_BUCKET_MS
    ) {
      if (at < start || (!watched(at) && !(live && now - at < 2 * HOUR))) continue;
      const through = Math.min(1, (at - start) / (until - start || 1));
      // Use rises in bursts: a gentle curve with a little wobble, never falling inside a window.
      const share = Math.min(
        1,
        top * (through ** 0.8 + (noise(at / LIMIT_HISTORY_BUCKET_MS) - 0.5) * 0.04),
      );
      peak = Math.max(peak, share);
      points.push({ at, utilization: peak, peak, resetsAt: reset });
    }
  }
  return points.toSorted((a, b) => a.at - b.at);
}

/**
 * Codex's invented credit balance over the period: spent a little through each working hour, with
 * one top-up three weeks ago, ending on the balance the kept reading names.
 */
function creditPoints(balance: number, days: number, now: number): CreditHistoryPoint[] {
  const points: CreditHistoryPoint[] = [];
  let left = balance;
  for (let at = limitHistoryBucket(now); at >= now - days * DAY; at -= HOUR) {
    if (watched(at)) points.push({ at, balance: Math.round(left) });
    if (Math.abs(at - (now - 21 * DAY)) < HOUR / 2) left -= 500;
    if (watched(at)) left += noise(at / HOUR) < 0.3 ? Math.round(noise(at / HOUR + 1) * 12) : 0;
  }
  return points.toReversed();
}

/**
 * The limit history the mock serves, made up from its kept readings (`mockLimitSeeds`) so the
 * charts end where the meter stands. Nothing when an e2e spec starts with no limits reported.
 */
export function mockLimitHistory(days: LimitHistoryDays, now: number): UsageLimitHistory {
  const step = limitHistoryStep(days);
  const from = limitHistoryBucket(now - days * DAY, step);
  const none =
    typeof sessionStorage !== "undefined" && sessionStorage.getItem(MOCK_LIMITS_KEY) === "none";
  if (none) return { from, to: now, step, windows: [], credits: [] };
  const seeds = mockLimitSeeds(now);
  const windows: LimitHistorySeries[] = seeds.map((seed) => ({
    agent: seed.agent,
    window: seed.window,
    points: coarsenLimitPoints(windowPoints(seed.window, seed, days, now), step),
  }));
  const balance = Number(seeds.find((seed) => seed.creditsBalance !== undefined)?.creditsBalance);
  const credits = Number.isFinite(balance)
    ? [
        {
          agent: "codex" as AgentKind,
          points: coarsenCreditPoints(creditPoints(balance, days, now), step),
        },
      ]
    : [];
  return { from, to: now, step, since: now - 34 * DAY, windows, credits };
}
