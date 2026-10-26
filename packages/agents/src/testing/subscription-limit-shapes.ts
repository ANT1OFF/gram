/** CLI-owned read-only queries captured 17 October 2026. Only quota fields retained. */
export const claudeUsage = {
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 44, resets_at: "2026-10-17T13:39:59.684580+00:00" },
    seven_day: { utilization: 96, resets_at: "2026-10-17T19:59:59.684608+00:00" },
  },
};
export const codexUsage = {
  rateLimits: {
    limitId: "codex",
    primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1792244732 },
    secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1792711900 },
    rateLimitReachedType: "rate_limit_reached",
  },
};

/** Same Claude account after the session window turned over, captured at 13:41 UTC. */
export const claudeAfterReset = {
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 0, resets_at: null },
    seven_day: { utilization: 96, resets_at: "2026-10-17T20:00:00.504735+00:00" },
  },
};
