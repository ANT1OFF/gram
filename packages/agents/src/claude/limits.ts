import type { SubscriptionLimitReport } from "@gram/contracts";

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};

/** `get_usage` uses percentages and ISO resets; stream events use fractions and epoch seconds. */
export function claudeSubscriptionLimits(
  response: unknown,
): ReadonlyArray<SubscriptionLimitReport> {
  const raw = object(response);
  if (raw.rate_limits_available !== true) return [];
  const limits = object(raw.rate_limits);
  // Extra usage that can still cover sends: a full window goes on, billed, rather than stopping.
  const extra = object(limits.extra_usage);
  const credits =
    extra.is_enabled === true &&
    !(typeof extra.utilization === "number" && extra.utilization >= 100);
  return (["five_hour", "seven_day"] as const).flatMap((window) => {
    const value = object(limits[window]);
    const used = value.utilization;
    if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 100) return [];
    const resetsAt = typeof value.resets_at === "string" ? Date.parse(value.resets_at) : NaN;
    return [
      {
        status: "allowed" as const,
        window,
        utilization: used / 100,
        ...(Number.isFinite(resetsAt) && resetsAt > 0 ? { resetsAt } : {}),
        ...(credits && used >= 100 ? { credits: true as const } : {}),
      },
    ];
  });
}
