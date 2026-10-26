import { describe, expect, it } from "vitest";
import { LOCAL_LIMIT_OBSERVATIONS_MAX } from "@gram/contracts";
import { makeLocalLimitCollector } from "./local-limit-history.ts";

const at = Date.parse("2026-10-16T12:00:00Z");
const event = (
  primary: unknown,
  secondary: unknown = null,
  limit_id: unknown = "codex",
  time = at,
) => ({
  type: "event_msg",
  timestamp: new Date(time).toISOString(),
  payload: { type: "token_count", rate_limits: { limit_id, primary, secondary } },
});
const window = (
  used_percent = 25,
  window_minutes = 300,
  resets_at: unknown = at / 1000 + 1000,
) => ({ used_percent, window_minutes, resets_at });
const consume = (collector: ReturnType<typeof makeLocalLimitCollector>, value: unknown) =>
  collector.consume(value, at - 1, at + 10_000);

describe("historical Codex quota observations", () => {
  it("normalizes both durations, accepts zero and missing resets, and deduplicates copied readings", () => {
    const collector = makeLocalLimitCollector();
    const value = event(window(0, 10_080, null), window(100, 300));
    consume(collector, value);
    consume(collector, value);
    const history = collector.snapshot();
    expect(history).toEqual({
      observations: [
        { provider: "codex", window: "five_hour", utilization: 1, at, resetsAt: at + 1_000_000 },
        { provider: "codex", window: "seven_day", utilization: 0, at },
      ],
      invalidReadings: 0,
      truncated: false,
    });
    collector.merge(history);
    expect(collector.snapshot()).toEqual(history);
  });
  it("rejects invalid fractions, unsafe reset times and unknown durations without inventing readings", () => {
    const collector = makeLocalLimitCollector();
    for (const primary of [
      window(-1),
      window(101),
      window(NaN),
      window(Infinity),
      window(25, 60),
      window(25, 300, -1),
      window(25, 300, 1.5),
      window(25, 300, Number.MAX_SAFE_INTEGER),
      window(25, 300, "123"),
      {},
    ])
      consume(collector, event(primary));
    consume(collector, { ...event(window()), timestamp: "invalid" });
    expect(collector.snapshot()).toEqual({
      observations: [],
      invalidReadings: 11,
      truncated: false,
    });
  });
  it("ignores other model buckets, unrelated events and observations outside the selected period", () => {
    const collector = makeLocalLimitCollector();
    consume(collector, event(window(), null, "codex_other"));
    consume(collector, event(window(), null, "codex", at - 2));
    consume(collector, event(window(), null, "codex", at + 10_000));
    consume(collector, { ...event(window()), type: "response_item" });
    expect(collector.snapshot()).toEqual({
      observations: [],
      invalidReadings: 0,
      truncated: false,
    });
    consume(collector, event(window(), null, null));
    expect(collector.snapshot().observations).toHaveLength(1);
    collector.window(at + 1, at + 100);
    expect(collector.snapshot().observations).toHaveLength(0);
  });
  it("counts failed optional projections only for in-period token-count candidates", () => {
    const collector = makeLocalLimitCollector();
    collector.invalidProjection({ ...event(window()), type: "response_item" }, at, at + 10);
    collector.invalidProjection(event(window(), null, "codex", at - 1), at, at + 10);
    collector.invalidProjection(event(window(), null, "codex", at + 10), at, at + 10);
    expect(collector.snapshot().invalidReadings).toBe(0);
    collector.invalidProjection(event(window()), at, at + 10);
    expect(collector.snapshot().invalidReadings).toBe(1);
  });
  it("keeps the newest bounded samples regardless of file order and propagates truncation", () => {
    const collector = makeLocalLimitCollector();
    for (let i = LOCAL_LIMIT_OBSERVATIONS_MAX + 5; i >= 0; i--)
      consume(collector, event(window(), window(75, 10_080), "codex", at + i));
    const history = collector.snapshot();
    expect(history.truncated).toBe(true);
    expect(history.observations).toHaveLength(LOCAL_LIMIT_OBSERVATIONS_MAX * 2);
    expect(history.observations[0]?.at).toBe(at + 6);
    const combined = makeLocalLimitCollector();
    combined.merge(history);
    combined.merge(history);
    expect(combined.snapshot()).toEqual(history);
    expect(combined.retainedBytes()).toBeLessThan(40_000);
  });
});
