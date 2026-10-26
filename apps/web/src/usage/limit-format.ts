import type { HeldBrief, LimitForecast } from "@gram/contracts";

import { agentLabel } from "@/agents/agent-label";
import { dateTimeFormat } from "@/lib/intl";
import { CLOCK_TIME, formatClockTime } from "@/lib/time";
import {
  limitWindowOf,
  type LimitProvider,
  type LimitWindow,
  type TightestLimit,
} from "@/stores/usage-limits";

type IntlOptions = { readonly locale?: string; readonly timeZone?: string };

/** The meter's own word for each, where "Claude Code 42%" would crowd the title bar. */
export const PROVIDER_SHORT: Readonly<Record<LimitProvider, string>> = {
  claude: "Claude",
  codex: "Codex",
};

/** An agent's short word (`PROVIDER_SHORT`); one the meter doesn't know by its full name. */
const shortName = (agent: string): string =>
  Object.hasOwn(PROVIDER_SHORT, agent) ? PROVIDER_SHORT[agent as LimitProvider] : agentLabel(agent);

/** Each window's one name, as a heading; `windowWord` is the same name mid-sentence. */
export const WINDOW_LABEL: Readonly<Record<LimitWindow, string>> = {
  fiveHour: "5-hour",
  weekly: "Weekly",
};

/**
 * A window's name mid-sentence ("5-hour", "weekly"), from the meter's name for it or the agent's
 * own: `seven_day` is "weekly" here as everywhere, never "7-day", and a per-model week
 * (`seven_day_opus`) is "weekly opus". One the meter doesn't know (`overage`) is itself, its
 * underscores as spaces.
 */
export const windowWord = (window: string): string => {
  if (Object.hasOwn(WINDOW_LABEL, window)) return WINDOW_LABEL[window as LimitWindow].toLowerCase();
  const [base = ""] = /^(five_hour|seven_day)/.exec(window) ?? [];
  const known = limitWindowOf(base);
  const named = known === undefined ? window : `${windowWord(known)}${window.slice(base.length)}`;
  return named.replaceAll("_", " ");
};

/** A share from 0 to 1 as a whole percent; 100% only once it is all used. */
export const limitPercent = (utilization: number): number =>
  utilization >= 1 ? 100 : Math.min(99, Math.round(utilization * 100));

/** "Claude 42%", or "Claude 100% · credits" past a window the agent goes on from on credits. */
export const meterText = ({ provider, limit }: TightestLimit): string =>
  `${PROVIDER_SHORT[provider]} ${limitPercent(limit.utilization)}%${limit.credits === true ? " · credits" : ""}`;

/** "Claude 42% of the weekly limit": the tightest limit in a line, for a hint or a summary. */
export const limitSummaryText = ({ provider, window, limit }: TightestLimit): string =>
  `${PROVIDER_SHORT[provider]} ${limitPercent(limit.utilization)}% of the ${windowWord(window)} limit`;

/** The line under a window spent but carried on credits: a full window here is no stop. */
export const CREDITS_TEXT = "Past the limit on credits; turns go on";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When a window resets, on a 24-hour clock: the time alone today, the weekday and time within the
 * week ahead, and the date and time beyond it.
 */
export function resetText(at: number, now: number, intl: IntlOptions = {}): string {
  const zone = intl.timeZone === undefined ? {} : { timeZone: intl.timeZone };
  const format = (options: Intl.DateTimeFormatOptions, value = at) =>
    dateTimeFormat(intl.locale, { ...options, ...zone }).format(value);
  const day = { year: "numeric", month: "numeric", day: "numeric" } as const;
  const time = formatClockTime(at, intl);
  if (format(day) === format(day, now)) return time;
  if (at - now < 6 * DAY_MS) return `${format({ weekday: "short" })} ${time}`;
  return format({ day: "numeric", month: "short", ...CLOCK_TIME });
}

/** What the meter's name says to a screen reader: the tightest limit and its window. */
export const meterLabel = (tightest: TightestLimit): string =>
  `Subscription usage: ${agentLabel(tightest.provider)} ${windowWord(
    tightest.window,
  )} limit ${limitPercent(tightest.limit.utilization)}% used${
    tightest.limit.credits === true ? ", continuing on credits" : ""
  }`;

const FORECAST_ROUND_MS = 5 * 60 * 1000;

/**
 * "At this pace you reach 90% around 16:40": the forecast on a 24-hour clock, to the nearest five
 * minutes, since a pace from an hour's readings is no closer than that.
 */
export const forecastText = (forecast: LimitForecast, intl: IntlOptions = {}): string =>
  `At this pace you reach ${Math.round(forecast.target * 100)}% around ${formatClockTime(
    Math.round(forecast.at / FORECAST_ROUND_MS) * FORECAST_ROUND_MS,
    intl,
  )}`;

/** "until 18:00": when a held brief starts, on a 24-hour clock (`resetText`), for a narrow chip. */
const untilText = (until: number, now: number, intl: IntlOptions = {}): string =>
  `until ${resetText(until, now, intl)}`;

/** "Held until 18:00": a held brief's line. */
export const heldUntilText = (until: number, now: number, intl: IntlOptions = {}): string =>
  `Held ${untilText(until, now, intl)}`;

type HeldWhen = Pick<HeldBrief, "until" | "waitsForSlot" | "retryAt">;

/**
 * Where a held brief stands, long ("Held until 18:00") or for a chip ("until 18:00"): waiting for
 * its limit's reset, for a free worker slot once it has reset, or for a retry after the spawn was
 * refused for now.
 */
export const heldStateText = (
  held: HeldWhen,
  now: number,
  { short = false, ...intl }: IntlOptions & { readonly short?: boolean } = {},
): string => {
  if (held.waitsForSlot === true)
    return short ? "waits for a slot" : "Waits for a free worker slot";
  if (held.retryAt !== undefined) {
    return `${short ? "retry" : "Tried again"} at ${resetText(held.retryAt, now, intl)}`;
  }
  return short ? untilText(held.until, now, intl) : heldUntilText(held.until, now, intl);
};

/**
 * "Codex is at 85% of its 5-hour limit": why a low-priority brief is held, and what the pause card
 * asks about. `window` is the meter's name or the agent's (`windowWord`).
 */
export const limitShareText = ({
  agent,
  usedPct,
  window,
  reason,
}: {
  readonly agent: string;
  readonly usedPct: number;
  readonly window: string;
  /** Why it is held when a limit isn't the reason, which then stands alone. */
  readonly reason?: string | undefined;
}): string => reason ?? `${shortName(agent)} is at ${usedPct}% of its ${windowWord(window)} limit`;
