import {
  planHeadline,
  planText,
  type PlanEdit,
  type PlanHeadline,
  type PlanItem,
  type PlanPhase,
  type PlanStep,
  type PlanStepStatus,
  type PrStatus,
  type ThreadPlan,
  type ThreadSummary,
} from "@gram/contracts";

import { targetBadge } from "@/panels/pr-identity";

/**
 * What a thread's plan looks like on its row and in its header, as pure functions: which headline
 * a summary gives, when a row shows it, and the edits the header strip makes. The headline itself is
 * the contract's rule table (`planHeadline`); nothing here words one.
 */

/** A thread's headline from its summary, the agent's todo list and its live activity line. */
export const headlineOf = (
  summary: Pick<ThreadSummary, "thread" | "status" | "pendingRequests" | "git" | "plan">,
  turnPlan: readonly PlanItem[] | undefined,
  activity: string | undefined,
  now: number,
): PlanHeadline | undefined =>
  planHeadline({
    thread: summary.thread,
    status: summary.status,
    pendingRequests: summary.pendingRequests,
    git: summary.git,
    plan: summary.plan,
    turnPlan,
    activity,
    error: summary.thread.lastError?.text,
    now,
  });

/** The thread keeps a plan the row can speak for: steps of its own, or the agent's todo list. */
export const hasPlan = (
  plan: ThreadPlan | undefined,
  turnPlan: readonly PlanItem[] | undefined,
): boolean =>
  (plan !== undefined && (plan.steps.length > 0 || plan.goal !== "")) ||
  (turnPlan !== undefined && turnPlan.length > 0);

/**
 * What the header's plan strip says after the goal: the step in progress, or the next one to do.
 * Only the step: the PR strip, the approval card and the header's status already say the rest, and
 * the strip's own count stands in for "Step 2 of 4".
 */
export const stripLine = (
  steps: readonly Pick<PlanStep, "text" | "status">[],
): string | undefined => {
  const doing = steps.find((step) => step.status === "doing");
  if (doing !== undefined) return planText(doing.text);
  const next = steps.find((step) => step.status === "todo");
  return next === undefined ? undefined : `Next: ${planText(next.text)}`;
};

/** Where the thread's turn stands, as the plan strip reads it. */
export type StripTurn = "running" | "stopped" | "failed" | "ended";

/**
 * What the plan strip says for where the turn stands, so it never contradicts it: while the turn
 * runs, the step in progress (`stripLine`) and the count; stopped or failed, where it stopped,
 * "Stopped at step 1/4", and the step it was on; ended, what comes next. A plan built from the
 * agent's todo list belongs to the turn that wrote it, so once that turn has ended it isn't shown
 * at all (`undefined`).
 */
export const stripState = (
  steps: readonly Pick<PlanStep, "text" | "status">[],
  turn: StripTurn,
  fromTodo: boolean,
):
  | {
      readonly lead: string | undefined;
      readonly line: string | undefined;
      readonly count: boolean;
    }
  | undefined => {
  if (turn === "running") return { lead: undefined, line: stripLine(steps), count: true };
  if (fromTodo && turn === "ended") return undefined;
  const done = steps.filter((step) => step.status === "done").length;
  const at = `${done}/${steps.length}`;
  const next = steps.find((step) => step.status === "doing" || step.status === "todo");
  // A todo list's step is worded for while it runs ("Reproducing the flake"): left out once stopped.
  const nextLine = next === undefined || fromTodo ? undefined : `Next: ${planText(next.text)}`;
  if (turn === "stopped") return { lead: `Stopped at step ${at}`, line: nextLine, count: false };
  if (turn === "failed") return { lead: `Failed at step ${at}`, line: nextLine, count: false };
  return { lead: undefined, line: nextLine, count: true };
};

/** The tone a phase's text and ring take. */
export const PHASE_TONE: Record<PlanPhase, string> = {
  needsYou: "text-status-needs",
  working: "text-status-working",
  waitingReview: "text-primary",
  waitingCi: "text-primary",
  readyToMerge: "text-success",
  followUp: "text-primary",
  next: "text-muted-foreground",
  done: "text-success",
  stale: "text-muted-foreground",
};

