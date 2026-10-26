import type {
  CleanupPlan,
  ConfirmedRemoval,
  CleanUpResult,
  GitState,
  StorageReport,
  WorktreeList,
  WorktreeRemoval,
  WorktreeSize,
} from "@gram/contracts";

import type { RemoveWorktreeOptions } from "../types";

/** `worktree.*`: a repo's worktrees, their state on disk, and removing one. */
export interface WorktreesApi {
  /** The repo's registered worktrees, main checkout first, with open-in-a-thread and last activity. */
  listWorktrees(repoPath: string): Promise<WorktreeList>;
  /** A worktree's local git state (uncommitted changes, commits not merged to its base). */
  worktreeStatus(path: string): Promise<GitState>;
  /** Permission rules approved in that worktree that the main checkout doesn't have yet. */
  worktreePendingPermissions(path: string): Promise<readonly string[]>;
  /** Bytes a linked worktree takes on disk, `partial` when the count ran out of time. */
  worktreeSize(path: string): Promise<WorktreeSize>;
  /**
   * Deletes a worktree folder; the branch and its commits stay unless `options.deleteBranch`. Rejects
   * with `WorktreeDirty` unless `options.force`, and with `InvalidState` for the main checkout or a
   * worktree a thread has open.
   */
  removeWorktree(path: string, options: RemoveWorktreeOptions): Promise<WorktreeRemoval>;
  /** Every known repo's linked worktrees, grouped for Settings › Storage, and the free disk space. */
  storageReport(): Promise<StorageReport>;
  /** What "Clean up inactive" after `inactiveDays` would remove and free; removes nothing. */
  cleanupPlan(inactiveDays: number): Promise<CleanupPlan>;
  /**
   * Removes the worktrees at `paths`, keeping branches. One a thread uses is kept, and so is one
   * with uncommitted or unpushed work, or not made by Gram, unless `confirmed` names it. `prune`
   * also drops registrations of folders already gone.
   */
  cleanUpWorktrees(
    paths: readonly string[],
    options?: { readonly confirmed?: readonly ConfirmedRemoval[]; readonly prune?: boolean },
  ): Promise<CleanUpResult>;
}
