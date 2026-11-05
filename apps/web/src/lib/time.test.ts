import { describe, expect, it } from "vitest";

import {
  agoText,
  formatClockTime,
  formatDay,
  formatLogTime,
  formatMessageStamp,
  formatMessageTime,
  formatStamp,
  formatWakeTime,
  notificationTime,
} from "./time";

const AT = Date.UTC(2026, 9, 6, 12, 37, 12);

describe("agoText", () => {
  const MINUTE = 60_000;

  it("says just now under a minute, never `now ago`", () => {
    expect(agoText(AT, AT)).toBe("just now");
    expect(agoText(AT - 59_999, AT)).toBe("just now");
    expect(agoText(AT + 5 * MINUTE, AT)).toBe("just now");
  });

  it("counts minutes, hours, days and then weeks", () => {
    expect(agoText(AT - 5 * MINUTE, AT)).toBe("5m ago");
    expect(agoText(AT - 3 * 60 * MINUTE, AT)).toBe("3h ago");
    expect(agoText(AT - 2 * 24 * 60 * MINUTE, AT)).toBe("2d ago");
    expect(agoText(AT - 15 * 24 * 60 * MINUTE, AT)).toBe("2w ago");
  });

  it("spells the unit out in the long form, singular for one", () => {
    const long = { long: true };
    expect(agoText(AT - 30_000, AT, long)).toBe("just now");
    expect(agoText(AT - MINUTE, AT, long)).toBe("1 minute ago");
    expect(agoText(AT - 3 * 60 * MINUTE, AT, long)).toBe("3 hours ago");
    expect(agoText(AT - 24 * 60 * MINUTE, AT, long)).toBe("1 day ago");
    expect(agoText(AT - 21 * 24 * 60 * MINUTE, AT, long)).toBe("3 weeks ago");
  });

  it("reads an ISO time, and shows one that doesn't parse as itself", () => {
    expect(agoText(new Date(AT - 5 * MINUTE).toISOString(), AT)).toBe("5m ago");
    expect(agoText("not a time", AT)).toBe("not a time");
  });
});

describe("formatClockTime", () => {
  it("keeps a 24-hour clock and 00 at midnight even in an AM/PM locale", () => {
    const intl = { locale: "en-US", timeZone: "Europe/Oslo" };
    expect(formatClockTime(AT, intl)).toBe("14:37");
    expect(formatClockTime(Date.UTC(2026, 9, 6, 22, 5), intl)).toBe("00:05");
  });
});

describe("formatLogTime", () => {
  it("gives a 24-hour clock to the second, 00 at midnight, in the pinned zone", () => {
    expect(formatLogTime(AT, { timeZone: "Europe/Oslo" })).toBe("14:37:12");
    expect(formatLogTime(Date.UTC(2026, 9, 6, 22, 5, 9), { timeZone: "Europe/Oslo" })).toBe(
      "00:05:09",
    );
  });
});

describe("formatMessageTime", () => {
  it("gives the date, the time to the second and the zone's offset from UTC", () => {
    expect(formatMessageTime(AT, { timeZone: "Europe/Oslo" })).toBe(
      "2026-10-06 14:37:12 UTC+02:00",
    );
    expect(formatMessageTime(AT, { timeZone: "America/New_York" })).toBe(
      "2026-10-06 08:37:12 UTC-04:00",
    );
    expect(formatMessageTime(AT, { timeZone: "Asia/Kolkata" })).toBe(
      "2026-10-06 18:07:12 UTC+05:30",
    );
  });

  it("gives UTC its zero offset, and the day a zone's midnight falls on", () => {
    expect(formatMessageTime(AT, { timeZone: "UTC" })).toBe("2026-10-06 12:37:12 UTC+00:00");
    const lateUtc = Date.UTC(2026, 9, 6, 22, 5, 0);
    expect(formatMessageTime(lateUtc, { timeZone: "Europe/Oslo" })).toBe(
      "2026-10-07 00:05:00 UTC+02:00",
    );
  });

  it("follows the zone's own offset across a daylight-saving change", () => {
    expect(formatMessageTime(Date.UTC(2026, 11, 1, 9, 0, 0), { timeZone: "Europe/Oslo" })).toBe(
      "2026-12-01 10:00:00 UTC+01:00",
    );
  });
});

