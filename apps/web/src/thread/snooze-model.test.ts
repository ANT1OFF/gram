import { describe, expect, it } from "vitest";

import {
  customSnooze,
  dateInputValue,
  snoozedUntilText,
  snoozePresets,
  snoozeTime,
  typedSnooze,
} from "./snooze-model";

const oslo = { timeZone: "Europe/Oslo" };
/** Oslo is UTC+1 in November. */
const osloNov = (day: number, hour: number, minute = 0) =>
  Date.UTC(2026, 10, day, hour - 1, minute);

const byId = (now: number) =>
  Object.fromEntries(snoozePresets(now, oslo).map((preset) => [preset.id, preset.at]));

describe("snoozePresets", () => {
  it("offers an hour, this evening, tomorrow morning and next Monday from a weekday afternoon", () => {
    // Thursday 5 November, 14:20.
    const now = osloNov(5, 14, 20);
    const at = byId(now);
    expect(at["hour"]).toBe(osloNov(5, 15, 20));
    expect(at["evening"]).toBe(osloNov(5, 18));
    expect(at["tomorrow"]).toBe(osloNov(6, 9));
    expect(at["nextWeek"]).toBe(osloNov(9, 9));
    expect(snoozeTime(at["tomorrow"]!, now, oslo)).toBe("Fri 09:00");
    expect(snoozedUntilText(at["evening"]!, now, oslo)).toBe("Snoozed until 18:00");
  });

  it("crosses midnight late in the evening, and leaves out an evening already gone", () => {
    // Friday 6 November, 23:30.
    const now = osloNov(6, 23, 30);
    const presets = snoozePresets(now, oslo);
    expect(presets.map((p) => p.id)).toEqual(["hour", "tomorrow", "nextWeek"]);
    const at = byId(now);
    expect(at["hour"]).toBe(osloNov(7, 0, 30));
    expect(snoozeTime(at["hour"]!, now, oslo)).toBe("Sat 00:30");
    expect(at["tomorrow"]).toBe(osloNov(7, 9));
    expect(snoozedUntilText(at["tomorrow"]!, now, oslo)).toBe("Snoozed until Sat 09:00");
  });

  it("goes a full week on from a Monday, and to the coming Monday from a Sunday", () => {
    expect(byId(osloNov(9, 10))["nextWeek"]).toBe(osloNov(16, 9));
    expect(byId(osloNov(8, 10))["nextWeek"]).toBe(osloNov(9, 9));
  });

  it("keeps 09:00 on the wall clock across the end of summer time", () => {
    // Saturday 24 October 2026, 20:00 CEST (UTC+2); clocks go back that night.
    const now = Date.UTC(2026, 9, 24, 18, 0);
    // Sunday 09:00 CET (UTC+1): 14 hours on, not 13.
    expect(byId(now)["tomorrow"]).toBe(Date.UTC(2026, 9, 25, 8, 0));
  });
});

describe("customSnooze", () => {
  const now = osloNov(6, 23, 30);

  it("reads a date and a 24-hour time on the zone's wall clock", () => {
    expect(customSnooze("2026-11-07", "07:15", now, oslo)).toEqual({ at: osloNov(7, 7, 15) });
    expect(customSnooze("2026-11-20", "21:05", now, oslo)).toEqual({ at: osloNov(20, 21, 5) });
    expect(dateInputValue(now, oslo)).toBe("2026-11-06");
  });

  it("says why a time can't be one", () => {
    expect(customSnooze("2026-11-06", "9pm", now, oslo)).toEqual({
      error: "Write the time as HH:MM, from 00:00 to 23:59",
    });
    expect(customSnooze("2026-11-06", "24:00", now, oslo)).toHaveProperty("error");
    expect(customSnooze("2026-11-06", "23:00", now, oslo)).toEqual({
      error: "That time has already passed",
    });
    expect(customSnooze("", "09:00", now, oslo)).toEqual({ error: "Pick a date" });
  });

  it("shows a snooze more than a week out by its date", () => {
    expect(snoozeTime(osloNov(20, 21, 5), now, oslo)).not.toMatch(/^Fri /);
    expect(snoozeTime(osloNov(20, 21, 5), now, oslo)).toContain("21:05");
  });
});

describe("typedSnooze", () => {
  // Thursday 5 November, 14:20.
  const now = osloNov(5, 14, 20);
  const typed = (text: string) => typedSnooze(text, now, oslo);

  it("reads a weekday and a 24-hour time, the weekday's next one ahead", () => {
    expect(typed("fri 14:00")).toBe(osloNov(6, 14));
    expect(typed("Friday 9")).toBe(osloNov(6, 9));
    expect(typed("14:00 fri")).toBe(osloNov(6, 14));
    // Today's weekday is today while its time is ahead, else a week on.
    expect(typed("thu 16:30")).toBe(osloNov(5, 16, 30));
    expect(typed("thu 08:00")).toBe(osloNov(12, 8));
  });

  it("takes a day alone as 09:00, and a time alone as the next time the clock reads it", () => {
    expect(typed("mon")).toBe(osloNov(9, 9));
    expect(typed("tomorrow")).toBe(osloNov(6, 9));
    expect(typed("17:45")).toBe(osloNov(5, 17, 45));
    expect(typed("08:00")).toBe(osloNov(6, 8));
    expect(typed("today 18:00")).toBe(osloNov(5, 18));
  });

  it("reads a span in minutes or hours", () => {
    expect(typed("30m")).toBe(now + 30 * 60_000);
    expect(typed("2h")).toBe(now + 2 * 3_600_000);
  });

  it("reads nothing it can't be sure of, or a time already past", () => {
    for (const text of [
      "",
      "fr",
      "friyay",
      "9pm",
      "25:00",
      "fri sat",
      "today 09:00",
      "0h",
      "a b c",
    ]) {
      expect(typed(text), text).toBeUndefined();
    }
  });
});
