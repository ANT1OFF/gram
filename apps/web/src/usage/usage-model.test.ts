import type { UsageOverviewRow, UsageTotals } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import {
  cacheShare,
  compactTokens,
  dayLabel,
  FAMILY_COLOR,
  familiesIn,
  familiesOf,
  familyOf,
  limitHistory,
  niceCeiling,
  PROVIDER_COLOR,
  usageDays,
} from "./usage-model";

const totals = (over: Partial<UsageTotals> = {}): UsageTotals => ({
  totalTokens: 0,
  uncachedInputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  unclassifiedInputTokens: 0,
  outputTokens: 0,
  ...over,
});
const row = (over: Partial<UsageOverviewRow>): UsageOverviewRow => ({
  day: "2026-10-12",
  provider: "claude",
  model: null,
  turns: 1,
  missingCacheRead: false,
  missingCacheWrite: false,
  totals: totals(),
  ...over,
});

describe("usage model", () => {
  it("colours each provider by its brand, Claude's models as shades of its orange", () => {
    expect(PROVIDER_COLOR).toEqual({
      claude: "var(--provider-anthropic)",
      codex: "var(--provider-openai)",
    });
    for (const family of ["opus", "sonnet", "haiku", "other"] as const)
      expect(FAMILY_COLOR[family]).toContain("var(--provider-anthropic)");
    expect(FAMILY_COLOR.opus).toBe(PROVIDER_COLOR.claude);
    expect(FAMILY_COLOR.codex).toBe(PROVIDER_COLOR.codex);
  });

  it("colours by family, never by rank", () => {
    expect(familyOf("claude", "claude-opus-5-5")).toBe("opus");
    expect(familyOf("claude", "Claude-Sonnet-5")).toBe("sonnet");
    expect(familyOf("claude", "claude-haiku-5-5")).toBe("haiku");
    expect(familyOf("claude", "claude-example-new")).toBe("other");
    expect(familyOf("claude", null)).toBe("other");
    expect(familyOf("codex", null)).toBe("codex");
    expect(familyOf("codex", "gpt-opus-named")).toBe("codex");
    expect(
      familiesOf([
        { provider: "claude", model: "claude-opus-5-5", totalTokens: 10 },
        { provider: "claude", model: "claude-opus-4", totalTokens: 5 },
        { provider: "codex", model: null, totalTokens: 7 },
      ]),
    ).toEqual({ opus: 15, sonnet: 0, haiku: 0, codex: 7, other: 0 });
  });

  it("lays out every UTC day of the period, summing rows by family and cache", () => {
    const from = Date.parse("2026-10-10T12:00:00Z");
    const to = Date.parse("2026-10-12T12:00:00Z");
    const days = usageDays({
      from,
      to,
      rows: [
        row({
          day: "2026-10-12",
          model: "claude-opus-5-5",
          totals: totals({
            totalTokens: 100,
            uncachedInputTokens: 10,
            cacheReadTokens: 60,
            cacheWriteTokens: 10,
            outputTokens: 20,
          }),
        }),
        row({
          day: "2026-10-12",
          provider: "codex",
          totals: totals({
            totalTokens: 50,
            uncachedInputTokens: 10,
            cacheReadTokens: 30,
            outputTokens: 10,
          }),
        }),
        row({ day: "2026-09-01", totals: totals({ totalTokens: 999 }) }),
      ],
    });
    expect(days.map((d) => d.day)).toEqual(["2026-10-10", "2026-10-11", "2026-10-12"]);
    expect(days[1]).toMatchObject({ total: 0, input: 0 });
    expect(days[2]).toMatchObject({
      total: 150,
      cacheRead: 90,
      input: 120,
      families: { opus: 100, codex: 50 },
    });
    expect(familiesIn(days)).toEqual(["opus", "codex"]);
  });

  it("reads cache share of input, with none for no input", () => {
    expect(cacheShare(totals())).toBeUndefined();
    expect(
      cacheShare(
        totals({
          uncachedInputTokens: 20,
          cacheReadTokens: 70,
          cacheWriteTokens: 5,
          unclassifiedInputTokens: 5,
        }),
      ),
    ).toBe(0.7);
  });

  it("rounds an axis top up to a round number with a round half", () => {
    expect(niceCeiling(0)).toBe(1);
    expect(niceCeiling(3_390_000)).toBe(4_000_000);
    expect(niceCeiling(2_000_000)).toBe(2_000_000);
    expect(niceCeiling(2_000_001)).toBe(3_000_000);
    expect(niceCeiling(1_100_000)).toBe(1_200_000);
    expect(niceCeiling(7)).toBe(8);
  });

  it("writes tokens and days compactly", () => {
    expect(compactTokens(57_012_334)).toBe("57M");
    expect(compactTokens(3_650_000)).toBe("3.7M");
    expect(compactTokens(940)).toBe("940");
    expect(dayLabel("2026-10-16")).toBe("16 Oct");
    expect(dayLabel("2026-10-16", { weekday: true })).toBe("Fri 16 Oct");
  });

  it("keeps one window's limit history in its span, oldest first", () => {
    const now = Date.parse("2026-10-16T12:00:00Z");
    const at = (h: number) => now - h * 3_600_000;
    const picked = limitHistory(
      [
        { provider: "codex", window: "five_hour", at: at(1), utilization: 0.5 },
        { provider: "codex", window: "five_hour", at: at(3), utilization: 0.2 },
        { provider: "codex", window: "five_hour", at: at(30), utilization: 0.9 },
        { provider: "codex", window: "seven_day", at: at(2), utilization: 0.1 },
        { provider: "claude", window: "five_hour", at: at(2), utilization: 0.1 },
      ],
      "codex",
      "five_hour",
      now,
      24 * 3_600_000,
    );
    expect(picked.map((o) => o.utilization)).toEqual([0.2, 0.5]);
  });
});
