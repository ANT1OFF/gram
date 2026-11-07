import { describe, expect, it } from "vitest";
import {
  coarsenCreditPoints,
  coarsenLimitPoints,
  creditBalanceNumber,
  creditBurn,
  LIMIT_HISTORY_BUCKET_MS,
  limitHistoryBucket,
  limitHistoryStep,
  limitPace,
} from "./usage-limit-history.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** A pinned moment on a bucket boundary: 2026-11-01 09:00 UTC. */
const T = Date.UTC(2026, 10, 1, 9);

describe("limit history buckets", () => {
  it("puts a reading in its quarter hour, and serves a month by the hour", () => {
    expect(limitHistoryBucket(T + 14 * MINUTE + 59_999)).toBe(T);
    expect(limitHistoryBucket(T + 15 * MINUTE)).toBe(T + LIMIT_HISTORY_BUCKET_MS);
    expect(limitHistoryStep(7)).toBe(LIMIT_HISTORY_BUCKET_MS);
    expect(limitHistoryStep(30)).toBe(HOUR);
  });

  it("coarsens to the last share, the highest peak and the last reset named", () => {
    expect(
      coarsenLimitPoints(
        [
          { at: T, utilization: 0.4, peak: 0.4, resetsAt: T + 2 * HOUR },
          { at: T + 15 * MINUTE, utilization: 0.7, peak: 0.75 },
          { at: T + 30 * MINUTE, utilization: 0.05, peak: 0.6, resetsAt: T + 5 * HOUR },
          { at: T + HOUR, utilization: 0.1, peak: 0.1 },
        ],
        HOUR,
      ),
    ).toEqual([
      { at: T, utilization: 0.05, peak: 0.75, resetsAt: T + 5 * HOUR },
      { at: T + HOUR, utilization: 0.1, peak: 0.1 },
    ]);
    expect(
      coarsenCreditPoints(
        [
          { at: T, balance: 900 },
          { at: T + 45 * MINUTE, balance: 880 },
          { at: T + HOUR, balance: 870 },
        ],
        HOUR,
      ),
    ).toEqual([
      { at: T, balance: 880 },
      { at: T + HOUR, balance: 870 },
    ]);
  });
});

describe("credits", () => {
  it("reads a balance as Codex gives it, and nothing that isn't a number", () => {
    expect(creditBalanceNumber("1250")).toBe(1250);
    expect(creditBalanceNumber("1,250.5")).toBe(1250.5);
    expect(creditBalanceNumber(" 12 ")).toBe(12);
    for (const bad of [undefined, "", "lots", "1e9", "12 credits", "NaN"])
      expect(creditBalanceNumber(bad)).toBeUndefined();
  });

  it("burns the falls, counts a top-up apart, and says per day once a day is read", () => {
    expect(creditBurn([{ at: T, balance: 100 }])).toBeUndefined();
    expect(
      creditBurn([
        { at: T, balance: 1000 },
        { at: T + HOUR, balance: 950 },
        { at: T + DAY, balance: 1450 },
        { at: T + 2 * DAY, balance: 1300 },
      ]),
    ).toEqual({ spent: 200, added: 500, from: T, to: T + 2 * DAY, perDay: 100 });
    // Under a day: no per-day rate from a few hours.
    expect(
      creditBurn([
        { at: T, balance: 10 },
        { at: T + HOUR, balance: 4 },
      ]),
    ).toEqual({ spent: 6, added: 0, from: T, to: T + HOUR });
  });
});

describe("pace", () => {
  it("sets the share used beside the share of the window gone", () => {
    // Two of five hours gone, 60% used: twenty points ahead.
    const pace = limitPace("five_hour", { utilization: 0.6, resetsAt: T + 3 * HOUR }, T);
    expect(pace?.elapsed).toBeCloseTo(0.4);
    expect(pace?.ahead).toBeCloseTo(0.2);
    const week = limitPace("seven_day", { utilization: 0.1, resetsAt: T + 3.5 * DAY }, T);
    expect(week?.elapsed).toBeCloseTo(0.5);
    expect(week?.ahead).toBeCloseTo(-0.4);
  });

  it("says nothing without a reset, past it, or for a window of unknown length", () => {
    expect(limitPace("five_hour", { utilization: 0.5 }, T)).toBeUndefined();
    expect(limitPace("five_hour", { utilization: 0.5, resetsAt: T }, T)).toBeUndefined();
    expect(limitPace("overage", { utilization: 0.5, resetsAt: T + HOUR }, T)).toBeUndefined();
    // A reset further off than the window is long reads as none of it gone.
    expect(limitPace("five_hour", { utilization: 0.5, resetsAt: T + 9 * HOUR }, T)?.elapsed).toBe(
      0,
    );
  });
});
