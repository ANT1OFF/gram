import type { GitState, TaskChipData } from "@gram/contracts";

/** Where accepting a chip starts its thread, as `task.accept` decides it on the server. */
export type TaskStart =
  | { readonly kind: "worktree"; readonly branch: string | undefined }
  /** `asked`: the chip said `current`. Otherwise there is no commit to branch a worktree from. */
  | { readonly kind: "shared"; readonly asked: boolean };

/**
 * What the chip should promise. It mirrors the server's rule rather than restating the chip's
 * request: outside a git repo, or before a first commit, a task shares the folder whatever it asked
 * for, and saying "new worktree" there would hide the very thing the line is for. `git` is the
 * offering thread's state; while it hasn't arrived the common case is assumed.
 */
export const taskStart = (
  chip: Pick<TaskChipData, "checkout" | "branch" | "base">,
  git: Pick<GitState, "repo" | "head"> | undefined,
): TaskStart => {
  if (chip.checkout === "current") return { kind: "shared", asked: true };
  const nothingToBranch = git !== undefined && (!git.repo || git.head === "");
  if (chip.base === undefined && nothingToBranch) return { kind: "shared", asked: false };
  return { kind: "worktree", branch: chip.branch };
};

export const taskStartLabel = (start: TaskStart): string =>
  start.kind === "worktree"
    ? `${start.branch ?? "new branch"} · new worktree`
    : start.asked
      ? "shares this thread's checkout"
      : "shares this thread's folder · no commit to branch from";
