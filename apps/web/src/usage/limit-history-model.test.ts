import { describe, expect, it } from "vitest";

import {
  atLimitText,
  burnText,
  fittingTicks,
  dayTicks,
  historyGap,
  historyRuns,
  nearestPoint,
  paceText,
  paceWarns,
  windowHistorySummary,
  stepWords,
  windowPointNotes,
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
    expect(burnText({ spent: 6, added: 0, from: T, to: T + HOUR })).toBe("6 spent over 1 hour");
    // Under a day but across midnight: hours, never "today".
    const evening = Date.UTC(2026, 10, 1, 23);
    expect(burnText({ spent: 100, added: 0, from: evening, to: evening + 6 * HOUR })).toBe(
      "100 spent over 6 hours",
    );
    expect(burnText({ spent: 3, added: 0, from: T, to: T + 10 * MINUTE })).toBe(
      "3 spent over 10 minutes",
    );
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

const percent = (share: number) => Math.round(share * 100);

describe("the charts' legend and hover words", () => {
  it("says a period's step in words", () => {
    expect(stepWords(15 * 60_000)).toBe("quarter hour");
    expect(stepWords(3_600_000)).toBe("hour");
    expect(stepWords(3 * 3_600_000)).toBe("3 hours");
    expect(stepWords(86_400_000)).toBe("day");
    expect(stepWords(5 * 60_000)).toBe("5 minutes");
  });

  it("dates a point's reading, names a higher peak, and says its window's reset", () => {
    const now = Date.UTC(2026, 5, 14, 12, 0);
    const hour = 3_600_000;
    // Two days back, its window long since reset, with a peak above the last reading.
    expect(
      windowPointNotes(
        { at: now - 2 * 24 * hour - hour, utilization: 0.4, peak: 0.64, resetsAt: now - 24 * hour },
        hour,
        now,
        percent,
      ),
    ).toEqual([
      "Read 2d ago",
      "Peak 64% within the hour",
      expect.stringMatching(/^Reset \d{1,2} Jun /),
    ]);
    // The bucket in progress: read now, its window still to reset, no peak above it.
    expect(
      windowPointNotes(
        { at: now - 10 * 60_000, utilization: 0.5, peak: 0.5, resetsAt: now + 2 * hour },
        hour,
        now,
        percent,
      ),
    ).toEqual(["Read just now", expect.stringMatching(/^Resets \d{2}:\d{2}$/)]);
    // No reset given: only its age.
    expect(
      windowPointNotes({ at: now - hour, utilization: 0.1, peak: 0.1 }, hour, now, percent),
    ).toEqual(["Read just now"]);
  });
});

describe("fittingTicks", () => {
  it("drops a tick in the axis's last tenth, which would hang over the day before", () => {
    const share = (at: number) => at / 100;
    expect(fittingTicks([0, 14, 28, 42, 56, 70, 84, 96], share)).toEqual([
      0, 14, 28, 42, 56, 70, 84,
    ]);
    expect(fittingTicks([0, 50, 90], share)).toEqual([0, 50, 90]);
  });
});
