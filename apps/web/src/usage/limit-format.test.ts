import { describe, expect, it } from "vitest";

import type { LimitForecast } from "@gram/contracts";

import type { TightestLimit } from "@/stores/usage-limits";

import { costShown } from "./cost";
import {
  heldStateText,
  heldUntilText,
  limitPercent,
  limitShareText,
  limitSummaryText,
  meterHint,
  meterLabel,
  creditsText,
  forecastText,
  meterText,
  resetAtText,
  resetText,
  WINDOW_LABEL,
  windowWord,
} from "./limit-format";

const UTC = { locale: "en-GB", timeZone: "UTC" } as const;
// Thursday 15 October 2026, 14:39 UTC.
const NOW = Date.parse("2026-10-15T14:39:00Z");

describe("limit formatting", () => {
  it("says when a held brief starts, on a 24-hour clock, and why it waits", () => {
    expect(heldUntilText(Date.parse("2026-10-15T23:15:00Z"), NOW, UTC)).toBe("Paused until 23:15");
    expect(heldUntilText(Date.parse("2026-10-17T09:00:00Z"), NOW, UTC)).toBe(
      "Paused until 17 Oct 09:00",
    );
    const until = Date.parse("2026-10-15T18:00:00Z");
    expect(heldStateText({ until }, NOW, UTC)).toBe("Paused until 18:00");
    expect(heldStateText({ until }, NOW, { ...UTC, short: true })).toBe("until 18:00");
    const retryAt = Date.parse("2026-10-15T18:02:00Z");
    expect(heldStateText({ until, retryAt }, NOW, UTC)).toBe("Tried again at 18:02");
    expect(heldStateText({ until, retryAt }, NOW, { ...UTC, short: true })).toBe("retry at 18:02");
    expect(heldStateText({ until, retryAt, waitsForSlot: true }, NOW, UTC)).toBe(
      "Waits for a free worker slot",
    );
    expect(heldStateText({ until, waitsForSlot: true }, NOW, { ...UTC, short: true })).toBe(
      "waits for a slot",
    );
    expect(
      limitShareText({
        agent: "codex",
        usedPct: 0,
        window: "fiveHour",
        reason: "Held after network failure without output",
      }),
    ).toBe("Held after network failure without output");
    expect(limitShareText({ agent: "codex", usedPct: 85, window: "fiveHour" })).toBe(
      "Codex is at 85% of its 5-hour limit",
    );
    expect(limitShareText({ agent: "claude", usedPct: 91, window: "weekly" })).toBe(
      "Claude is at 91% of its weekly limit",
    );
  });

  it("gives each window one name, from the meter's word or the agent's, never 7-day", () => {
    expect(WINDOW_LABEL.weekly).toBe("Weekly");
    expect(windowWord("weekly")).toBe("weekly");
    expect(windowWord("fiveHour")).toBe("5-hour");
    expect(windowWord("seven_day")).toBe("weekly");
    expect(windowWord("five_hour")).toBe("5-hour");
    expect(windowWord("seven_day_opus")).toBe("weekly opus");
    expect(windowWord("overage")).toBe("overage");
    expect(windowWord("per_model_cap")).toBe("per model cap");
  });

  it("says the same sentence for a held brief and the pause card, whichever window name", () => {
    expect(limitShareText({ agent: "codex", usedPct: 85, window: "five_hour" })).toBe(
      limitShareText({ agent: "codex", usedPct: 85, window: "fiveHour" }),
    );
    expect(limitShareText({ agent: "claude", usedPct: 90, window: "seven_day" })).toBe(
      "Claude is at 90% of its weekly limit",
    );
  });

  it("sums the tightest limit up in one line, capped short of the limit", () => {
    const tightest: TightestLimit = {
      provider: "claude",
      window: "weekly",
      limit: { utilization: 0.996, status: "allowed", expiresAt: NOW + 3_600_000 },
    };
    expect(limitSummaryText(tightest)).toBe("Claude 99% of the weekly limit");
    expect(limitSummaryText({ ...tightest, provider: "codex", window: "fiveHour" })).toBe(
      "Codex 99% of the 5-hour limit",
    );
  });

  it("rounds to whole percent, and says 100% only once it is all used", () => {
    expect([0, 0.004, 0.42, 0.849, 0.85, 0.996, 1].map(limitPercent)).toEqual([
      0, 0, 42, 85, 85, 99, 100,
    ]);
  });

  it("names the tightest limit by its provider's short name", () => {
    const tightest: TightestLimit = {
      provider: "claude",
      window: "fiveHour",
      limit: { utilization: 0.42, status: "allowed", expiresAt: NOW + 3_600_000 },
    };
    expect(meterText(tightest)).toBe("Claude 42%");
    expect(meterText({ ...tightest, provider: "codex" })).toBe("Codex 42%");
    expect(meterHint({ ...tightest, provider: "codex" })).toBe(
      "Highest usage: Codex 5-hour limit, 42%",
    );
    expect(meterLabel({ ...tightest, window: "weekly" })).toBe(
      "Highest subscription usage: Claude Code weekly limit 42% used",
    );
  });

  it("says a full window the agent goes on past is on credits, not a stop", () => {
    const tightest: TightestLimit = {
      provider: "claude",
      window: "fiveHour",
      limit: { utilization: 1, status: "allowed", credits: true, expiresAt: NOW + 3_600_000 },
    };
    expect(meterText(tightest)).toBe("Claude 100% · credits");
    expect(meterLabel(tightest)).toBe(
      "Highest subscription usage: Claude Code 5-hour limit 100% used, continuing on credits",
    );
  });

  it("gives a reset today as a 24-hour time", () => {
    expect(resetText(Date.parse("2026-10-15T18:00:00Z"), NOW, UTC)).toBe("18:00");
    expect(resetText(Date.parse("2026-10-15T23:45:00Z"), NOW, UTC)).toBe("23:45");
  });

  it("gives a reset on another day as its date and time, never a weekday", () => {
    expect(resetText(Date.parse("2026-10-16T00:15:00Z"), NOW, UTC)).toBe("16 Oct 00:15");
    expect(resetText(Date.parse("2026-10-19T09:00:00Z"), NOW, UTC)).toBe("19 Oct 09:00");
    expect(resetText(Date.parse("2026-10-22T09:00:00Z"), NOW, UTC)).toBe("22 Oct 09:00");
    expect(resetText(Date.parse("2027-01-02T09:00:00Z"), NOW, UTC)).toBe("2 Jan 2027 09:00");
  });

  it("dates a reset under Resets at unless it is today", () => {
    expect(resetAtText(Date.parse("2026-10-15T18:00:00Z"), NOW, UTC)).toBe("18:00");
    expect(resetAtText(Date.parse("2026-10-16T00:15:00Z"), NOW, UTC)).toBe("16 Oct 00:15");
    expect(resetAtText(Date.parse("2026-10-22T09:00:00Z"), NOW, UTC)).toBe("22 Oct 09:00");
  });

  it("gives a forecast to the nearest five minutes, dated when it isn't today", () => {
    const forecast: LimitForecast = { target: 0.9, at: Date.parse("2026-10-15T16:38:00Z") };
    expect(forecastText(forecast, NOW, UTC)).toBe("Estimate at recent pace: 90% around 16:40");
    expect(forecastText({ ...forecast, at: Date.parse("2026-10-17T09:03:00Z") }, NOW, UTC)).toBe(
      "Estimate at recent pace: 90% around 17 Oct 09:05",
    );
  });

  it("names the account's credits and balance only when the agent reports them", () => {
    expect(creditsText({})).toBeUndefined();
    expect(creditsText({ creditsAvailable: true })).toBe("On credits");
    expect(creditsText({ creditsAvailable: true, creditsBalance: "1250.5" })).toBe(
      "On credits · 1,250.5 left",
    );
    expect(creditsText({ creditsUnlimited: true })).toBe("On credits · unlimited");
  });

  it("reads the time in the viewer's zone", () => {
    const oslo = { locale: "en-GB", timeZone: "Europe/Oslo" };
    expect(resetText(Date.parse("2026-10-15T18:00:00Z"), NOW, oslo)).toBe("20:00");
  });
});

describe("dollar cost", () => {
  it("shows only for a gateway profile, and only with the setting on", () => {
    expect(costShown(true, { profileId: "gw" as never })).toBe(true);
    expect(costShown(false, { profileId: "gw" as never })).toBe(false);
    expect(costShown(true, {})).toBe(false);
    expect(costShown(true, undefined)).toBe(false);
  });
});
