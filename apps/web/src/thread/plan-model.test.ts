import type { PlanStepId, ThreadPlan, ThreadSummary } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { sectionOf } from "@/sidebar/grouping";

import {
  cycleStatus,
  editOf,
  hasPlan,
  moveStep,
  stepPrBadge,
  stripLine,
  stripSteps,
  withStep,
} from "./plan-model";

const id = (s: string) => s as PlanStepId;

const plan: ThreadPlan = {
  goal: "Status lanes",
  steps: [
    { id: id("a"), text: "Lanes by status", status: "done", source: "helper", pr: { number: 204 } },
    { id: id("b"), text: "Fix Parked lane focus", status: "doing", source: "helper" },
    { id: id("c"), text: "Update FEATURES.md", status: "todo", source: "user", locked: true },
  ],
  basis: "",
  updatedAt: 1,
  updatedBy: "helper",
};

describe("the row's plan", () => {
  it("speaks for a plan or a todo list", () => {
    expect(hasPlan(undefined, undefined)).toBe(false);
    expect(hasPlan(undefined, [{ content: "x", status: "pending" }])).toBe(true);
    expect(hasPlan({ ...plan, goal: "", steps: [] }, [])).toBe(false);
  });
});

describe("the header's plan strip", () => {
  it("names the step in progress while working, never the running command", () => {
    const working = {
      phase: "working",
      text: "Step 2 of 3 · Running pnpm test",
      done: 1,
      total: 3,
    } as const;
    expect(stripLine(working, plan.steps)).toBe("Fix Parked lane focus");
    expect(stripLine(working, [{ text: "Lanes", status: "done" }])).toBeUndefined();
    const next = { phase: "next", text: "Next: Update FEATURES.md", done: 1, total: 3 } as const;
    expect(stripLine(next, plan.steps)).toBe("Next: Update FEATURES.md");
    expect(stripLine(undefined, plan.steps)).toBeUndefined();
  });
});

describe("editing a plan", () => {
  it("cycles a status, changes, moves and removes one step and leaves the rest as they were", () => {
    expect(["todo", "doing", "done", "blocked"].map((s) => cycleStatus(s as never))).toEqual([
      "doing",
      "done",
      "todo",
      "todo",
    ]);
    const edit = editOf(plan);
    expect(edit.steps[0]).toEqual({
      id: "a",
      text: "Lanes by status",
      status: "done",
      pr: { number: 204 },
    });
    const changed = withStep(edit, id("b"), (s) => ({ ...s, status: "done" }));
    expect(changed.steps.map((s) => s.status)).toEqual(["done", "done", "todo"]);
    expect(withStep(edit, id("a"), () => undefined).steps.map((s) => s.id)).toEqual(["b", "c"]);
    const moved = moveStep(edit, id("c"), -1);
    expect(moved.steps.map((s) => s.id)).toEqual(["a", "c", "b"]);
    // A move is an edit: the moved step is locked, and so becomes the user's.
    expect(moved.steps[1]?.locked).toBe(true);
    expect(moveStep(edit, id("a"), -1).steps.map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  it("shows the agent's todo list as steps while the plan has none", () => {
    expect(stripSteps(plan, undefined)).toMatchObject({ fromTodo: false, steps: plan.steps });
    const todo = stripSteps({ ...plan, steps: [] }, [
      { content: "Write install", status: "inProgress", activeForm: "Writing install" },
      { content: "Open a PR", status: "pending" },
    ]);
    expect(todo.fromTodo).toBe(true);
    expect(todo.steps.map((s) => [s.text, s.status])).toEqual([
      ["Writing install", "doing"],
      ["Open a PR", "todo"],
    ]);
  });

  it("finds a step's PR badge by number, and by repo when the step names one", () => {
    const badge = { number: 204, url: "https://github.com/acme/web/pull/204" } as never;
    const git = { pr: badge } as unknown as ThreadSummary["git"];
    expect(stepPrBadge(plan.steps[0]!, git)).toBe(badge);
    expect(stepPrBadge({ pr: { number: 204, repo: "acme/api" } }, git)).toBeUndefined();
    expect(stepPrBadge(plan.steps[1]!, git)).toBeUndefined();
  });
});

const summary = (thread: object, extra: Partial<ThreadSummary> = {}) =>
  ({
    thread: { pinned: false, parked: false, lastActivityAt: Date.now(), ...thread },
    status: "idle",
    pendingRequests: [],
    queue: [],
    ...extra,
  }) as unknown as ThreadSummary;

describe("sections with a plan", () => {
  it("keeps a merged thread with work left idle, and settles one whose steps are all done", () => {
    const merged = { completedAt: 1, completedReason: "prMerged" };
    expect(sectionOf(summary(merged))).toBe("settled");
    expect(sectionOf(summary(merged, { plan }))).toBe("idle");
    const finished = { ...plan, steps: plan.steps.map((s) => ({ ...s, status: "done" as const })) };
    expect(sectionOf(summary({}, { plan: finished }))).toBe("settled");
    expect(sectionOf(summary({ completedAt: 1, completedReason: "user" }, { plan }))).toBe(
      "settled",
    );
  });
});
