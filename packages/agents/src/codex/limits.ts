import type { AgentEvent, SubscriptionLimitReport } from "@gram/contracts";

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};

/** Positions aren't durations; model-specific buckets aren't the subscription allowance. */
function codexLimitSnapshot(snapshot: unknown): ReadonlyArray<SubscriptionLimitReport> {
  const raw = object(snapshot);
  if (raw.limitId != null && raw.limitId !== "codex") return [];
  // Credits left (or unlimited): Codex goes on past a full window, billed, rather than stopping.
  const balance = object(raw.credits);
  const credits = balance.hasCredits === true || balance.unlimited === true;
  return [raw.primary, raw.secondary].flatMap((lane) => {
    const value = object(lane);
    const window =
      value.windowDurationMins === 300
        ? ("five_hour" as const)
        : value.windowDurationMins === 10080
          ? ("seven_day" as const)
          : undefined;
    const used = value.usedPercent;
    if (
      window === undefined ||
      typeof used !== "number" ||
      !Number.isFinite(used) ||
      used < 0 ||
      used > 100
    )
      return [];
    const reset = value.resetsAt;
    return [
      {
        status:
          raw.rateLimitReachedType != null && used >= 100 && !credits
            ? ("rejected" as const)
            : ("allowed" as const),
        window,
        utilization: used / 100,
        ...(typeof reset === "number" &&
        Number.isSafeInteger(reset) &&
        reset > 0 &&
        Number.isSafeInteger(reset * 1000)
          ? { resetsAt: reset * 1000 }
          : {}),
        ...(credits && used >= 100 ? { credits: true as const } : {}),
      },
    ];
  });
}

/** Prefer the authoritative account bucket when the app-server offers multiple buckets. */
export function codexSubscriptionLimits(response: unknown): ReadonlyArray<SubscriptionLimitReport> {
  const raw = object(response);
  return codexLimitSnapshot(object(raw.rateLimitsByLimitId).codex ?? raw.rateLimits);
}

export const codexRateLimits = (snapshot: unknown): Array<AgentEvent> =>
  codexLimitSnapshot(snapshot).map((report) => ({ type: "rateLimit", ...report }));
