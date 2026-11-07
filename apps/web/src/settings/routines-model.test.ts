import {
  DEFAULT_CHARTER,
  type ProjectId,
  type RoutineId,
  type WorkerModel,
  type WorkspaceRoutine,
} from "@gram/contracts";
import { describe, expect, it } from "vitest";

import {
  emptyRoutineForm,
  formOfRoutine,
  lastRunText,
  nextRunText,
  routineOfForm,
  withRoutines,
} from "./routines-model";

const shop = "p-shop" as ProjectId;
const roster: WorkerModel[] = [
  { agent: "codex", model: "gpt-6.1-sol", useFor: "reviews", default: true },
];
const triage: WorkspaceRoutine = {
  id: "r1" as RoutineId,
  name: "CI triage",
  brief: "Triage main's failing jobs.",
  project: shop,
  schedule: { every: "day", at: "09:00" },
};
const none = { others: [], roster };

describe("routineOfForm", () => {
  it("makes a daily worker routine in the home repo, the time on a 24-hour clock", () => {
    const form = { ...emptyRoutineForm(), name: " CI triage ", brief: "Triage.", at: "7:05" };
    expect(routineOfForm(form, none)).toEqual({
      routine: { name: "CI triage", brief: "Triage.", schedule: { every: "day", at: "07:05" } },
    });
  });

  it("refuses a 12-hour time, a blank name or brief, a taken name and an interval under an hour", () => {
    const form = { ...emptyRoutineForm(), name: "x", brief: "y" };
    expect(routineOfForm({ ...form, at: "9:00 PM" }, none)).toEqual({
      error: "Give the time as HH:MM, on a 24-hour clock.",
    });
    expect(routineOfForm({ ...form, at: "24:00" }, none)).toHaveProperty("error");
    expect(routineOfForm({ ...form, name: "  " }, none)).toEqual({
      error: "Give the routine a name.",
    });
    expect(routineOfForm({ ...form, brief: " " }, none)).toEqual({
      error: "Write the brief it runs with.",
    });
    expect(routineOfForm({ ...form, name: " ci TRIAGE" }, { ...none, others: [triage] })).toEqual({
      error: 'This workspace already has a routine named "ci TRIAGE".',
    });
    expect(routineOfForm({ ...form, every: "hours", hours: "0" }, none)).toEqual({
      error: "Every 1 to 168 hours, in whole hours.",
    });
    expect(routineOfForm({ ...form, every: "hours", hours: "1.5" }, none)).toHaveProperty("error");
  });

  it("keeps a weekday, weekly and interval schedule, a repo, a roster model and an orchestrator target", () => {
    const form = { ...emptyRoutineForm(), name: "Deps", brief: "Check." };
    expect(routineOfForm({ ...form, every: "weekday", at: "08:00" }, none)).toMatchObject({
      routine: { schedule: { every: "weekday", at: "08:00" } },
    });
    expect(routineOfForm({ ...form, every: "week", day: 5, at: "16:30" }, none)).toMatchObject({
      routine: { schedule: { every: "week", day: 5, at: "16:30" } },
    });
    expect(routineOfForm({ ...form, every: "hours", hours: "12" }, none)).toMatchObject({
      routine: { schedule: { every: "hours", hours: 12 } },
    });
    expect(
      routineOfForm({ ...form, project: shop, model: "codex:gpt-6.1-sol" }, none),
    ).toMatchObject({
      routine: { project: shop, model: { agent: "codex", model: "gpt-6.1-sol" } },
    });
    const orchestrator = routineOfForm({ ...form, target: "orchestrator", project: shop }, none);
    expect(orchestrator).toEqual({
      routine: {
        name: "Deps",
        brief: "Check.",
        schedule: { every: "day", at: "09:00" },
        target: "orchestrator",
      },
    });
  });

  it("round-trips a saved routine through its form, keeping its id and whether it is off", () => {
    const saved = {
      ...triage,
      schedule: { every: "week", day: 2, at: "08:15" },
      off: true,
    } as const;
    expect(routineOfForm(formOfRoutine(saved), { ...none, editing: saved })).toEqual({
      routine: saved,
    });
  });
});

describe("withRoutines", () => {
  it("sets the charter's routines, and drops the key when none is left", () => {
    expect(withRoutines(DEFAULT_CHARTER, [triage])).toEqual({
      ...DEFAULT_CHARTER,
      routines: [triage],
    });
    expect(withRoutines({ ...DEFAULT_CHARTER, routines: [triage] }, [])).toEqual(DEFAULT_CHARTER);
  });
});

describe("run lines", () => {
  const now = new Date(2026, 10, 5, 12, 0).getTime();

  it("says the next run in 24-hour time, or why there is none", () => {
    expect(nextRunText(triage, { nextRunAt: new Date(2026, 10, 5, 21, 30).getTime() }, now)).toBe(
      "Next 21:30",
    );
    expect(nextRunText(triage, { nextRunAt: new Date(2026, 10, 6, 9, 0).getTime() }, now)).toBe(
      "Next 6 Nov 09:00",
    );
    expect(nextRunText({ ...triage, off: true }, { nextRunAt: now + 1 }, now)).toBe("Off");
    expect(nextRunText(triage, { nextRunAt: now - 1, waiting: "paused" }, now)).toBe(
      "Waits for the workspace to resume",
    );
  });

  it("says how the last run went", () => {
    const at = new Date(2026, 10, 5, 9, 0).getTime();
    expect(lastRunText({ at, outcome: "started" }, now)).toBe("Last ran 09:00, started a worker");
    expect(lastRunText({ at, outcome: "skipped" }, now)).toBe("Last ran 09:00, skipped");
    expect(lastRunText({ at, outcome: "messaged", manual: true }, now)).toBe(
      "Last ran 09:00 (Run now), woke the orchestrator",
    );
  });
});
