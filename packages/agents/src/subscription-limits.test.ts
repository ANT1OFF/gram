import { describe, expect, it } from "vitest";
import { claudeSubscriptionLimits } from "./claude/limits.ts";
import { codexSubscriptionLimits } from "./codex/limits.ts";
import { claudeAfterReset, claudeUsage, codexUsage } from "./testing/subscription-limit-shapes.ts";

describe("live CLI subscription response shapes", () => {
  it("reads both Claude windows with percent units and ISO resets", () => {
    expect(claudeSubscriptionLimits(claudeUsage)).toEqual([
      {
        status: "allowed",
        window: "five_hour",
        utilization: 0.44,
        resetsAt: Date.parse("2026-10-17T13:39:59.684580+00:00"),
      },
      {
        status: "allowed",
        window: "seven_day",
        utilization: 0.96,
        resetsAt: Date.parse("2026-10-17T19:59:59.684608+00:00"),
      },
    ]);
  });
  it("reads Claude's observed session turnover without inventing another reset", () => {
    expect(claudeSubscriptionLimits(claudeAfterReset)).toEqual([
      { status: "allowed", window: "five_hour", utilization: 0 },
      {
        status: "allowed",
        window: "seven_day",
        utilization: 0.96,
        resetsAt: Date.parse("2026-10-17T20:00:00.504735+00:00"),
      },
    ]);
  });
  it("reads Codex's account bucket, both durations and epoch-second resets", () => {
    expect(codexSubscriptionLimits(codexUsage)).toEqual([
      { status: "allowed", window: "five_hour", utilization: 0, resetsAt: 1792244732000 },
      { status: "rejected", window: "seven_day", utilization: 1, resetsAt: 1792711900000 },
    ]);
  });
  it("marks a full window that credits carry on past, never as a refusal", () => {
    // Synthetic: the same Codex bucket with credits left, as `CreditsSnapshot` reports them.
    const withCredits = {
      rateLimits: {
        ...codexUsage.rateLimits,
        credits: { hasCredits: true, unlimited: false, balance: "12.50" },
      },
    };
    expect(codexSubscriptionLimits(withCredits)).toEqual([
      { status: "allowed", window: "five_hour", utilization: 0, resetsAt: 1792244732000 },
      {
        status: "allowed",
        window: "seven_day",
        utilization: 1,
        resetsAt: 1792711900000,
        credits: true,
      },
    ]);
    // Synthetic: Claude's weekly window spent, extra usage enabled and not used up.
    const extra = {
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 30, resets_at: null },
        seven_day: { utilization: 100, resets_at: null },
        extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 120, utilization: 2 },
      },
    };
    expect(claudeSubscriptionLimits(extra)).toEqual([
      { status: "allowed", window: "five_hour", utilization: 0.3 },
      { status: "allowed", window: "seven_day", utilization: 1, credits: true },
    ]);
    // Extra usage turned off, or spent: a full window is a full window.
    for (const off of [
      { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
      { is_enabled: true, monthly_limit: 5000, used_credits: 5000, utilization: 100 },
    ]) {
      expect(
        claudeSubscriptionLimits({
          ...extra,
          rate_limits: { ...extra.rate_limits, extra_usage: off },
        })[1],
      ).toEqual({ status: "allowed", window: "seven_day", utilization: 1 });
    }
  });
  it("leaves missing, nonfinite or unavailable windows unknown", () => {
    expect(claudeSubscriptionLimits({ rate_limits_available: false, rate_limits: null })).toEqual(
      [],
    );
    expect(
      claudeSubscriptionLimits({
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: null, resets_at: null },
          seven_day: { utilization: 32, resets_at: null },
        },
      }),
    ).toEqual([{ status: "allowed", window: "seven_day", utilization: 0.32 }]);
    expect(
      claudeSubscriptionLimits({
        rate_limits_available: true,
        rate_limits: { five_hour: { utilization: NaN }, seven_day: { utilization: Infinity } },
      }),
    ).toEqual([]);
    expect(codexSubscriptionLimits({ rateLimits: { primary: null, secondary: null } })).toEqual([]);
    expect(
      codexSubscriptionLimits({
        rateLimits: { primary: { usedPercent: NaN, windowDurationMins: 300 } },
      }),
    ).toEqual([]);
  });
  it("uses durations rather than positions and ignores model buckets", () => {
    expect(
      codexSubscriptionLimits({
        rateLimits: { limitId: "model-only", primary: codexUsage.rateLimits.primary },
        rateLimitsByLimitId: { codex: codexUsage.rateLimits },
      }),
    ).toHaveLength(2);
    expect(
      codexSubscriptionLimits({
        rateLimits: { limitId: "model-only", primary: codexUsage.rateLimits.primary },
      }),
    ).toEqual([]);
    expect(
      codexSubscriptionLimits({
        rateLimits: {
          primary: codexUsage.rateLimits.secondary,
          secondary: codexUsage.rateLimits.primary,
        },
      }).map((x) => x.window),
    ).toEqual(["seven_day", "five_hour"]);
  });
});
