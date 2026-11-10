import {
  DEFAULT_CHARTER,
  type ProjectId,
  type RoutineId,
  type PinnedWorkerModel,
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
const roster: PinnedWorkerModel[] = [
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

describe("event routines in the form", () => {
  const now = new Date(2026, 10, 5, 12, 0).getTime();
  const base = {
    ...emptyRoutineForm(),
    name: "Review",
    brief: "Review it.",
    when: "event" as const,
  };

  it("makes each event with its few fields, and reads them back", () => {
    const cases: readonly (readonly [Partial<typeof base>, WorkspaceRoutine["on"]])[] = [
      [{ event: "prReady" }, { event: "prReady" }],
      [
        { event: "reviewRequested", repo: " o/r " },
        { event: "reviewRequested", repo: "o/r" },
      ],
      [{ event: "reviewRequested" }, { event: "reviewRequested" }],
      [
        { event: "ciFailed", branch: "release/1.x" },
        { event: "ciFailed", branch: "release/1.x" },
      ],
      [{ event: "ciFailed" }, { event: "ciFailed" }],
      [
        { event: "releasePublished", source: "github", packageName: "o/tool", minAgeDays: "0" },
        { event: "releasePublished", source: "github", name: "o/tool", minAgeDays: 0 },
      ],
    ];
    for (const [patch, on] of cases) {
      const made = routineOfForm({ ...base, ...patch }, none);
      expect(made).toEqual({ routine: { name: "Review", brief: "Review it.", on } });
      if ("routine" in made) {
        const back = formOfRoutine(made.routine);
        expect(back.when).toBe("event");
        expect(routineOfForm(back, none)).toEqual(made);
      }
    }
  });

  it("refuses a bad repository, branch, package or wait", () => {
    expect(routineOfForm({ ...base, event: "reviewRequested", repo: "nope" }, none)).toHaveProperty(
      "error",
    );
    expect(routineOfForm({ ...base, event: "ciFailed", branch: "a..b" }, none)).toHaveProperty(
      "error",
    );
    expect(routineOfForm({ ...base, event: "releasePublished", packageName: "" }, none)).toEqual({
      error: "Name the npm package.",
    });
    expect(
      routineOfForm(
        { ...base, event: "releasePublished", packageName: "x", minAgeDays: "91" },
        none,
      ),
    ).toEqual({ error: "Wait 0 to 90 whole days." });
  });

  it("switches a schedule for an event and back", () => {
    const made = routineOfForm(
      { ...formOfRoutine(triage), when: "event", event: "prReady" },
      {
        ...none,
        editing: triage,
      },
    );
    expect(made).toMatchObject({ routine: { id: "r1", on: { event: "prReady" } } });
    expect("routine" in made ? made.routine.schedule : "refused").toBeUndefined();
  });

  it("says whether it is watching, what waits, or why it can't look", () => {
    const review: WorkspaceRoutine = { name: "Review", brief: "Review.", on: { event: "prReady" } };
    expect(nextRunText(review, {}, now)).toBe("Starts watching");
    expect(nextRunText(review, { trigger: { seeded: true, lookedAt: now - 60_000 } }, now)).toBe(
      "Watching, checked 11:59",
    );
    expect(
      nextRunText(
        review,
        { trigger: { pending: [{ key: "k", at: 0, ref: "o/r#1" }], dropped: 2 } },
        now,
      ),
    ).toBe("3 events waiting");
    expect(
      nextRunText(
        review,
        { trigger: { problem: "Its project has no GitHub origin to watch." } },
        now,
      ),
    ).toBe("Its project has no GitHub origin to watch.");
    // Review of #289, finding 4: why events wait though the routine is on.
    expect(
      nextRunText(
        review,
        {
          trigger: {
            pending: [{ key: "k", at: 0, ref: "o/r#1" }],
            blocked: 'The worker from its last run, "Review", is still live.',
          },
        },
        now,
      ),
    ).toBe('1 event waiting. The worker from its last run, "Review", is still live.');
    expect(lastRunText({ at: now, outcome: "started", events: 2 }, now)).toBe(
      "Last ran 12:00 for 2 events, started a worker",
    );
  });
});
