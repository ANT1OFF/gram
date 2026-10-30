import { headPushed, type GitState, type ThreadSummary } from "@gram/contracts";

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
 * every commit on a remote by the sweep's own rule (`headPushed`). Only pre-ticks the close dialog's
 * removal; the server asks git again and refuses a dirty tree regardless.
 */
export function cleanAndPushed(git: GitState | undefined): boolean {
  if (git?.repo !== true || git.missing === true || git.changedFiles > 0) return false;
  return headPushed({
    head: git.head,
    headOnRemote: git.headOnRemote === true,
    prHeadRefOid: git.pr?.headRefOid,
  });
}