/** A step's status after a click on its glyph: todo → doing → done → todo; blocked and dropped go to todo. */
export const cycleStatus = (status: PlanStepStatus): PlanStepStatus =>
  status === "todo" ? "doing" : status === "doing" ? "done" : "todo";

/** The plan as an edit that changes nothing, for the strip to change one thing in. */
export const editOf = (plan: ThreadPlan | undefined): PlanEdit => ({
  goal: plan?.goal ?? "",
  steps: (plan?.steps ?? []).map((step) => ({
    id: step.id,
    text: step.text,
    status: step.status,
    ...(step.pr === undefined ? {} : { pr: step.pr }),
  })),
});

/** `edit` with the step `id` changed by `f`; `f` answering `undefined` removes it. */
export const withStep = (
  edit: PlanEdit,
  id: PlanStep["id"],
  f: (step: PlanEdit["steps"][number]) => PlanEdit["steps"][number] | undefined,
): PlanEdit => ({
  ...edit,
  steps: edit.steps.flatMap((step) => {
    if (step.id !== id) return [step];
    const next = f(step);
    return next === undefined ? [] : [next];
  }),
});

/**
 * The step `id` moved `by` places, clamped to the list. Moving is an edit like any other, so the
 * step is locked, which makes it the user's (`applyUserEdit`).
 */
export const moveStep = (edit: PlanEdit, id: PlanStep["id"], by: number): PlanEdit => {
  const from = edit.steps.findIndex((step) => step.id === id);
  if (from === -1) return edit;
  const to = Math.max(0, Math.min(edit.steps.length - 1, from + by));
  if (to === from) return edit;
  const steps = [...edit.steps];
  const [moved] = steps.splice(from, 1);
  steps.splice(to, 0, { ...moved!, locked: true });
  return { ...edit, steps };
};

/**
 * The live badge of a step's PR, from the thread's git state: numbers match, and the repo when named.
 * Anchored as the PR strip anchors it (`targetBadge`, `extraRowsOf`): the thread's bound PR and the
 * PRs it follows are those very PRs, while the branch's badge keeps its `headMatches`, so a reused
 * branch name never reads as merged.
 */
export const stepPrBadge = (
  step: Pick<PlanStep, "pr">,
  git: ThreadSummary["git"],
  boundPr?: ThreadSummary["thread"]["boundPr"],
): PrStatus | undefined => {
  const pr = step.pr;
  if (pr === undefined) return undefined;
  const own = git?.pr === undefined ? [] : [targetBadge(git, boundPr) ?? git.pr];
  const followed = (git?.extraPrs ?? []).map((badge) => ({ ...badge, headMatches: true }));
  const badges = [...own, ...followed];
  return badges.find(
    (badge) =>
      badge.number === pr.number &&
      (pr.repo === undefined || badge.url.toLowerCase().includes(`/${pr.repo.toLowerCase()}/`)),
  );
};

/** The steps the strip lists: the plan's, or the agent's todo list shown as steps while it has none. */
export const stripSteps = (
  plan: ThreadPlan | undefined,
  turnPlan: readonly PlanItem[] | undefined,
): { readonly steps: readonly PlanStep[]; readonly fromTodo: boolean } => {
  if (plan !== undefined && plan.steps.length > 0) return { steps: plan.steps, fromTodo: false };
  const status: Record<PlanItem["status"], PlanStepStatus> = {
    pending: "todo",
    inProgress: "doing",
    completed: "done",
    cancelled: "dropped",
  };
  return {
    steps: (turnPlan ?? []).map((item, index) => ({
      id: `todo-${index}` as PlanStep["id"],
      text: item.status === "inProgress" ? (item.activeForm ?? item.content) : item.content,
      status: status[item.status],
      source: "agent",
    })),
    fromTodo: true,
  };
};
