import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  parseRoutineSchedule,
  RoutineSchedule,
  routineScheduleText,
  routineSlug,
  withRoutineIds,
  WorkspaceRoutines,
} from "./routines.ts";

describe("routines", () => {
  it("says a schedule in words", () => {
    expect(routineScheduleText({ every: "day", at: "06:00" })).toBe("every day at 06:00");
    expect(routineScheduleText({ every: "weekday", at: "09:00" })).toBe("weekdays at 09:00");
    expect(routineScheduleText({ every: "week", at: "08:15", day: 5 })).toBe("Fridays at 08:15");
    expect(routineScheduleText({ every: "week", at: "08:15" })).toBe("Mondays at 08:15");
    expect(routineScheduleText({ every: "hours", hours: 1 })).toBe("every hour");
    expect(routineScheduleText({ every: "hours", hours: 6 })).toBe("every 6 hours");
  });

  it("refuses two routines of one name or id, and more than eight", () => {
    const decode = Schema.decodeUnknownSync(WorkspaceRoutines);
    const routine = { name: "Triage", brief: "Look.", schedule: { every: "day", at: "06:00" } };
    expect(() => decode([routine, { ...routine, name: " triage " }])).toThrow();
    expect(() =>
      decode([
        { ...routine, id: "r1" },
        { ...routine, name: "Other", id: "r1" },
      ]),
    ).toThrow();
    expect(() =>
      decode(Array.from({ length: 9 }, (_, n) => ({ ...routine, name: `r${n}` }))),
    ).toThrow();
    expect(decode([routine])).toEqual([routine]);
  });

  it("refuses a blank name or brief, a 12-hour time and an interval under an hour", () => {
    const decode = Schema.decodeUnknownSync(WorkspaceRoutines);
    const routine = { name: "Triage", brief: "Look.", schedule: { every: "day", at: "06:00" } };
    expect(() => decode([{ ...routine, name: "   " }])).toThrow();
    expect(() => decode([{ ...routine, brief: " \n " }])).toThrow();
    const schedule = Schema.decodeUnknownSync(RoutineSchedule);
    expect(() => schedule({ every: "day", at: "9:00" })).toThrow();
    expect(() => schedule({ every: "hours", hours: 0 })).toThrow();
    expect(schedule({ every: "hours", hours: 2 })).toEqual({ every: "hours", hours: 2 });
  });

  it("gives each routine an id, keeping the one its name had", () => {
    let n = 0;
    const newId = () => `new-${++n}`;
    const schedule = { every: "day", at: "06:00" } as const;
    const prior = [{ id: "a" as never, name: "Triage", brief: "Look.", schedule }];
    const next = withRoutineIds(
      prior,
      [
        { name: " triage ", brief: "Look again.", schedule },
        { name: "Deps", brief: "Bump.", schedule },
      ],
      newId,
    );
    expect(next?.map((routine) => [routine.id, routine.name])).toEqual([
      ["a", "triage"],
      ["new-1", "Deps"],
    ]);
    // A rename that keeps its id keeps its runs.
    expect(
      withRoutineIds(prior, [{ ...prior[0]!, name: "Renamed" }], newId)?.map((r) => r.id),
    ).toEqual(["a"]);
    expect(withRoutineIds(prior, undefined, newId)).toBeUndefined();
  });
});

describe("parseRoutineSchedule", () => {
  it("reads daily, weekday, weekly and interval schedules on a 24-hour clock", () => {
    expect(parseRoutineSchedule("daily 9:05")).toEqual({ schedule: { every: "day", at: "09:05" } });
    expect(parseRoutineSchedule("weekdays 07:00")).toEqual({
      schedule: { every: "weekday", at: "07:00" },
    });
    expect(parseRoutineSchedule(" Weekly Monday 16:30 ")).toEqual({
      schedule: { every: "week", day: 1, at: "16:30" },
    });
    expect(parseRoutineSchedule("weekly sun 08:00")).toEqual({
      schedule: { every: "week", day: 0, at: "08:00" },
    });
    expect(parseRoutineSchedule("every 1 hour")).toEqual({
      schedule: { every: "hours", hours: 1 },
    });
  });

  it("refuses 12-hour times, intervals under an hour and anything else", () => {
    for (const text of ["daily 9pm", "daily 24:00", "weekly someday 09:00", "at noon", ""]) {
      expect(parseRoutineSchedule(text)).toHaveProperty("error");
    }
    expect(parseRoutineSchedule("every 0 hours")).toEqual({
      error: "An interval is 1 to 168 whole hours.",
    });
  });
});

describe("routineSlug", () => {
  it("slugs a name for its feature, in linear time on a long run of dashes", () => {
    expect(routineSlug("Daily CI triage!")).toBe("routine-daily-ci-triage");
    expect(routineSlug("???")).toBe("routine-run");
    expect(routineSlug("--Nightly -- flake  sweep--")).toBe("routine-nightly-flake-sweep");
    expect(routineSlug(`${"a".repeat(39)} b`)).toBe(`routine-${"a".repeat(39)}`);
    const started = performance.now();
    expect(routineSlug(`a${"-".repeat(100_000)}!`)).toBe("routine-a");
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
