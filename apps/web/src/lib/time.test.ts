import { describe, expect, it } from "vitest";

import {
  agoText,
  formatClockTime,
  formatMessageStamp,
  formatMessageTime,
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

describe("formatMessageStamp", () => {
  const at = Date.UTC(2026, 9, 11, 14, 35, 12);

  it("uses short notification dates with a 24-hour time in the viewer's zone", () => {
    const intl = { locale: "en-US", timeZone: "Europe/Oslo" };
    expect(notificationTime(at, intl)).toBe("Oct 11, 16:35");
    expect(formatMessageStamp(at, intl)).toBe("Oct 11, 16:35");
    expect(formatMessageStamp(at, { ...intl, timeZone: "UTC" })).toBe("Oct 11, 14:35");
    // Midnight is 00, not 24, and the date is the zone's own.
    expect(formatMessageStamp(Date.UTC(2026, 9, 6, 22, 5, 0), intl)).toBe("Oct 7, 00:05");
    expect(formatMessageStamp(at, { ...intl, timeZone: "Asia/Kolkata" })).toBe("Oct 11, 20:05");
    expect(formatMessageStamp(Date.UTC(2026, 11, 1, 9), intl)).toBe("Dec 1, 10:00");
  });

  it("preserves the notification formatter's locale ordering, punctuation and default zone", () => {
    expect(formatMessageStamp(at)).toBe(notificationTime(at));
    for (const locale of ["en-US", "en-GB", "nb-NO"]) {
      const intl = { locale, timeZone: "Europe/Oslo" };
      const existingNotification = new Intl.DateTimeFormat(locale, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
        timeZone: intl.timeZone,
      }).format(at);
      expect(notificationTime(at, intl)).toBe(existingNotification);
      expect(formatMessageStamp(at, intl)).toBe(existingNotification);
    }
  });

  it("rejects invalid dates as notifications already do", () => {
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
