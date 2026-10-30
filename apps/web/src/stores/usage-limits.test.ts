import type { AgentKind, LimitRecord, ServerEvent, ThreadId } from "@gram/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  currentLimit,
  limitsOf,
  limitStale,
  LIMIT_STALE_MS,
  limitWarns,
  nextLimitChange,
  limitWindowOf,
  nextExpiry,
  NO_RESET_TTL_MS,
  tightestLimit,
  useUsageLimits,
  withReading,
  type UsageLimit,
  type UsageLimits,
} from "./usage-limits";

type Reading = Extract<ServerEvent, { type: "usageLimit" }>;

const UNKNOWN_AGENT = "unknown-agent" as string as AgentKind;

const NOW = Date.parse("2026-10-15T12:00:00Z");
const HOUR = 3_600_000;

const reading = (overrides: Partial<Reading> = {}): Reading => ({
  type: "usageLimit",
  threadId: "t-1" as ThreadId,
  agent: "claude",
  status: "allowed",
  window: "five_hour",
  utilization: 0.42,
  resetsAt: NOW + 2 * HOUR,
  ...overrides,
});

beforeEach(() => vi.useFakeTimers({ now: NOW }));

/** A current reading at `utilization`. */
const limitAt = (utilization: number, status: UsageLimit["status"]): UsageLimit => ({
  utilization,
  status,
  expiresAt: NOW + HOUR,
});

afterEach(() => {
  vi.useRealTimers();
  useUsageLimits.setState({ limits: {} });
});

describe("usage limit readings", () => {
  it("names the 5-hour and weekly windows, and no others", () => {
    expect(limitWindowOf("five_hour")).toBe("fiveHour");
    expect(limitWindowOf("seven_day")).toBe("weekly");
    expect(limitWindowOf("seven_day_opus")).toBeUndefined();
    expect(limitWindowOf("overage")).toBeUndefined();
    expect(limitWindowOf("usage")).toBeUndefined();
  });

  it("keeps the latest reading per provider and window", () => {
    const { record } = useUsageLimits.getState();
    record(reading());
    record(reading({ window: "seven_day", utilization: 0.61, resetsAt: NOW + 72 * HOUR }));
    record(reading({ agent: "codex", utilization: 0.85, status: "warning" }));
    vi.advanceTimersByTime(60_000);
    record(reading({ utilization: 0.5 }));
    expect(useUsageLimits.getState().limits).toEqual({
      claude: {
        fiveHour: {
          utilization: 0.5,
          status: "allowed",
          resetsAt: NOW + 2 * HOUR,
          expiresAt: NOW + 2 * HOUR,
          at: NOW + 60_000,
          samples: [
            { at: NOW, utilization: 0.42 },
            { at: NOW + 60_000, utilization: 0.5 },
          ],
        },
        weekly: {
          utilization: 0.61,
          status: "allowed",
          resetsAt: NOW + 72 * HOUR,
          expiresAt: NOW + 72 * HOUR,
          at: NOW,
          samples: [{ at: NOW, utilization: 0.61 }],
        },
      },
      codex: {
        fiveHour: {
          utilization: 0.85,
          status: "warning",
          resetsAt: NOW + 2 * HOUR,
          expiresAt: NOW + 2 * HOUR,
          at: NOW,
          samples: [{ at: NOW, utilization: 0.85 }],
        },
      },
    });
  });

  it("ignores gateways, other agents, other windows, and a share it can't place", () => {
    const empty: UsageLimits = {};
    expect(withReading(empty, reading({ gateway: true }), NOW)).toBe(empty);
    expect(withReading(empty, reading({ agent: UNKNOWN_AGENT }), NOW)).toBe(empty);
    expect(withReading(empty, reading({ window: "overage" }), NOW)).toBe(empty);
    const { utilization: _none, ...unmeasured } = reading({ status: "warning" });
    expect(withReading(empty, unmeasured, NOW)).toBe(empty);
  });

  it("reads a rejection without a share as the whole window, and clamps the rest", () => {
    const { utilization: _none, ...rejected } = reading({ status: "rejected" });
    expect(withReading({}, rejected, NOW).claude?.fiveHour?.utilization).toBe(1);
    expect(withReading({}, reading({ utilization: 1.4 }), NOW).claude?.fiveHour?.utilization).toBe(
      1,
    );
    expect(withReading({}, reading({ utilization: -1 }), NOW).claude?.fiveHour?.utilization).toBe(
      0,
    );
  });

  it("ignores a reading that arrives with its reset already passed, or passing now", () => {
    const current = withReading({}, reading({ utilization: 0.3 }), NOW);
    expect(withReading(current, reading({ utilization: 0.9, resetsAt: NOW - 1 }), NOW)).toBe(
      current,
    );
    expect(withReading(current, reading({ utilization: 0.9, resetsAt: NOW }), NOW)).toBe(current);
    expect(withReading({}, reading({ resetsAt: NOW - HOUR }), NOW)).toEqual({});
  });

  it("lets a rejection with no reset lapse, or clears it at the next reading", () => {
    const { resetsAt: _none, utilization: _share, ...rejected } = reading({ status: "rejected" });
    const pinned = withReading({}, rejected, NOW);
    expect(tightestLimit(pinned, NOW)?.limit.utilization).toBe(1);
    expect(tightestLimit(pinned, NOW + NO_RESET_TTL_MS - 1)?.limit.status).toBe("rejected");
    expect(tightestLimit(pinned, NOW + NO_RESET_TTL_MS)).toBeUndefined();
    expect(nextExpiry(pinned, NOW)).toBe(NOW + NO_RESET_TTL_MS);
    const cleared = withReading(pinned, reading({ utilization: 0.2 }), NOW + 60_000);
    expect(tightestLimit(cleared, NOW + 60_000)?.limit).toMatchObject({
      utilization: 0.2,
      status: "allowed",
    });
  });

  it("moves a reset-less reading's expiry on when it is read again", () => {
    const { resetsAt: _none, ...noReset } = reading({ window: "seven_day", utilization: 0.3 });
    const first = withReading({}, noReset, NOW);
    const again = withReading(first, noReset, NOW + HOUR / 2);
    expect(again).not.toBe(first);
    expect(again.claude?.weekly?.expiresAt).toBe(NOW + HOUR / 2 + NO_RESET_TTL_MS);
  });

  it("leaves the state alone when a reading repeats", () => {
    const { record } = useUsageLimits.getState();
    record(reading());
    const before = useUsageLimits.getState();
    record(reading({ threadId: "t-2" as ThreadId }));
    expect(useUsageLimits.getState()).toBe(before);
  });
});

