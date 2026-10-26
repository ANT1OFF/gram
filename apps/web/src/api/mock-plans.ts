import type { PlanSource, PlanStep, PlanStepId, PlanStepStatus, ThreadPlan } from "@gram/contracts";

/**
 * The seeded threads' plans, as the agent, the helper and the user left them. The threads with a
 * PR, or that get one, have none: a plan takes the PR badge off the row, where specs click it.
 */

const step = (
  id: string,
  text: string,
  status: PlanStepStatus,
  source: PlanSource,
  extra: Partial<Pick<PlanStep, "locked" | "pr" | "evidence">> = {},
): PlanStep => ({
  id: id as PlanStepId,
  text,
  status,
  source,
  ...(source === "agent" || source === "user" ? { locked: true } : {}),
  ...extra,
});

const plan = (
  goal: string,
  steps: readonly PlanStep[],
  updatedAt: number,
  updatedBy: PlanSource = "helper",
): ThreadPlan => ({
  goal,
  goalBy: updatedBy === "agent" ? "agent" : "helper",
  steps,
  basis: "rev=0;n=0",
  updatedAt,
  updatedBy,
});

export const mockPlans = (minutes: (n: number) => number): Record<string, ThreadPlan> => ({
  "t-question": plan(
    "Pick and wire up a date library",
    [
      step("q1", "Compare date-fns, Luxon and Temporal", "done", "agent"),
      step("q2", "Pick one with you", "doing", "helper"),
      step("q3", "Replace moment in the picker", "todo", "agent"),
    ],
    minutes(12),
  ),
  "t-docs": plan(
    "Rewrite the README for new contributors",
    [
      step("d1", "Outline the new README", "done", "agent"),
      step("d2", "Write install and first run", "doing", "agent"),
      step("d3", "Move the architecture notes to docs/", "todo", "agent"),
      step("d4", "Open a PR", "todo", "helper"),
    ],
    minutes(1),
    "agent",
  ),
  "t-deps": plan(
    "Bump the API's dependencies",
    [
      step("p1", "Bump runtime dependencies", "done", "agent", { evidence: "unit tests pass" }),
      step("p2", "Fix the two type errors from zod 4", "done", "agent"),
      step("p3", "Run e2e against Vite 8.3", "todo", "helper"),
    ],
    minutes(55),
  ),
  "t-release": plan(
    "Ship 0.7.0",
    [
      step("r1", "Cut rc1 to rc4", "done", "user"),
      step("r2", "Fix the Codex smoke on rc3", "done", "helper", { evidence: "rc4 smoke passed" }),
      step("r3", "Review What's New against the UI", "done", "helper", {
        evidence: "user said so",
      }),
      step("r4", "Check release settings", "done", "helper", { evidence: "script reported ok" }),
      step("r5", "Soak rc5 for a day", "doing", "user"),
      step("r6", "Merge the release PR", "todo", "user"),
    ],
    minutes(240),
  ),
});
