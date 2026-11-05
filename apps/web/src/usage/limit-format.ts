import type { HeldBrief, LimitForecast } from "@gram/contracts";

import { agentLabel } from "@/agents/agent-label";
import { formatStamp } from "@/lib/time";
import {
  limitWindowOf,
  type LimitProvider,
  type LimitWindow,
  type TightestLimit,
  type UsageLimit,
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

/**
 * "Claude 42% used", or "Claude 100% used · credits" past a window the agent goes on from on
 * credits: "used", so the share never reads as what is left.
 */
export const meterText = ({ provider, limit }: TightestLimit): string =>
  `${PROVIDER_SHORT[provider]} ${limitPercent(limit.utilization)}% used${limit.credits === true ? " · credits" : ""}`;

/**
 * The meter's hover, saying what its number is: "Highest usage: Codex 5-hour limit, 85%". Its
 * popover has every provider's windows.
 */
export const meterHint = ({ provider, window, limit }: TightestLimit): string =>
  `Highest usage: ${agentLabel(provider)} ${windowWord(window)} limit, ${limitPercent(limit.utilization)}%`;

/** The line under a window spent but carried on credits: a full window here is no stop. */
export const CREDITS_TEXT = "Past the limit on credits; turns go on";

/** When a window resets, 24-hour: the time alone today, else the date before it (`formatStamp`). */
export const resetText = (at: number, now: number, intl: IntlOptions = {}): string =>
  formatStamp(at, now, intl);

/**
 * When a window resets, for a column headed "Resets at": `resetText`, whose date before the time
 * keeps a reset days off from being mistaken for today's.
 */
export const resetAtText = resetText;

/** "1,250": a credit balance as the agent gave it, its whole part grouped by thousands. */
const creditBalanceText = (balance: string): string =>
  balance.replace(/^\d+/, (whole) => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ","));

/**
 * "On credits · 1,250 left": the account's credits, when the agent reports having them (Codex's
 * `creditsAvailable` and balance); `undefined` when it said nothing of them. A window carried past
 * its limit on credits says so on its own line (`CREDITS_TEXT`).
 */
export const creditsText = (
  limit: Pick<UsageLimit, "creditsAvailable" | "creditsUnlimited" | "creditsBalance">,
): string | undefined => {
  if (limit.creditsUnlimited === true) return "On credits · unlimited";
  if (limit.creditsAvailable !== true && limit.creditsBalance === undefined) return undefined;
  return limit.creditsBalance === undefined
    ? "On credits"
    : `On credits · ${creditBalanceText(limit.creditsBalance)} left`;
};

/**
 * What the meter's name says to a screen reader: that its number is the highest usage of any
 * provider's window, and which one it is.
 */
export const meterLabel = (tightest: TightestLimit): string =>
  `Highest subscription usage: ${agentLabel(tightest.provider)} ${windowWord(
    tightest.window,
  )} limit ${limitPercent(tightest.limit.utilization)}% used${
    tightest.limit.credits === true ? ", continuing on credits" : ""
  }`;

const FORECAST_ROUND_MS = 5 * 60 * 1000;

/**
 * "Estimate at recent pace: 90% around 16:40": the forecast on a 24-hour clock (`formatStamp`, so
 * with its date when it isn't today), to the nearest five minutes, since a pace from an hour's
 * readings is no closer than that, and named an estimate so it never reads as certain.
 */
export const forecastText = (
  forecast: LimitForecast,
  now = Date.now(),
  intl: IntlOptions = {},
): string =>
  `Estimate at recent pace: ${Math.round(forecast.target * 100)}% around ${formatStamp(
    Math.round(forecast.at / FORECAST_ROUND_MS) * FORECAST_ROUND_MS,
    now,
    intl,
  )}`;

/** "until 18:00": when a held brief starts, on a 24-hour clock (`resetText`), for a narrow chip. */
const untilText = (until: number, now: number, intl: IntlOptions = {}): string =>
  `until ${resetText(until, now, intl)}`;

/** "Paused until 18:00": a held brief's line. */
export const heldUntilText = (until: number, now: number, intl: IntlOptions = {}): string =>
  `Paused ${untilText(until, now, intl)}`;

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