describe("the tightest limit", () => {
  const limits = [
    reading(),
    reading({ window: "seven_day", utilization: 0.61, resetsAt: NOW + 72 * HOUR }),
    reading({ agent: "codex", utilization: 0.12, resetsAt: NOW + HOUR }),
    reading({ agent: "codex", window: "seven_day", utilization: 0.3, resetsAt: NOW + 120 * HOUR }),
  ].reduce<UsageLimits>((all, r) => withReading(all, r, NOW), {});

  it("is the one closest to its limit", () => {
    expect(tightestLimit(limits, NOW)).toMatchObject({
      provider: "claude",
      window: "weekly",
      limit: { utilization: 0.61 },
    });
  });

  it("drops a reading once its window has reset, at the reset itself too", () => {
    const later = NOW + 73 * HOUR;
    expect(currentLimit(limits.claude?.weekly, NOW + 72 * HOUR - 1)).toBeDefined();
    expect(currentLimit(limits.claude?.weekly, NOW + 72 * HOUR)).toBeUndefined();
    expect(currentLimit(limits.claude?.weekly, later)).toBeUndefined();
    expect(tightestLimit(limits, later)).toMatchObject({ provider: "codex", window: "weekly" });
    expect(tightestLimit({}, NOW)).toBeUndefined();
  });

  it("on a tie, is the one that resets first", () => {
    const tied = [
      reading({ utilization: 0.5, resetsAt: NOW + 3 * HOUR }),
      reading({ agent: "codex", utilization: 0.5, resetsAt: NOW + HOUR }),
    ].reduce<UsageLimits>((all, r) => withReading(all, r, NOW), {});
    expect(tightestLimit(tied, NOW)?.provider).toBe("codex");
  });

  it("knows when the meter has to look again", () => {
    expect(nextExpiry(limits, NOW)).toBe(NOW + HOUR);
    expect(nextExpiry(limits, NOW + HOUR)).toBe(NOW + 2 * HOUR);
    expect(nextExpiry({}, NOW)).toBeUndefined();
  });

  it("warns from 80% and at a rejection", () => {
    expect(limitWarns(limitAt(0.79, "allowed"))).toBe(false);
    expect(limitWarns(limitAt(0.8, "allowed"))).toBe(true);
    expect(limitWarns(limitAt(0.4, "rejected"))).toBe(true);
  });
});

/** A reading as the server kept it, read 40 minutes ago. */
const kept = (overrides: Partial<LimitRecord> = {}): LimitRecord => ({
  agent: "claude",
  window: "five_hour",
  status: "allowed",
  utilization: 0.42,
  resetsAt: NOW + 2 * HOUR,
  at: NOW - 40 * 60_000,
  samples: [{ at: NOW - 40 * 60_000, utilization: 0.42 }],
  ...overrides,
});

describe("the server's kept readings", () => {
  it("replace what the client had, keeping only the subscription's current windows", () => {
    useUsageLimits.getState().record(reading({ agent: "codex", utilization: 0.9 }));
    useUsageLimits
      .getState()
      .replace([
        kept(),
        kept({ profileId: "gateway" }),
        kept({ window: "overage" }),
        kept({ window: "seven_day", resetsAt: NOW - 1 }),
        kept({ agent: UNKNOWN_AGENT }),
      ]);
    const { limits } = useUsageLimits.getState();
    expect(limits).toEqual({
      claude: {
        fiveHour: {
          utilization: 0.42,
          status: "allowed",
          resetsAt: NOW + 2 * HOUR,
          expiresAt: NOW + 2 * HOUR,
          at: NOW - 40 * 60_000,
          samples: [{ at: NOW - 40 * 60_000, utilization: 0.42 }],
        },
      },
    });
  });

  it("show their age once no agent has repeated them for a while", () => {
    const limits = limitsOf([kept({ at: NOW - LIMIT_STALE_MS + 1 })], NOW);
    const limit = limits.claude!.fiveHour!;
    expect(limitStale(limit, NOW)).toBe(false);
    expect(nextLimitChange(limits, NOW)).toBe(NOW + 1);
    expect(limitStale(limit, NOW + 1)).toBe(true);
    // A fresh report makes it current again and adds to the same window's samples.
    const after = withReading(limits, reading({ utilization: 0.45 }), NOW + 1);
    expect(limitStale(after.claude!.fiveHour!, NOW + 1)).toBe(false);
    expect(after.claude!.fiveHour!.samples).toHaveLength(2);
  });
});
