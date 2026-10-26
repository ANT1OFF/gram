import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import {
  activityMultiplier,
  HIDDEN_MULTIPLIER,
  IDLE_MULTIPLIER,
  makePollBackoff,
  offScreenWatchSweeps,
  QUOTA_CRITICAL_MULTIPLIER,
  QUOTA_LOW_MULTIPLIER,
  quotaMultiplier,
} from "./poll-backoff.ts";

describe("quotaMultiplier", () => {
  it("leaves a healthy quota alone and cuts a thin one hard", () => {
    expect(quotaMultiplier(1)).toBe(1);
    expect(quotaMultiplier(0.5)).toBe(1);
    expect(quotaMultiplier(0.2)).toBe(QUOTA_LOW_MULTIPLIER);
    expect(quotaMultiplier(0.05)).toBe(QUOTA_CRITICAL_MULTIPLIER);
    expect(quotaMultiplier(0)).toBe(QUOTA_CRITICAL_MULTIPLIER);
  });
});

describe("activityMultiplier", () => {
  it("stretches the cadence for a background app, and further once no window is showing", () => {
    expect(activityMultiplier("active")).toBe(1);
    expect(activityMultiplier("idle")).toBe(IDLE_MULTIPLIER);
    expect(activityMultiplier("hidden")).toBe(HIDDEN_MULTIPLIER);
    expect(HIDDEN_MULTIPLIER).toBeGreaterThan(IDLE_MULTIPLIER);
  });
});

describe("offScreenWatchSweeps", () => {
  it("adds up to the hidden cadence whatever pace the sweep itself runs at", () => {
    for (const level of ["active", "idle", "hidden"] as const) {
      expect(offScreenWatchSweeps(level) * activityMultiplier(level)).toBe(HIDDEN_MULTIPLIER);
    }
  });
});

describe("makePollBackoff", () => {
  it.effect("ramps while refused and drops back to the base cadence on a clean pass", () =>
    Effect.gen(function* () {
      const base = Duration.seconds(15);
      const backoff = yield* makePollBackoff("test", base, { jitter: () => 0.5 });
      expect(yield* backoff.consecutive).toBe(0);
      expect(yield* backoff.recovered(1)).toStrictEqual(base);

      const first = yield* backoff.limited({ kind: "primary" });
      const second = yield* backoff.limited({ kind: "primary" });
      expect(Duration.toMillis(first)).toBe(60_000);
      expect(Duration.toMillis(second)).toBe(120_000);
      expect(yield* backoff.consecutive).toBe(2);

      expect(yield* backoff.recovered(1)).toStrictEqual(base);
      expect(yield* backoff.consecutive).toBe(0);
    }),
  );

  it.effect("honours Retry-After, and starts a rung higher on a secondary limit", () =>
    Effect.gen(function* () {
      const backoff = yield* makePollBackoff("test", Duration.seconds(15), { jitter: () => 0.5 });
      expect(
        Duration.toMillis(yield* backoff.limited({ kind: "primary", retryAfterSeconds: 90 })),
      ).toBe(90_000);
      yield* backoff.recovered(1);
      expect(Duration.toMillis(yield* backoff.limited({ kind: "secondary" }))).toBe(120_000);
    }),
  );

  it.effect("never backs off to less than the base cadence", () =>
    Effect.gen(function* () {
      const backoff = yield* makePollBackoff("test", Duration.minutes(5), { jitter: () => 0.5 });
      expect(Duration.toMillis(yield* backoff.limited({ kind: "primary" }))).toBe(300_000);
      expect(
        Duration.toMillis(yield* backoff.limited({ kind: "primary", retryAfterSeconds: 10 })),
      ).toBe(300_000);
    }),
  );

  it.effect("stretches the clean cadence by the caller's multiplier", () =>
    Effect.gen(function* () {
      const backoff = yield* makePollBackoff("test", Duration.seconds(15));
      expect(Duration.toMillis(yield* backoff.recovered(IDLE_MULTIPLIER))).toBe(60_000);
      expect(Duration.toMillis(yield* backoff.recovered(0))).toBe(15_000);
    }),
  );
});
