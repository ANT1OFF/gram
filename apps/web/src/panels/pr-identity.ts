// Which pull request something is about. The thread's binding, the badge in `git.state` and the PR
// detail each describe "a PR", and they change at different moments across bind, rebind, unbind and
// merge. Every place that lines them up goes through here, so they can't disagree about what counts
// as the same PR or about which source wins.
//
// Identity is `owner/repo` plus number: numbers are local to a repository. Precedence is
// binding > badge > detail. The binding decides WHICH PR the thread is about (the server resolves
// every PR call from it); the badge is the freshest word on its state, because it rides every sweep;
// the detail only adds what the badge doesn't carry.

import type { BoundPr, PrStatus } from "@gram/contracts";

/** The two `GitState` fields identity is read from. */
export interface GitPrSource {
  readonly pr?: PrStatus | undefined;
  readonly origin?: string | undefined;
}

export interface PrIdentity {
  /** `owner/repo`; absent only when nothing names it. */
  readonly repo: string | undefined;
  readonly number: number;
}

/** Anything that carries its own canonical URL: a badge or a detail. */
export interface PrLike {
  readonly number: number;
  readonly url: string;
}

const PR_URL = /^https?:\/\/[^/]+\/([\w.-]+\/[\w.-]+)\/pull\/\d+/i;

/** `owner/repo` from a PR URL on any host, GitHub Enterprise included. */
export const repoOfPrUrl = (url: string): string | undefined => PR_URL.exec(url)?.[1];

/**
 * A badge's or detail's identity. Its URL names the repository even when the checkout has no
 * recorded `origin` (the branch lookup resolves it through `gh`), so `origin` is only a fallback.
 */
export const identityOf = (pr: PrLike, origin?: string | undefined): PrIdentity => ({
  repo: repoOfPrUrl(pr.url) ?? origin,
  number: pr.number,
});

/**
 * Same number and same repository, case-insensitively. Number alone is enough only when NEITHER
 * side names a repository; a side that does is never matched by one that doesn't.
 */
export const samePrIdentity = (a: PrIdentity, b: PrIdentity): boolean => {
  if (a.number !== b.number) return false;
  if (a.repo === undefined || b.repo === undefined) return a.repo === b.repo;
  return a.repo.toLowerCase() === b.repo.toLowerCase();
};

/** The PR the server resolves the thread's PR calls to: the bound one, else the branch's. */
export const prTargetOf = (
  git: GitPrSource | undefined,
  boundPr: Pick<BoundPr, "repo" | "number"> | undefined,
): PrIdentity | undefined => {
  if (boundPr) return { repo: boundPr.repo, number: boundPr.number };
  return git?.pr ? identityOf(git.pr, git.origin) : undefined;
};

/** `candidate` when it is the target PR, else nothing: another PR's data is never shown for it. */
export const ifTarget = <T extends PrLike>(
  target: PrIdentity | undefined,
  candidate: T | undefined,
  origin?: string | undefined,
): T | undefined =>
  target !== undefined &&
  candidate !== undefined &&
  samePrIdentity(identityOf(candidate, origin), target)
    ? candidate
    : undefined;

/**
 * The target's badge, anchored when the thread is bound to it. `headMatches` guards a branch lookup
 * against a reused branch name painting a phantom "Merged"; a PR bound by repository and number has
 * no such doubt, and the server leaves its badge unanchored, so without this a bound PR that merged
 * or closed would read as open.
 */
export const targetBadge = (
  git: GitPrSource | undefined,
  boundPr: Pick<BoundPr, "repo" | "number"> | undefined,
): PrStatus | undefined => {
  const badge = ifTarget(prTargetOf(git, boundPr), git?.pr, git?.origin);
  if (badge === undefined || boundPr === undefined) return badge;
  return { ...badge, headMatches: true };
};
