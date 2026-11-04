import { afterEach, describe, expect, it, vi } from "vitest";

import type { UsageLimits } from "@/stores/usage-limits";

import { retryTimeOf, useRetrySchedule } from "./retry-time";

const NOW = 1_000_000;
const limited = { kind: "rateLimit" } as const;
const claude = { agent: "claude" } as const;

const spent = (resetsAt: number) =>
  ({ utilization: 1, status: "rejected", resetsAt, expiresAt: resetsAt }) as const;

describe("retryTimeOf", () => {
  it("is the provider's reset of a spent window, the later when both are", () => {
    const limits: UsageLimits = {
      claude: { fiveHour: spent(NOW + 60_000), weekly: spent(NOW + 120_000) },
    };
    expect(retryTimeOf(limited, claude, limits, NOW)).toBe(NOW + 120_000);
  });

  it("is unknown when the provider gave none: no spent window, a gateway, another failure", () => {
    const busy: UsageLimits = {
      claude: {
        fiveHour: {
          utilization: 0.85,
          status: "allowed",
          resetsAt: NOW + 60_000,
          expiresAt: NOW + 60_000,
        },
      },
    };
    expect(retryTimeOf(limited, claude, busy, NOW)).toBeUndefined();
    const full: UsageLimits = { claude: { fiveHour: spent(NOW + 60_000) } };
    expect(
      retryTimeOf(limited, { agent: "claude", profileId: "p" as never }, full, NOW),
    ).toBeUndefined();
    expect(retryTimeOf({ kind: "network" }, claude, full, NOW)).toBeUndefined();
    expect(retryTimeOf(limited, { agent: "codex" }, full, NOW)).toBeUndefined();
    // A reset already past says nothing about when this one clears.
    expect(
      retryTimeOf(limited, claude, { claude: { fiveHour: spent(NOW - 1) } }, NOW),
    ).toBeUndefined();
  });
});

describe("useRetrySchedule", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs once the reset has passed, and not after a cancel", () => {
    vi.useFakeTimers({ now: NOW });
    const run = vi.fn();
    useRetrySchedule.getState().schedule("k", NOW + 60_000, run);
    expect(useRetrySchedule.getState().due["k"]).toBeGreaterThan(NOW + 60_000);
    vi.advanceTimersByTime(60_000);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(run).toHaveBeenCalledOnce();
    expect(useRetrySchedule.getState().due["k"]).toBeUndefined();

    const dropped = vi.fn();
    useRetrySchedule.getState().schedule("j", NOW + 200_000, dropped);
    useRetrySchedule.getState().cancel("j");
    vi.advanceTimersByTime(400_000);
    expect(dropped).not.toHaveBeenCalled();
  });
});
