// When a routine next comes due: daily and weekly times are read on the wall clock of the routine's
// zone, across daylight-saving changes in both directions, and an interval counts from the last run.
import { describe, expect, it } from "vitest";
import { HOUR_MS, nextRunAfter, runStamp, weekdayOf } from "./schedule.ts";

/** The wall clock `at` reads in `zone`, as `YYYY-MM-DD HH:MM` and its weekday. */
const wall = (at: number, zone: string) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.weekday} ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
};

const OSLO = "Europe/Oslo";
const NEW_YORK = "America/New_York";

describe("nextRunAfter", () => {
  it("runs a daily routine later the same day, else the next day", () => {
    const morning = Date.parse("2026-06-10T05:00:00Z"); // 07:00 in Oslo
    expect(wall(nextRunAfter({ kind: "daily", time: "09:00" }, morning, OSLO), OSLO)).toBe(
      "Wed 2026-06-10 09:00",
    );
    const evening = Date.parse("2026-06-10T18:00:00Z"); // 20:00 in Oslo
    expect(wall(nextRunAfter({ kind: "daily", time: "09:00" }, evening, OSLO), OSLO)).toBe(
      "Thu 2026-06-11 09:00",
    );
  });

  it("never runs again at the instant that just ran", () => {
    const at = nextRunAfter(
      { kind: "daily", time: "09:00" },
      Date.parse("2026-06-10T05:00:00Z"),
      OSLO,
    );
    expect(wall(nextRunAfter({ kind: "daily", time: "09:00" }, at, OSLO), OSLO)).toBe(
      "Thu 2026-06-11 09:00",
    );
  });

  it("reads the time in the routine's zone, not UTC's", () => {
    // 03:00 UTC on the 10th is 23:00 on the 9th in New York: 22:30 there is the 10th's.
    const after = Date.parse("2026-06-10T03:00:00Z");
    const next = nextRunAfter({ kind: "daily", time: "22:30" }, after, NEW_YORK);
    expect(wall(next, NEW_YORK)).toBe("Wed 2026-06-10 22:30");
    expect(new Date(next).toISOString()).toBe("2026-06-11T02:30:00.000Z");
    // The same routine in Oslo is another instant.
    expect(wall(nextRunAfter({ kind: "daily", time: "22:30" }, after, OSLO), OSLO)).toBe(
      "Wed 2026-06-10 22:30",
    );
  });

  it("keeps 09:00 at 09:00 across the spring and autumn changes", () => {
    // Oslo moves to summer time on 29 March 2026 and back on 25 October 2026.
    let at = Date.parse("2026-03-27T12:00:00Z");
    const spring: string[] = [];
    for (let i = 0; i < 4; i++) {
      at = nextRunAfter({ kind: "daily", time: "09:00" }, at, OSLO);
      spring.push(wall(at, OSLO));
    }
    expect(spring).toEqual([
      "Sat 2026-03-28 09:00",
      "Sun 2026-03-29 09:00",
      "Mon 2026-03-30 09:00",
      "Tue 2026-03-31 09:00",
    ]);
    // The day the clocks go forward is 23 hours long.
    const before = nextRunAfter(
      { kind: "daily", time: "09:00" },
      Date.parse("2026-03-28T00:00:00Z"),
      OSLO,
    );
    expect(nextRunAfter({ kind: "daily", time: "09:00" }, before, OSLO) - before).toBe(
      23 * HOUR_MS,
    );

    at = Date.parse("2026-10-23T12:00:00Z");
    const autumn: string[] = [];
    for (let i = 0; i < 4; i++) {
      at = nextRunAfter({ kind: "daily", time: "09:00" }, at, OSLO);
      autumn.push(wall(at, OSLO));
    }
    expect(autumn).toEqual([
      "Sat 2026-10-24 09:00",
      "Sun 2026-10-25 09:00",
      "Mon 2026-10-26 09:00",
      "Tue 2026-10-27 09:00",
    ]);
  });

  it("runs a time the spring change skips once that day, and a repeated one once", () => {
    // 02:30 doesn't exist in Oslo on 29 March 2026: it runs once that night, then 02:30 again.
    let at = Date.parse("2026-03-28T12:00:00Z");
    const skipped: number[] = [];
    for (let i = 0; i < 3; i++) {
      at = nextRunAfter({ kind: "daily", time: "02:30" }, at, OSLO);
      skipped.push(at);
    }
    expect(skipped.map((each) => wall(each, OSLO))).toEqual([
      "Sun 2026-03-29 03:30",
      "Mon 2026-03-30 02:30",
      "Tue 2026-03-31 02:30",
    ]);
    // 02:30 happens twice on 25 October 2026: one run that night, never two.
    at = Date.parse("2026-10-24T12:00:00Z");
    const repeated: string[] = [];
    for (let i = 0; i < 3; i++) {
      at = nextRunAfter({ kind: "daily", time: "02:30" }, at, OSLO);
      repeated.push(wall(at, OSLO));
    }
    expect(repeated).toEqual([
      "Sun 2026-10-25 02:30",
      "Mon 2026-10-26 02:30",
      "Tue 2026-10-27 02:30",
    ]);
  });

  it("runs a weekly routine on its weekday, this week if it hasn't passed", () => {
    const wednesday = Date.parse("2026-06-10T05:00:00Z"); // Wed 07:00 in Oslo
    expect(
      wall(nextRunAfter({ kind: "weekly", day: "wed", time: "09:00" }, wednesday, OSLO), OSLO),
    ).toBe("Wed 2026-06-10 09:00");
    expect(
      wall(nextRunAfter({ kind: "weekly", day: "mon", time: "09:00" }, wednesday, OSLO), OSLO),
    ).toBe("Mon 2026-06-15 09:00");
    const after = Date.parse("2026-06-10T08:00:00Z"); // Wed 10:00, past this week's
    expect(
      wall(nextRunAfter({ kind: "weekly", day: "wed", time: "09:00" }, after, OSLO), OSLO),
    ).toBe("Wed 2026-06-17 09:00");
  });

  it("keeps a weekly routine's clock time across a change", () => {
    const after = Date.parse("2026-10-20T12:00:00Z");
    const first = nextRunAfter({ kind: "weekly", day: "mon", time: "08:15" }, after, OSLO);
    const second = nextRunAfter({ kind: "weekly", day: "mon", time: "08:15" }, first, OSLO);
    expect([wall(first, OSLO), wall(second, OSLO)]).toEqual([
      "Mon 2026-10-26 08:15",
      "Mon 2026-11-02 08:15",
    ]);
    // The week across the change is an hour longer.
    const firstAcross = nextRunAfter({ kind: "weekly", day: "sat", time: "08:15" }, after, OSLO);
    const secondAcross = nextRunAfter(
      { kind: "weekly", day: "sat", time: "08:15" },
      firstAcross,
      OSLO,
    );
    expect(secondAcross - firstAcross).toBe(7 * 24 * HOUR_MS + HOUR_MS);
  });

  it("counts an interval in real hours from the last run, whatever the clock does", () => {
    const at = Date.parse("2026-10-25T00:00:00Z");
    expect(nextRunAfter({ kind: "interval", hours: 6 }, at, OSLO) - at).toBe(6 * HOUR_MS);
    expect(nextRunAfter({ kind: "interval", hours: 1 }, at, OSLO) - at).toBe(HOUR_MS);
  });

  it("refuses a zone Intl doesn't know", () => {
    expect(() => nextRunAfter({ kind: "daily", time: "09:00" }, 0, "Mars/Olympus")).toThrow(
      RangeError,
    );
  });
});

describe("weekdayOf and runStamp", () => {
  it("names the weekday Monday first", () => {
    expect(weekdayOf({ year: 2026, month: 10, day: 2 })).toBe("mon");
    expect(weekdayOf({ year: 2026, month: 10, day: 8 })).toBe("sun");
  });

  it("stamps a run in the routine's zone, on a 24-hour clock", () => {
    expect(runStamp(Date.parse("2026-11-05T21:07:00Z"), OSLO)).toBe("20261105-2207");
    expect(runStamp(Date.parse("2026-11-05T23:30:00Z"), OSLO)).toBe("20261106-0030");
  });
});
