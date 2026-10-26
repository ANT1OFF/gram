import * as Schema from "effect/Schema";
import { PlanStepId } from "./ids.ts";

/**
 * A thread's plan: the goal of the whole thread and the steps across its
 * turns and PRs. Unlike the agent's todo list (`PlanItem`), which lasts a turn, it persists, and the
 * agent (`set_plan`), the user and the helper model all write it, in that order of precedence under
 * the facts.
 */

/** The longest a goal or a step's text is kept. */
export const PLAN_TEXT_MAX = 80;
/** The most steps a plan holds. */
export const MAX_PLAN_STEPS = 8;

export const PlanStepStatus = Schema.Literals(["todo", "doing", "done", "blocked", "dropped"]);
export type PlanStepStatus = typeof PlanStepStatus.Type;

/** Who wrote a step: the agent (`set_plan`), the helper model, the user, or an orchestrator's brief. */
export const PlanSource = Schema.Literals(["agent", "helper", "user", "orchestrator"]);
export type PlanSource = typeof PlanSource.Type;

/** A PR a step is about. Its state is read live from the thread's git state, never stored here. */
export const PlanStepPr = Schema.Struct({
  number: Schema.Int,
  /** `owner/repo`; absent for the thread's own repo. */
  repo: Schema.optionalKey(Schema.String),
});
export type PlanStepPr = typeof PlanStepPr.Type;

const PlanText = Schema.String.check(Schema.isMaxLength(PLAN_TEXT_MAX));

export const PlanStep = Schema.Struct({
  id: PlanStepId,
  text: PlanText,
  status: PlanStepStatus,
  source: PlanSource,
  /** Frozen for the helper: the user edited it, or the agent wrote it with `set_plan`. */
  locked: Schema.optionalKey(Schema.Boolean),
  pr: Schema.optionalKey(PlanStepPr),
  /** Why it has this status, short and quote-free ("tests passed in turn 7", "#204 merged"). */
  evidence: Schema.optionalKey(PlanText),
});
export type PlanStep = typeof PlanStep.Type;

export const ThreadPlan = Schema.Struct({
  /** What the whole thread is for; empty until somebody says. */
  goal: PlanText,
  /** Who wrote the goal: a user's is kept against the agent and the helper. */
  goalBy: Schema.optionalKey(PlanSource),
  steps: Schema.Array(PlanStep).check(Schema.isMaxLength(MAX_PLAN_STEPS)),
  /** The step to do next, when whoever wrote the plan said; else the first open one. */
  next: Schema.optionalKey(PlanStepId),
  /** What the helper saw last (`feed_rev`, the PR facts, the agent plan), so an unchanged thread costs no call. */
  basis: Schema.String,
  /** Epoch ms. */
  updatedAt: Schema.Number,
  updatedBy: PlanSource,
});
export type ThreadPlan = typeof ThreadPlan.Type;

/** A step still to do: neither done nor dropped. */
export const openStep = (step: Pick<PlanStep, "status">): boolean =>
  step.status !== "done" && step.status !== "dropped";

/** Steps done out of those that count; a dropped step doesn't. */
export const planProgress = (
  plan: Pick<ThreadPlan, "steps">,
): { readonly done: number; readonly total: number } => {
  const counted = plan.steps.filter((step) => step.status !== "dropped");
  return {
    done: counted.filter((step) => step.status === "done").length,
    total: counted.length,
  };
};

/** The step to do next: the plan's `next` while it is open, else the one in progress, else the first open one. */
export const nextStep = (plan: Pick<ThreadPlan, "steps" | "next">): PlanStep | undefined => {
  const named = plan.next === undefined ? undefined : plan.steps.find((s) => s.id === plan.next);
  if (named !== undefined && openStep(named)) return named;
  return plan.steps.find((s) => s.status === "doing") ?? plan.steps.find(openStep);
};

/** `text` on one line, trimmed and cut to `PLAN_TEXT_MAX` with an ellipsis. */
export const planText = (text: string): string => {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length <= PLAN_TEXT_MAX ? line : `${line.slice(0, PLAN_TEXT_MAX - 1).trimEnd()}…`;
};

/** A step as the user writes it (`thread.setPlan`): the server fills in who and when. */
export const PlanStepEdit = Schema.Struct({
  /** Absent for a new step. */
  id: Schema.optionalKey(PlanStepId),
  text: Schema.NonEmptyString,
  status: PlanStepStatus,
  /** False hands the step back to the helper ("Let the helper update this"); absent keeps it the user's. */
  locked: Schema.optionalKey(Schema.Boolean),
  pr: Schema.optionalKey(PlanStepPr),
});
export type PlanStepEdit = typeof PlanStepEdit.Type;

/** The plan as the user edited it; every step in it, in order. */
export const PlanEdit = Schema.Struct({
  goal: Schema.String,
  steps: Schema.Array(PlanStepEdit).check(Schema.isMaxLength(MAX_PLAN_STEPS)),
});
export type PlanEdit = typeof PlanEdit.Type;
