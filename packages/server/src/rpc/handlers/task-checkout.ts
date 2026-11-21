import type { CheckoutRequest, TaskChipData } from "@gram/contracts";

/**
 * The checkout to prepare for `task`, or `undefined` to share the parent's. A worktree of its own
 * unless the chip asked for `current`, branched from `parentHead` so the follow-up sees the parent's
 * commits, which are usually what it follows up on and rarely on `main` yet. `parentHead` is
 * `undefined` when the parent isn't in a git repo with a commit, where there is nothing to branch.
 */
export const taskCheckoutRequest = (
  task: Pick<TaskChipData, "id" | "checkout" | "branch" | "base">,
  parentHead: string | undefined,
): CheckoutRequest | undefined => {
  if (task.checkout === "current") return undefined;
  const base = task.base ?? parentHead;
  if (base === undefined) return undefined;
  return { kind: "newWorktree", branch: task.branch ?? `task-${task.id.slice(0, 8)}`, base };
};
