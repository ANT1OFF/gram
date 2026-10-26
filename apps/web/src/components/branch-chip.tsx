import type { GitState, Thread } from "@gram/contracts";

/** Whether the thread runs in a linked worktree: the published git state, else its launch checkout. */
export const isWorktreeCheckout = (thread: Thread, git: GitState | undefined): boolean =>
  git?.worktree ?? thread.checkout.kind === "worktree";
