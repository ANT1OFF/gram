import type {
  CreditBurn,
  CreditHistoryPoint,
  LimitHistoryPoint,
  LimitPace,
  UsageLimitHistory,
} from "@gram/contracts";

import type { LimitProvider, LimitWindow } from "@/stores/usage-limits";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The agent's name for each of the meter's windows, as the history keeps them. */
export const HISTORY_WINDOW: Readonly<Record<LimitWindow, string>> = {
  fiveHour: "five_hour",
  weekly: "seven_day",
};

/** Within this of an even pace, either side, a window is on pace. */
export const PACE_EVEN_BAND = 0.05;

/**
 * "On pace", "12 pts ahead of pace", "18 pts under pace": the share used beside the share of the
 * window gone by, in percentage points, so a number never reads as a share of the limit.
 */
export function paceText(pace: LimitPace): string {
  const points = Math.round(Math.abs(pace.ahead) * 100);
  if (Math.abs(pace.ahead) < PACE_EVEN_BAND || points === 0) return "On pace";
  return pace.ahead > 0 ? `${points} pts ahead of pace` : `${points} pts under pace`;
}

/** What the pace is measured against: "52% of the window gone". */
export const paceDetail = (pace: LimitPace): string =>
  `${Math.round(pace.elapsed * 100)}% of the window gone`;

/** Whether a pace is far enough ahead to say so in the warning colour. */
export const paceWarns = (pace: LimitPace): boolean => pace.ahead >= 0.15;

/**
 * The series' runs with no gap between them: a new run where readings stop for longer than `gap`
 * (the app closed, or nothing reported), so a line never bridges time nobody read.
 */
export function historyRuns<T extends { readonly at: number }>(
  points: readonly T[],
  gap: number,
): T[][] {
  const runs: T[][] = [];
  for (const point of points) {
    const run = runs.at(-1);
    const last = run?.at(-1);
    if (run === undefined || last === undefined || point.at - last.at > gap) runs.push([point]);
    else run.push(point);
  }
  return runs;
}

/** The longest silence a chart's line bridges: two steps, and never under an hour. */
export const historyGap = (step: number): number => Math.max(HOUR, 2 * step);

export interface WindowHistorySummary {
  /** From 0 to 1: the highest share read in the period. */
  readonly peak: number;
  /** How many of the windows seen reached their limit. */
  readonly atLimit: number;
  /** How many windows (distinct resets) were seen. */
  readonly windows: number;
}

/**
 * A window's period at a glance: its peak, and how many of its windows (`windowId`, so a reset
 * inside a bucket counts as two) reached the limit.
 */
export function windowHistorySummary(
  points: readonly LimitHistoryPoint[],
): WindowHistorySummary | undefined {
  if (points.length === 0) return undefined;
  const byWindow = new Map<number, number>();
  let peak = 0;
  for (const point of points) {
    peak = Math.max(peak, point.peak);
    byWindow.set(point.windowId, Math.max(byWindow.get(point.windowId) ?? 0, point.peak));
  }
  const peaks = [...byWindow.values()];
  return { peak, atLimit: peaks.filter((each) => each >= 1).length, windows: peaks.length };
}

/** "Reached the limit in 2 of 9 windows", or `undefined` when no window did. */
export function atLimitText(summary: WindowHistorySummary): string | undefined {
  if (summary.atLimit === 0) return undefined;
  return `Reached the limit in ${summary.atLimit} of ${summary.windows} window${summary.windows === 1 ? "" : "s"}`;
}

/** One provider's window series from the history, oldest first; empty when none was kept. */
export function windowSeries(
  history: UsageLimitHistory | undefined,
  provider: LimitProvider,
  window: LimitWindow,
): readonly LimitHistoryPoint[] {
  return (
    history?.windows.find(
      (each) => each.agent === provider && each.window === HISTORY_WINDOW[window],
    )?.points ?? []
  );
}

export function creditSeries(
  history: UsageLimitHistory | undefined,
  provider: LimitProvider,
): readonly CreditHistoryPoint[] {
  return history?.credits.find((each) => each.agent === provider)?.points ?? [];
}

/** "1,250": a count of credits, whole, grouped by thousands. */
export const creditCount = (value: number): string =>
  Math.round(value).toLocaleString("en-US", { maximumFractionDigits: 0 });

/**
 * "180 spent over 7 days · about 26 a day": what the balance's falls add up to over the readings
 * kept, and per day once they span one. "No credits spent" when the balance never fell.
 */
export function burnText(burn: CreditBurn): string {
  if (burn.spent === 0) return "No credits spent in this period";
  const span = Math.max(1, Math.round((burn.to - burn.from) / DAY));
  const over = burn.to - burn.from < DAY ? "today" : `over ${span} day${span === 1 ? "" : "s"}`;
  const perDay = burn.perDay === undefined ? "" : ` · about ${creditCount(burn.perDay)} a day`;
  return `${creditCount(burn.spent)} spent ${over}${perDay}`;
}

/** "500 added": the period's top-ups, when there were any. */
export const addedText = (burn: CreditBurn): string | undefined =>
  burn.added > 0 ? `${creditCount(burn.added)} added` : undefined;

/**
 * The days a period's axis names, as epoch ms of local midnights from `from` to `to`:
 * every day over a week, every seventh over a month, so labels never crowd.
 */
export function dayTicks(from: number, to: number, everyDays: number): number[] {
  const first = new Date(from);
  first.setHours(0, 0, 0, 0);
  if (first.getTime() < from) first.setDate(first.getDate() + 1);
  const ticks: number[] = [];
  for (const day = first; day.getTime() <= to; day.setDate(day.getDate() + everyDays))
    ticks.push(day.getTime());
  return ticks;
}

/** The point nearest `at` within `within` ms, for the chart's hover; none past that. */
export function nearestPoint<T extends { readonly at: number }>(
  points: readonly T[],
  at: number,
  within: number,
): T | undefined {
  let best: T | undefined;
  for (const point of points)
    if (best === undefined || Math.abs(point.at - at) < Math.abs(best.at - at)) best = point;
  return best !== undefined && Math.abs(best.at - at) <= within ? best : undefined;
}
