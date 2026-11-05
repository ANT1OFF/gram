import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { nextRoutineRun, routineScheduleText, WorkspaceRoutines } from "./routines.ts";

const local = (day: number, hours: number, minutes = 0) =>
  new Date(2026, 10, day, hours, minutes).getTime();

// 2026-11-05 is a Thursday.
describe("nextRoutineRun", () => {
  it("runs a daily routine later today, else tomorrow", () => {
    const daily = { every: "day", at: "09:30" } as const;
    expect(nextRoutineRun(daily, local(5, 8))).toBe(local(5, 9, 30));
    expect(nextRoutineRun(daily, local(5, 9, 30))).toBe(local(6, 9, 30));
  });

  it("skips the weekend for a weekday routine", () => {
    const weekdays = { every: "weekday", at: "07:00" } as const;
    expect(nextRoutineRun(weekdays, local(6, 8))).toBe(local(9, 7));
  });

  it("runs a weekly routine on its day, Monday when none is named", () => {
    expect(nextRoutineRun({ every: "week", at: "18:00", day: 4 }, local(5, 19))).toBe(
      local(12, 18),
    );
    expect(nextRoutineRun({ every: "week", at: "18:00" }, local(5, 19))).toBe(local(9, 18));
  });
});

describe("routines", () => {
  it("says a schedule in words", () => {
    expect(routineScheduleText({ every: "day", at: "06:00" })).toBe("every day at 06:00");
    expect(routineScheduleText({ every: "weekday", at: "09:00" })).toBe("weekdays at 09:00");
    expect(routineScheduleText({ every: "week", at: "08:15", day: 5 })).toBe("Fridays at 08:15");
  });

  it("refuses two routines of one name, and more than eight", () => {
    const decode = Schema.decodeUnknownSync(WorkspaceRoutines);
    const routine = { name: "Triage", brief: "Look.", schedule: { every: "day", at: "06:00" } };
    expect(() => decode([routine, { ...routine, name: " triage " }])).toThrow();
    expect(() =>
      decode(Array.from({ length: 9 }, (_, n) => ({ ...routine, name: `r${n}` }))),
    ).toThrow();
    expect(decode([routine])).toEqual([routine]);
  });
});
