import type { ProjectId, Routine, RoutineId, WorkspaceId } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import {
  draftOfForm,
  emptyRoutineForm,
  formOfRoutine,
  lastRunText,
  nextRunText,
} from "./routines-model";

const shop = "p-shop" as ProjectId;

const routine = (overrides: Partial<Routine> = {}): Routine => ({
  id: "r1" as RoutineId,
  workspaceId: "w1" as WorkspaceId,
  name: "CI triage",
  brief: "Triage main's failing jobs.",
  target: { kind: "worker", projectId: shop },
  schedule: { kind: "daily", time: "09:00" },
  enabled: true,
  timeZone: "Europe/Oslo",
  createdAt: 0,
  updatedAt: 0,
  createdBy: "user",
  ...overrides,
});

describe("draftOfForm", () => {
  it("makes a daily worker routine from a new form, the time on a 24-hour clock", () => {
    const form = { ...emptyRoutineForm(shop), name: " CI triage ", brief: "Triage.", time: "7:05" };
    expect(draftOfForm(form)).toEqual({
      draft: {
        name: "CI triage",
        brief: "Triage.",
        schedule: { kind: "daily", time: "07:05" },
        target: { kind: "worker", projectId: shop },
      },
    });
  });

  it("refuses a 12-hour time, an empty name or brief, and an interval under an hour", () => {
    const form = { ...emptyRoutineForm(shop), name: "x", brief: "y" };
    expect(draftOfForm({ ...form, time: "9:00 PM" })).toEqual({
      error: "Give the time as HH:MM, on a 24-hour clock.",
    });
    expect(draftOfForm({ ...form, time: "24:00" })).toHaveProperty("error");
    expect(draftOfForm({ ...form, name: "  " })).toEqual({ error: "Give the routine a name." });
    expect(draftOfForm({ ...form, brief: "" })).toEqual({ error: "Write the brief it runs with." });
    expect(draftOfForm({ ...form, every: "interval", hours: "0" })).toEqual({
      error: "Every 1 to 168 hours, in whole hours.",
    });
    expect(draftOfForm({ ...form, every: "interval", hours: "1.5" })).toHaveProperty("error");
  });

  it("keeps a weekly day, an interval, a model and an orchestrator target", () => {
    const form = { ...emptyRoutineForm(shop), name: "Deps", brief: "Check." };
    expect(draftOfForm({ ...form, every: "weekly", day: "fri", time: "16:30" })).toMatchObject({
      draft: { schedule: { kind: "weekly", day: "fri", time: "16:30" } },
    });
    expect(draftOfForm({ ...form, every: "interval", hours: "12" })).toMatchObject({
      draft: { schedule: { kind: "interval", hours: 12 } },
    });
    expect(draftOfForm({ ...form, model: "codex:gpt-6.1-sol" })).toMatchObject({
      draft: { target: { kind: "worker", projectId: shop, model: "codex:gpt-6.1-sol" } },
    });
    expect(draftOfForm({ ...form, target: "orchestrator" })).toMatchObject({
      draft: { target: { kind: "orchestrator" } },
    });
  });

  it("round-trips a saved routine through its form", () => {
    const saved = routine({ schedule: { kind: "weekly", day: "tue", time: "08:15" } });
    expect(draftOfForm(formOfRoutine(saved))).toEqual({
      draft: {
        name: saved.name,
        brief: saved.brief,
        schedule: saved.schedule,
        target: saved.target,
      },
    });
  });
});

describe("run lines", () => {
  const now = new Date(2026, 10, 5, 12, 0).getTime();

  it("says the next run in 24-hour time, or why there is none", () => {
    expect(nextRunText(routine({ nextRunAt: new Date(2026, 10, 5, 21, 30).getTime() }), now)).toBe(
      "Next 21:30",
    );
    expect(nextRunText(routine({ nextRunAt: new Date(2026, 10, 6, 9, 0).getTime() }), now)).toBe(
      "Next 6 Nov 09:00",
    );
    expect(nextRunText(routine({ enabled: false }), now)).toBe("Off");
    expect(nextRunText(routine({ nextRunAt: now - 1, waiting: "paused" }), now)).toBe(
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
