import type { BoundPr } from "./domain.ts";
import type { PlanStepId } from "./ids.ts";
import {
  MAX_PLAN_STEPS,
  planText,
  type PlanEdit,
  type PlanSource,
  type PlanStep,
  type PlanStepPr,
  type PlanStepStatus,
  type ThreadPlan,
} from "./thread-plan.ts";

/**
 * How each writer changes a thread's plan, as pure functions the server and
 * the mock API share: the user wins over the agent, and both over the helper. A plan with no goal
 * and no steps is no plan.
 */

/** What the plan's writers need beyond their input: the clock and fresh step ids. */
export interface PlanContext {
  readonly now: number;
  readonly newId: () => PlanStepId;
}

/** A step as the agent writes it with `set_plan`. */
export interface AgentStepInput {
  readonly text: string;
  readonly status: PlanStepStatus;
  readonly pr?: number | undefined;
}

export interface AgentPlanInput {
  readonly goal?: string | undefined;
  readonly steps?: ReadonlyArray<AgentStepInput> | undefined;
}

/** A step the agent may not replace: the user's edit, or a step of an orchestrator's brief. */
const userLocked = (step: PlanStep): boolean =>
  (step.source === "user" || step.source === "orchestrator") && step.locked === true;

const sameText = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

const samePlanPr = (a: PlanStepPr | undefined, b: PlanStepPr | undefined): boolean =>
  a?.number === b?.number && a?.repo?.toLowerCase() === b?.repo?.toLowerCase();

/** `plan`, or none at all when it says nothing; its `next` dropped when that step went. */
const settle = (plan: ThreadPlan): ThreadPlan | undefined => {
  if (plan.goal === "" && plan.steps.length === 0) return undefined;
  if (plan.next === undefined || plan.steps.some((s) => s.id === plan.next)) return plan;
  const { next: _gone, ...rest } = plan;
  return rest;
};

const empty = (by: PlanSource, now: number): ThreadPlan => ({
  goal: "",
  steps: [],
  basis: "",
  updatedAt: now,
  updatedBy: by,
});

/** A PR the agent named, as a step's: with the repo of a followed PR of that number, if any. */
const stepPr = (number: number, followed: ReadonlyArray<BoundPr>): PlanStepPr => {
  const match = followed.find((pr) => pr.number === number);
  return match === undefined ? { number } : { number, repo: match.repo };
};

/**
 * The agent's `set_plan`: its goal unless the user wrote one, and its steps in place of the old
 * ones, each locked against the helper. A step the user edited stays the user's, where the agent
 * listed it and where it didn't; one from the orchestrator's brief keeps its wording and place, and
 * takes the status and PR the agent gives it. A step keeps its id when the agent repeats its text.
 */
export const applyAgentPlan = (
  current: ThreadPlan | undefined,
  input: AgentPlanInput,
  followed: ReadonlyArray<BoundPr>,
  { now, newId }: PlanContext,
): ThreadPlan | undefined => {
  const base = current ?? empty("agent", now);
  const goal =
    input.goal === undefined || base.goalBy === "user"
      ? { goal: base.goal, goalBy: base.goalBy }
      : { goal: planText(input.goal), goalBy: "agent" as const };
  let steps: Array<PlanStep> = [...base.steps];
  if (input.steps !== undefined) {
    const used = new Set<PlanStepId>();
    steps = input.steps.slice(0, MAX_PLAN_STEPS).map((step): PlanStep => {
      const text = planText(step.text);
      const match = base.steps.find((old) => !used.has(old.id) && sameText(old.text, text));
      if (match !== undefined) used.add(match.id);
      // The orchestrator's step keeps its wording, and the worker reports how it stands.
      if (match !== undefined && match.source === "orchestrator") {
        const { pr: _pr, evidence: _evidence, ...kept } = match;
        const pr = step.pr === undefined ? match.pr : stepPr(step.pr, followed);
        return { ...kept, status: step.status, ...(pr === undefined ? {} : { pr }) };
      }
      if (match !== undefined && userLocked(match)) return match;
      return {
        id: match?.id ?? newId(),
        text,
        status: step.status,
        source: "agent",
        locked: true,
        ...(step.pr === undefined ? {} : { pr: stepPr(step.pr, followed) }),
      };
    });
    // The user's steps the agent left out keep their place.
    base.steps.forEach((old, index) => {
      if (userLocked(old) && !used.has(old.id)) steps.splice(Math.min(index, steps.length), 0, old);
    });
    // Over the cap, the agent's last steps give way: the user's are never dropped to make room.
    while (steps.length > MAX_PLAN_STEPS) {
      const last = steps.findLastIndex((step) => !userLocked(step));
      steps.splice(last === -1 ? steps.length - 1 : last, 1);
    }
  }
  const { goalBy: _goalBy, ...rest } = base;
  return settle({
    ...rest,
    goal: goal.goal,
    ...(goal.goalBy === undefined ? {} : { goalBy: goal.goalBy }),
    steps,
    updatedAt: now,
    updatedBy: "agent",
  });
};

