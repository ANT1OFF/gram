import { describe, expect, it } from "vitest";
import { DAY_MS, dateKey, localDayOf, localWall, plusDays, startOfLocalDay } from "./zone-time.ts";

describe("the local day", () => {
  it("finds local midnight on either side of UTC", () => {
    const noon = Date.UTC(2026, 8, 24, 12, 0);
    expect(startOfLocalDay(noon, "UTC")).toBe(Date.UTC(2026, 8, 24));
    // Oslo in summer, UTC+2: local midnight is 22:00 UTC the evening before.
    expect(startOfLocalDay(noon, "Europe/Oslo")).toBe(Date.UTC(2026, 8, 23, 22));
    expect(startOfLocalDay(Date.UTC(2026, 8, 24, 22, 30), "Europe/Oslo")).toBe(
      Date.UTC(2026, 8, 24, 22),
    );
    expect(startOfLocalDay(Date.UTC(2026, 8, 24, 21, 59), "Europe/Oslo")).toBe(
      Date.UTC(2026, 8, 23, 22),
    );
    // New York in summer, UTC−4: local midnight is 04:00 UTC.
    expect(startOfLocalDay(noon, "America/New_York")).toBe(Date.UTC(2026, 8, 24, 4));
    expect(startOfLocalDay(Date.UTC(2026, 8, 24, 3, 59), "America/New_York")).toBe(
      Date.UTC(2026, 8, 23, 4),
    );
  });

  it("puts midnight itself in the new day and the millisecond before it in the old", () => {
    const midnight = Date.UTC(2026, 8, 24);
    expect(startOfLocalDay(midnight, "UTC")).toBe(midnight);
    expect(startOfLocalDay(midnight - 1, "UTC")).toBe(midnight - DAY_MS);
  });

  // The offset changes partway through the day, so the day's start is the real midnight, not the
  // offset in force at the observation applied to the whole day. Both observations below are on
  // the same London calendar day, so they share one bucket.
  it("keeps one day's start across the spring change in London, a 23-hour day", () => {
    const midnight = Date.parse("2026-03-29T00:00:00Z");
    expect(startOfLocalDay(Date.parse("2026-03-29T00:59:00Z"), "Europe/London")).toBe(midnight);
    expect(startOfLocalDay(Date.parse("2026-03-29T01:01:00Z"), "Europe/London")).toBe(midnight);
    // 30 March starts at BST midnight, which is 23:00 UTC the day before.
    expect(startOfLocalDay(Date.parse("2026-03-29T22:59:00Z"), "Europe/London")).toBe(midnight);
    expect(startOfLocalDay(Date.parse("2026-03-29T23:00:00Z"), "Europe/London")).toBe(
      Date.parse("2026-03-29T23:00:00Z"),
    );
  });

  it("keeps one day's start across the autumn change in London, a 25-hour day", () => {
    const midnight = Date.parse("2026-10-24T23:00:00Z");
    // 01:30 BST and then, an hour later, 01:30 GMT: the same local day, and the repeated hour.
    expect(startOfLocalDay(Date.parse("2026-10-25T00:30:00Z"), "Europe/London")).toBe(midnight);
    expect(startOfLocalDay(Date.parse("2026-10-25T01:30:00Z"), "Europe/London")).toBe(midnight);
    expect(startOfLocalDay(Date.parse("2026-10-25T23:30:00Z"), "Europe/London")).toBe(midnight);
    // 26 October starts at GMT midnight.
    expect(startOfLocalDay(Date.parse("2026-10-26T00:00:00Z"), "Europe/London")).toBe(
      Date.parse("2026-10-26T00:00:00Z"),
    );
  });
});

describe("calendar dates", () => {
  it("names a date and moves by whole days across month, year and daylight-saving changes", () => {
    expect(dateKey({ year: 2026, month: 2, day: 9 })).toBe("2026-03-09");
    expect(dateKey(plusDays({ year: 2026, month: 2, day: 30 }, -7))).toBe("2026-03-23");
    expect(dateKey(plusDays({ year: 2026, month: 11, day: 31 }, 1))).toBe("2027-01-01");
    expect(dateKey(plusDays({ year: 2028, month: 2, day: 1 }, -1))).toBe("2028-02-29");
    expect(dateKey(localWall(new Date(2026, 9, 25, 23, 30)))).toBe("2026-10-25");
  });

  it("gives a 23-hour and a 25-hour London day their own dates", () => {
    const spring = localDayOf(Date.parse("2026-03-29T12:00:00Z"), "Europe/London");
    const next = localDayOf(Date.parse("2026-03-30T12:00:00Z"), "Europe/London");
    expect([spring.date, next.date]).toEqual(["2026-03-29", "2026-03-30"]);
    expect(next.start - spring.start).toBe(DAY_MS - 3_600_000);
    const autumn = localDayOf(Date.parse("2026-10-25T12:00:00Z"), "Europe/London");
    const after = localDayOf(Date.parse("2026-10-26T12:00:00Z"), "Europe/London");
    expect(after.start - autumn.start).toBe(DAY_MS + 3_600_000);
    expect(() => localDayOf(0, "Not/A_Zone")).toThrow(RangeError);
  });
});
