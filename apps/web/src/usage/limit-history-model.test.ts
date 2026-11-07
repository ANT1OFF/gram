import { describe, expect, it } from "vitest";

import {
  atLimitText,
  burnText,
  dayTicks,
  historyGap,
  historyRuns,
  nearestPoint,
  paceText,
  paceWarns,
  windowHistorySummary,
} from "./limit-history-model";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Pinned: 2026-11-01 09:00 UTC. */
const T = Date.UTC(2026, 10, 1, 9);

describe("pace words", () => {
  it("says on pace within five points, else how far ahead or under", () => {
    expect(paceText({ elapsed: 0.5, ahead: 0.03 })).toBe("On pace");
    expect(paceText({ elapsed: 0.5, ahead: -0.049 })).toBe("On pace");
    expect(paceText({ elapsed: 0.4, ahead: 0.2 })).toBe("20 pts ahead of pace");
    expect(paceText({ elapsed: 0.5, ahead: -0.4 })).toBe("40 pts under pace");
    expect(paceWarns({ elapsed: 0.4, ahead: 0.2 })).toBe(true);
    expect(paceWarns({ elapsed: 0.4, ahead: 0.1 })).toBe(false);
  });
});

describe("history runs", () => {
  it("breaks the line where nobody read the limit for longer than the gap", () => {
    const at = (h: number) => ({ at: T + h * HOUR });
    expect(
      historyRuns([at(0), at(0.25), at(0.5), at(4), at(4.25)], historyGap(15 * MINUTE)),
    ).toEqual([
      [at(0), at(0.25), at(0.5)],
      [at(4), at(4.25)],
    ]);
    expect(historyGap(15 * MINUTE)).toBe(HOUR);
    expect(historyGap(HOUR)).toBe(2 * HOUR);
  });

  it("finds the reading nearest the pointer, and none far from any", () => {
    const points = [{ at: T }, { at: T + HOUR }];
    expect(nearestPoint(points, T + 40 * MINUTE, HOUR)).toEqual({ at: T + HOUR });
    expect(nearestPoint(points, T + 5 * HOUR, HOUR)).toBeUndefined();
  });
});

describe("window summary", () => {
  it("names the peak and how many windows reached the limit, a moving reset one window", () => {
    const first = T + 2 * HOUR;
    const second = T + 7 * HOUR;
    const summary = windowHistorySummary([
      { at: T, windowId: first, utilization: 0.5, peak: 0.5, resetsAt: first },
      { at: T + HOUR, windowId: first, utilization: 1, peak: 1, resetsAt: first + 4 * MINUTE },
      { at: T + 3 * HOUR, windowId: second, utilization: 0.3, peak: 0.3, resetsAt: second },
    ]);
    expect(summary).toEqual({ peak: 1, atLimit: 1, windows: 2 });
    expect(atLimitText(summary!)).toBe("Reached the limit in 1 of 2 windows");
    expect(atLimitText({ peak: 0.4, atLimit: 0, windows: 3 })).toBeUndefined();
    expect(windowHistorySummary([])).toBeUndefined();
  });

  it("counts a window that reset inside a bucket apart from the next, with its own peak", () => {
    // The review's case: a spent window resets inside a quarter hour and the next opens at 5%.
    const spent = T + 10 * MINUTE;
    const next = T + 5 * HOUR + 10 * MINUTE;
    expect(
      windowHistorySummary([
        { at: T, windowId: spent, utilization: 1, peak: 1, resetsAt: spent },
        { at: T, windowId: next, utilization: 0.05, peak: 0.05, resetsAt: next },
      ]),
    ).toEqual({ peak: 1, atLimit: 1, windows: 2 });
  });
});

describe("credit words", () => {
  it("says what was spent, over how long and per day", () => {
    expect(burnText({ spent: 210, added: 0, from: T, to: T + 7 * DAY, perDay: 30 })).toBe(
      "210 spent over 7 days · about 30 a day",
    );
    expect(burnText({ spent: 6, added: 0, from: T, to: T + HOUR })).toBe("6 spent today");
    expect(burnText({ spent: 0, added: 500, from: T, to: T + DAY })).toBe(
      "No credits spent in this period",
    );
  });
});

describe("day ticks", () => {
  it("marks each local midnight over a week, every seventh over a month", () => {
    const week = dayTicks(T, T + 7 * DAY, 1);
    expect(week.length).toBeGreaterThanOrEqual(7);
    for (const tick of week) {
      expect(new Date(tick).getHours()).toBe(0);
      expect(tick).toBeGreaterThanOrEqual(T);
    }
    expect(dayTicks(T, T + 30 * DAY, 7).length).toBeLessThanOrEqual(5);
  });
});
