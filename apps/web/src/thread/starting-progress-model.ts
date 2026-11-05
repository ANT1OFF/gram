import type { Checkout, GramUIMessage, ThreadStatus } from "@gram/contracts";

/** Where one step of a fresh session's start is: behind it, under way, or still to come. */
export type StartStepState = "done" | "active" | "pending";

export interface StartStep {
  readonly key: "branch" | "worktree" | "launch" | "first";
  readonly label: string;
  /** The step's object in full (a branch, a path), for the row's tooltip; absent when the label is all. */
  readonly detail?: string;
  readonly state: StartStepState;
}

/** A part that is the agent's output, not the bookkeeping a turn opens with. */
const isOutput = (part: GramUIMessage["parts"][number]): boolean => part.type !== "step-start";

/** Whether the agent has said or done anything yet: any assistant part beyond a step's start. */
export const agentHasOutput = (messages: readonly GramUIMessage[]): boolean =>
  messages.some((message) => message.role === "assistant" && message.parts.some(isOutput));

/**
 * The steps a new thread's first turn goes through before its first output, as far as Gram knows
 * them: the branch and the worktree made for it (only for a worktree checkout, and done by the time
 * the thread exists), the agent's CLI launching (while the session is `starting`), then its first
 * tool or reply (once it runs, `activity` naming it when the agent reported one). `undefined` once the agent
 * has output, or when the thread isn't starting or running a first turn: the row is gone then.
 */
export function startingSteps(input: {
  readonly status: ThreadStatus | undefined;
  readonly checkout: Checkout | undefined;
  readonly agent: string;
  readonly activity: string | undefined;
  readonly messages: readonly GramUIMessage[];
}): readonly StartStep[] | undefined {
  const { status, checkout, agent, activity, messages } = input;
  if (status !== "starting" && status !== "running") return undefined;
  if (agentHasOutput(messages)) return undefined;
  // A thread that answered before (its output since compacted away, say) isn't starting fresh.
  if (!messages.some((message) => message.role === "user")) return undefined;
  const launching = status === "starting";
  const steps: StartStep[] = [];
  if (checkout?.kind === "worktree") {
    if (checkout.branch !== undefined)
      steps.push({ key: "branch", label: "Branch", detail: checkout.branch, state: "done" });
    steps.push({ key: "worktree", label: "Worktree", detail: checkout.path, state: "done" });
  }
  steps.push({
    key: "launch",
    label: launching ? `Starting ${agent}` : `${agent} started`,
    state: launching ? "active" : "done",
  });
  steps.push({
    key: "first",
    label: launching ? "First tool" : (activity ?? "Waiting for its first tool or reply"),
    state: launching ? "pending" : "active",
  });
  return steps;
}
