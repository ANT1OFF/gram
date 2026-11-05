import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  parseRoutineSchedule,
  RoutineSchedule,
  routineScheduleText,
  routineSlug,
} from "./routines.ts";

describe("parseRoutineSchedule", () => {
  it("reads daily, weekly and interval schedules on a 24-hour clock", () => {
    expect(parseRoutineSchedule("daily 9:05")).toEqual({
      schedule: { kind: "daily", time: "09:05" },
    });
    expect(parseRoutineSchedule(" Weekly Monday 16:30 ")).toEqual({
      schedule: { kind: "weekly", day: "mon", time: "16:30" },
    });
    expect(parseRoutineSchedule("every 1 hour")).toEqual({
      schedule: { kind: "interval", hours: 1 },
    });
    expect(parseRoutineSchedule("every 168 hours")).toEqual({
      schedule: { kind: "interval", hours: 168 },
    });
  });

  it("refuses 12-hour times, intervals under an hour and anything else", () => {
    for (const text of ["daily 9pm", "daily 24:00", "weekly someday 09:00", "at noon", ""]) {
      expect(parseRoutineSchedule(text)).toHaveProperty("error");
    }
    expect(parseRoutineSchedule("every 0 hours")).toEqual({
      error: "An interval is 1 to 168 whole hours.",
    });
    expect(parseRoutineSchedule("every 1.5 hours")).toHaveProperty("error");
  });
});

describe("RoutineSchedule", () => {
  it("refuses an interval under the one-hour minimum", () => {
    const decode = Schema.decodeUnknownSync(RoutineSchedule);
    expect(() => decode({ kind: "interval", hours: 0 })).toThrow();
    expect(() => decode({ kind: "daily", time: "9:00" })).toThrow();
    expect(decode({ kind: "interval", hours: 2 })).toEqual({ kind: "interval", hours: 2 });
  });

  it("says a schedule in words, and slugs a name for its feature", () => {
    expect(routineScheduleText({ kind: "weekly", day: "fri", time: "08:00" })).toBe(
      "Fridays at 08:00",
    );
    expect(routineScheduleText({ kind: "interval", hours: 1 })).toBe("Every hour");
    expect(routineSlug("Daily CI triage!")).toBe("routine-daily-ci-triage");
    expect(routineSlug("???")).toBe("routine-run");
  });
});