/**
 * The user's edit: the steps it lists, in its order. One whose text, status or PR changed, and a
 * new one, become the user's and are locked unless the edit says `locked: false`; an untouched
 * step stays as it was, its lock set or lifted when the edit says so.
 */
export const applyUserEdit = (
  current: ThreadPlan | undefined,
  edit: PlanEdit,
  { now, newId }: PlanContext,
): ThreadPlan | undefined => {
  const base = current ?? empty("user", now);
  const goal = planText(edit.goal);
  const steps = edit.steps.slice(0, MAX_PLAN_STEPS).map((step): PlanStep => {
    const old = step.id === undefined ? undefined : base.steps.find((s) => s.id === step.id);
    const text = planText(step.text);
    const untouched =
      old !== undefined &&
      old.text === text &&
      old.status === step.status &&
      samePlanPr(old.pr, step.pr);
    if (untouched) {
      if (step.locked === undefined || step.locked === (old.locked === true)) return old;
      const { locked: _locked, ...unlocked } = old;
      // Locking a step, or moving it, which locks it, makes it the user's.
      return step.locked ? { ...unlocked, source: "user", locked: true } : unlocked;
    }
    return {
      id: old?.id ?? newId(),
      text,
      status: step.status,
      source: "user",
      ...(step.locked === false ? {} : { locked: true }),
      ...(step.pr === undefined ? {} : { pr: step.pr }),
    };
  });
  const { goalBy: _goalBy, ...rest } = base;
  const goalBy = goal === base.goal ? base.goalBy : "user";
  return settle({
    ...rest,
    goal,
    ...(goalBy === undefined ? {} : { goalBy }),
    steps,
    updatedAt: now,
    updatedBy: "user",
  });
};

/**
 * The goal the agent keeps itself (Codex's `thread/goal`), unless the user wrote one. Cleared, it
 * takes the agent's goal away and leaves anybody else's.
 */
export const applyAgentGoal = (
  current: ThreadPlan | undefined,
  objective: string | undefined,
  now: number,
): ThreadPlan | undefined => {
  if (current?.goalBy === "user") return current;
  if (objective === undefined) {
    if (current === undefined || current.goalBy !== "agent") return current;
    const { goalBy: _goalBy, ...rest } = current;
    return settle({ ...rest, goal: "", updatedAt: now, updatedBy: "agent" });
  }
  const goal = planText(objective);
  if (current?.goal === goal) return current;
  return settle({
    ...(current ?? empty("agent", now)),
    goal,
    goalBy: "agent",
    updatedAt: now,
    updatedBy: "agent",
  });
};

/**
 * An orchestrator's checklist from a worker's brief, at the head of the worker's plan: every step
 * locked and the orchestrator's, like the user's, so neither the agent nor the helper rewrites its
 * words. A step the worker already listed with the same text becomes the brief's, keeping how it
 * stands, so a `set_plan` that raced the seed loses nothing. The user's steps are never dropped.
 */
export const seedOrchestratorPlan = (
  current: ThreadPlan | undefined,
  steps: ReadonlyArray<string>,
  { now, newId }: PlanContext,
): ThreadPlan | undefined => {
  const texts = steps.map(planText).filter((text) => text !== "");
  if (texts.length === 0) return current;
  const base = current ?? empty("orchestrator", now);
  const used = new Set<PlanStepId>();
  const seeded = texts.map((text): PlanStep => {
    const match = base.steps.find((s) => !used.has(s.id) && sameText(s.text, text));
    if (match !== undefined) used.add(match.id);
    // The user's own step of that text stays the user's.
    if (match !== undefined && match.source === "user" && match.locked === true) return match;
    return {
      id: match?.id ?? newId(),
      text,
      status: match?.status ?? "todo",
      source: "orchestrator",
      locked: true,
      ...(match?.pr === undefined ? {} : { pr: match.pr }),
    };
  });
  let merged = [...seeded, ...base.steps.filter((s) => !used.has(s.id))];
  // Over the cap, unlocked steps go first, then the brief's last items; the user's never do.
  const drop = (keep: (step: PlanStep) => boolean) => {
    while (merged.length > MAX_PLAN_STEPS) {
      const last = merged.findLastIndex((step) => !keep(step));
      if (last === -1) return;
      merged = merged.toSpliced(last, 1);
    }
  };
  drop((step) => step.locked === true);
  drop((step) => step.source === "user" && step.locked === true);
  return settle({ ...base, steps: merged, updatedAt: now, updatedBy: "orchestrator" });
};
