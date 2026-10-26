import type { GitState, ThreadSummary } from "@gram/contracts";

import type { MergedPrRef } from "@/api/types";

/** The thread's merged PR as `{repo, number}`, or `undefined` when it isn't merged or the repo is unknown. */
export function mergedPrRef(summary: ThreadSummary | undefined): MergedPrRef | undefined {
  const pr = summary?.git?.pr;
  if (pr === undefined || pr.state !== "MERGED") return undefined;
  const bound = summary?.thread.boundPr;
  const repo = bound?.number === pr.number ? bound.repo : summary?.git?.origin;
  return repo === undefined ? undefined : { repo, number: pr.number };
}

/**
 * Whether the published state already says the local branch can go: merged, the local tip on the PR
 * head, nothing past it and nothing uncommitted. Only pre-ticks the option; the server decides.
 */
export function branchDeleteLooksSafe(git: GitState | undefined): boolean {
  const pr = git?.pr;
  return (
    pr !== undefined &&
    pr.state === "MERGED" &&
    pr.headMatches &&
    !pr.aheadOfPr &&
    git?.changedFiles === 0
  );
}

/**
 * Whether the published state says removing the worktree loses nothing: no uncommitted changes, and
 * every commit on a remote (the upstream has them, the PR's head is the tip, or nothing is past the
 * base). Only pre-ticks the close dialog's removal; the server refuses a dirty tree regardless.
 */
export function cleanAndPushed(git: GitState | undefined): boolean {
  if (git?.repo !== true || git.missing === true || git.changedFiles > 0) return false;
  // Local commits the remote branch lacks, whatever the PR's head says.
  if (git.upstream === "ahead" || git.upstream === "diverged" || (git.aheadUpstream ?? 0) > 0) {
    return false;
  }
  if (git.upstream === "synced" || git.upstream === "behind") return true;
  if (git.pr !== undefined && git.pr.headMatches && !git.pr.aheadOfPr) return true;
  return git.upstream === undefined && git.base !== undefined && git.aheadBase === 0;
}