describe("formatStamp", () => {
  const oslo = { timeZone: "Europe/Oslo" };
  // Tuesday 6 October 2026, 14:37 in Oslo.
  const now = AT;

  it("gives the 24-hour clock alone for a time today, 00 at midnight", () => {
    expect(formatStamp(Date.UTC(2026, 9, 6, 7, 42), now, oslo)).toBe("09:42");
    expect(formatStamp(Date.UTC(2026, 9, 5, 22, 0), now, oslo)).toBe("00:00");
    expect(formatStamp(Date.UTC(2026, 9, 6, 21, 59), now, oslo)).toBe("23:59");
  });

  it("puts the day and month before the clock on another day of the year", () => {
    expect(formatStamp(Date.UTC(2026, 5, 14, 6, 0), now, oslo)).toBe("14 Jun 08:00");
    expect(formatStamp(Date.UTC(2026, 9, 5, 21, 59), now, oslo)).toBe("5 Oct 23:59");
    // A future time on another day, as a reset or a wake is.
    expect(formatStamp(Date.UTC(2026, 8, 3, 8, 0), now, oslo)).toBe("3 Sep 10:00");
    expect(formatStamp(Date.UTC(2026, 9, 7, 8, 0), now, oslo)).toBe("7 Oct 10:00");
  });

  it("adds the year only when it isn't now's", () => {
    expect(formatStamp(Date.UTC(2025, 5, 14, 6, 0), now, oslo)).toBe("14 Jun 2025 08:00");
    expect(formatStamp(Date.UTC(2027, 0, 2, 9, 0), now, oslo)).toBe("2 Jan 2027 10:00");
  });

  it("reads today and the date in the pinned zone, not UTC's", () => {
    // 22:05 UTC on the 6th is already 00:05 on the 7th in Oslo.
    const late = Date.UTC(2026, 9, 6, 22, 5);
    expect(formatStamp(late, now, oslo)).toBe("7 Oct 00:05");
    expect(formatStamp(late, now, { timeZone: "UTC" })).toBe("22:05");
    expect(formatStamp(late, now, { timeZone: "Asia/Kolkata" })).toBe("7 Oct 03:35");
    // New Year's Eve in New York is New Year's Day in Oslo: the year follows the zone too.
    const eve = Date.UTC(2026, 11, 31, 23, 30);
    expect(formatStamp(eve, eve, { timeZone: "America/New_York" })).toBe("18:30");
    expect(formatStamp(eve, Date.UTC(2026, 11, 30), oslo)).toBe("1 Jan 2027 00:30");
  });

  it("rejects an invalid date as `Intl` does", () => {
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, 8.64e15 + 1]) {
      expect(() => formatStamp(invalid, now)).toThrow(RangeError);
    }
  });
});

describe("formatDay", () => {
  const oslo = { timeZone: "Europe/Oslo" };

  it("gives the day and month, the year only when it isn't now's, in the zone's own date", () => {
    expect(formatDay(Date.UTC(2026, 5, 14, 6, 0), AT, oslo)).toBe("14 Jun");
    expect(formatDay(AT, AT, oslo)).toBe("6 Oct");
    expect(formatDay(Date.UTC(2025, 5, 14, 6, 0), AT, oslo)).toBe("14 Jun 2025");
    expect(formatDay(Date.UTC(2026, 9, 6, 22, 5), AT, oslo)).toBe("7 Oct");
    expect(formatDay(Date.UTC(2026, 9, 6, 22, 5), AT, { timeZone: "UTC" })).toBe("6 Oct");
  });
});

describe("notificationTime and formatMessageStamp", () => {
  const at = Date.UTC(2026, 9, 11, 14, 35, 12);
  const oslo = { timeZone: "Europe/Oslo" };

  it("are `formatStamp`: the clock today, the date before it on another day", () => {
    expect(notificationTime(at, at, oslo)).toBe("16:35");
    expect(formatMessageStamp(at, at, oslo)).toBe("16:35");
    expect(formatMessageStamp(at, at, { timeZone: "UTC" })).toBe("14:35");
    expect(notificationTime(at, AT, oslo)).toBe("11 Oct 16:35");
    expect(formatMessageStamp(at, AT, { timeZone: "Asia/Kolkata" })).toBe("11 Oct 20:05");
    // Midnight is 00, not 24, and the date is the zone's own.
    expect(formatMessageStamp(Date.UTC(2026, 9, 6, 22, 5, 0), AT, oslo)).toBe("7 Oct 00:05");
    expect(formatMessageStamp(Date.UTC(2025, 11, 1, 9), AT, oslo)).toBe("1 Dec 2025 10:00");
    expect(formatMessageStamp(at)).toBe(formatStamp(at));
  });

  it("rejects invalid dates", () => {
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, 8.64e15 + 1]) {
      expect(() => notificationTime(invalid)).toThrow(RangeError);
      expect(() => formatMessageStamp(invalid)).toThrow(RangeError);
    }
  });
});

describe("formatWakeTime", () => {
  const oslo = { timeZone: "Europe/Oslo" };

  it("gives the time alone on the viewer's day, and the weekday on a later one", () => {
    expect(formatWakeTime(AT + 45 * 60_000, AT, oslo)).toBe("15:22");
    // 00:05 the next day in Oslo, though still the same day in UTC.
    expect(formatWakeTime(Date.UTC(2026, 9, 6, 22, 5), AT, oslo)).toBe("Wed 00:05");
    expect(formatWakeTime(Date.UTC(2026, 9, 6, 22, 5), AT, { timeZone: "UTC" })).toBe("22:05");
    expect(formatWakeTime(AT + 3 * 86_400_000, AT, oslo)).toBe("Fri 14:37");
  });
});
