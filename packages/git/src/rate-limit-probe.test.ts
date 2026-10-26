import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { Proc, type ProcShape } from "./proc.ts";
import { fetchRateLimit, parseRateLimit, quotaHeadroom } from "./rate-limit-probe.ts";

const NOW_MS = 1_800_000_000_000;
const RESET = Math.round(NOW_MS / 1000) + 600;

const body = {
  resources: {
    core: { limit: 5000, used: 1000, remaining: 4000, reset: RESET },
    graphql: { limit: 5000, used: 4900, remaining: 100, reset: RESET },
    search: { limit: 30, used: 0, remaining: 30, reset: RESET },
    integration_manifest: { limit: 5000, used: 0, remaining: 5000, reset: RESET },
  },
  rate: { limit: 5000, used: 1000, remaining: 4000, reset: RESET },
};

const mockGh = (reply: { status: number; stdout: string; stderr?: string }) => {
  const calls: Array<ReadonlyArray<string>> = [];
  const proc: ProcShape = {
    run: (_bin, args) =>
      Effect.sync(() => {
        calls.push(args);
        return { stderr: "", truncated: false, ...reply };
      }),
  };
  return { calls, provide: Effect.provideService(Proc, proc) };
};

describe("parseRateLimit", () => {
  it("reads every window GitHub reports, with a relative reset", () => {
    expect(parseRateLimit(body, NOW_MS)).toEqual({
      core: { limit: 5000, used: 1000, remaining: 4000, resetAt: RESET, resetInSeconds: 600 },
      graphql: { limit: 5000, used: 4900, remaining: 100, resetAt: RESET, resetInSeconds: 600 },
      search: { limit: 30, used: 0, remaining: 30, resetAt: RESET, resetInSeconds: 600 },
      checkedAt: NOW_MS,
    });
  });

  it("clamps an overdue reset and infers `used` when it is absent", () => {
    const stale = { rate: { limit: 60, remaining: 12, reset: 1 } };
    expect(parseRateLimit(stale, NOW_MS)?.core).toEqual({
      limit: 60,
      used: 48,
      remaining: 12,
      resetAt: 1,
      resetInSeconds: 0,
    });
  });

  it("rejects a body that isn't a rate-limit answer", () => {
    expect(parseRateLimit("<html>", NOW_MS)).toBeUndefined();
    expect(parseRateLimit({ resources: {} }, NOW_MS)).toBeUndefined();
    expect(parseRateLimit({ resources: { core: { limit: 5000 } } }, NOW_MS)).toBeUndefined();
  });
});

describe("quotaHeadroom", () => {
  it("reports the tightest window's unspent share", () => {
    expect(quotaHeadroom(parseRateLimit(body, NOW_MS)!)).toBeCloseTo(0.02);
  });

  it("leaves the search window out: only the review-request poller spends it", () => {
    const spent = { limit: 30, used: 30, remaining: 0, resetAt: 0, resetInSeconds: 0 };
    const full = { limit: 5000, used: 0, remaining: 5000, resetAt: 0, resetInSeconds: 0 };
    expect(quotaHeadroom({ checkedAt: NOW_MS, core: full, graphql: full, search: spent })).toBe(1);
  });

  it("stays at full headroom when nothing usable was reported", () => {
    expect(quotaHeadroom({ checkedAt: NOW_MS })).toBe(1);
    expect(
      quotaHeadroom({
        checkedAt: NOW_MS,
        core: { limit: 0, used: 0, remaining: 0, resetAt: 0, resetInSeconds: 0 },
      }),
    ).toBe(1);
  });
});

describe("fetchRateLimit", () => {
  it.effect("queries the quota-exempt endpoint", () =>
    Effect.gen(function* () {
      const { calls, provide } = mockGh({ status: 0, stdout: JSON.stringify(body) });
      const quota = yield* provide(fetchRateLimit("/repo"));
      expect(calls[0]).toEqual(["api", "rate_limit"]);
      expect(quota.graphql?.remaining).toBe(100);
      expect(quota.checkedAt).toBe(yield* Clock.currentTimeMillis);
    }),
  );

  it.effect("fails rather than reporting an empty quota", () =>
    Effect.gen(function* () {
      const refused = mockGh({ status: 1, stdout: "", stderr: "gh auth login required" });
      expect(yield* refused.provide(fetchRateLimit("/repo")).pipe(Effect.flip)).toMatchObject({
        _tag: "RateLimitProbeError",
        message: "gh auth login required",
      });
      const garbage = mockGh({ status: 0, stdout: "not json" });
      expect((yield* garbage.provide(fetchRateLimit("/repo")).pipe(Effect.flip)).message).toContain(
        "no JSON",
      );
      const empty = mockGh({ status: 0, stdout: "{}" });
      expect((yield* empty.provide(fetchRateLimit("/repo")).pipe(Effect.flip)).message).toContain(
        "no windows",
      );
    }),
  );
});
