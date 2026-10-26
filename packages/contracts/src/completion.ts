// What "finished" and "merged" mean, in one place: the sidebar, the orchestration tree, the ledger
// and the publisher's settle all read a thread's PRs through these, so a row can't say merged while
// the ledger says in review. Pure functions over wire shapes; nothing here is stored.

import { samePr, samePrMark, type BoundPr, type CompletedReason, type Thread } from "./domain.ts";
import { mergeStateAllowsMerge, requiredChecksGreen, type GitState, type PrStatus } from "./git.ts";
import type { WorkerState } from "./orchestration.ts";

/** A PR as the completion rules read it. */
export interface PrFacts {
  readonly state: "open" | "merged" | "closed";
  /** Required checks are passing, or there are none to wait for. */
  readonly checksGreen: boolean;
  /** A review bot approved the head commit. */
  readonly approvedOnHead: boolean;
  /** GitHub would let it merge: no conflicts, nothing else required. */
  readonly mergeable: boolean;
}

/**
 * A PR badge as the facts `workerState` reads. The mapping is babysit's finish line
 * (`isReadyToMerge`): `passing` or `none` required checks are green, the verdict is
 * `review.verdictOnHead`, and the merge state must be `CLEAN` or `UNSTABLE`, except that a badge
 * from a fetch path that doesn't report one is given the benefit of the doubt. A draft is never
 * mergeable.
 */
export const prFactsOf = (
  badge: Pick<
    PrStatus,
    "state" | "checks" | "requiredChecks" | "isDraft" | "mergeState" | "review"
  >,
): PrFacts => ({
  state: badge.state === "MERGED" ? "merged" : badge.state === "CLOSED" ? "closed" : "open",
  checksGreen: requiredChecksGreen(badge),
  approvedOnHead: badge.review?.verdictOnHead === "approved",
  mergeable:
    !badge.isDraft && (badge.mergeState === undefined || mergeStateAllowsMerge(badge.mergeState)),
});

/**
 * Several PRs read as one: `undefined` stands for a PR that is bound but whose badge hasn't been
 * looked up yet. A closed, unmerged PR counts as no PR, as it does for a single one. What is left is
 * `merged` only when every one of them is, and otherwise `open` with each fact true only when it
 * holds for every PR still open, so a worker is `readyToMerge` when nothing of its change is left
 * waiting anywhere. A PR not yet looked up is open and proves nothing, which holds a worker at
 * `inReview` rather than guessing.
 */
export const combinePrFacts = (prs: ReadonlyArray<PrFacts | undefined>): PrFacts | undefined => {
  const unknown: PrFacts = {
    state: "open",
    checksGreen: false,
    approvedOnHead: false,
    mergeable: false,
  };
  const counted = prs.map((pr) => pr ?? unknown).filter((pr) => pr.state !== "closed");
  if (counted.length === 0) {
    return prs.length === 0 ? undefined : { ...unknown, state: "closed" };
  }
  const open = counted.filter((pr) => pr.state === "open");
  if (open.length === 0) {
    return { state: "merged", checksGreen: true, approvedOnHead: true, mergeable: true };
  }
  return {
    state: "open",
    checksGreen: open.every((pr) => pr.checksGreen),
    approvedOnHead: open.every((pr) => pr.approvedOnHead),
    mergeable: open.every((pr) => pr.mergeable),
  };
};

const PR_URL = /^https?:\/\/[^/]+\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/i;

/** Whether `badge` is `pr`'s: numbers are local to a repository, so the same one elsewhere isn't. */
const isBadgeOf = (
  badge: Pick<PrStatus, "number" | "url">,
  pr: Pick<BoundPr, "repo" | "number">,
) => {
  const repo = PR_URL.exec(badge.url)?.[1];
  return repo !== undefined && samePr({ repo, number: badge.number }, pr);
};

/**
 * Whether `badge` is the thread's bound PR `bound`, by repo and number: the same number in another
 * repository is another PR. A URL that names no repo is taken on its number.
 */
export const isBoundBadge = (
  badge: Pick<PrStatus, "number" | "url"> | undefined,
  bound: Pick<BoundPr, "repo" | "number">,
): boolean => {
  if (badge === undefined) return false;
  const repo = PR_URL.exec(badge.url)?.[1];
  return repo === undefined
    ? badge.number === bound.number
    : samePr({ repo, number: badge.number }, bound);
};

/**
 * A thread's PRs as its published git state carries them: `git.pr`, then one entry per
 * `thread.extraPrs`, with `undefined` for a bound PR whose badge hasn't landed: the main one too,
 * whose place `git.pr` holds only once it is that PR (`isBoundBadge`). One GitHub says doesn't
 * exist (`git.missingPrs`) is left out.
 */
export const threadPrBadges = (
  thread: Pick<Thread, "boundPr" | "extraPrs">,
  git: Pick<GitState, "pr" | "extraPrs" | "missingPrs"> | undefined,
): ReadonlyArray<PrStatus | undefined> => {
  const gone = (pr: Pick<BoundPr, "repo" | "number">) =>
    git?.missingPrs?.some((missing) => samePr(missing, pr)) === true;
  const bound = thread.boundPr;
  return [
    ...(bound !== undefined && !isBoundBadge(git?.pr, bound)
      ? gone(bound)
        ? []
        : [undefined]
      : git?.pr === undefined
        ? []
        : [git.pr]),
    ...(thread.extraPrs ?? []).flatMap((extra) =>
      gone(extra) ? [] : [git?.extraPrs?.find((badge) => isBadgeOf(badge, extra))],
    ),
  ];
};

/**
 * Open-PR-wins: whether any of a thread's PRs is still open, counting one not looked up yet as
 * open. While this holds, the thread is not merged, whatever its completion says.
 */
export const anyPrOpen = (prs: ReadonlyArray<Pick<PrStatus, "state"> | undefined>): boolean =>
  prs.some((pr) => pr === undefined || pr.state === "OPEN");

/**
 * Reopened since its merges: no completion, and every PR of its that has merged is one it already
 * settled on (`settledMerge`), so the merged badges it still carries are old news. Work resumed, or
 * somebody reopened it; a merge it hasn't seen yet is news again.
 */
export const reopenedSinceMerge = (
  thread: Pick<Thread, "completedAt" | "settledMerge">,
  prs: ReadonlyArray<Pick<PrStatus, "state" | "number" | "url"> | undefined>,
): boolean => {
  const settled = thread.settledMerge?.merged;
  if (thread.completedAt !== undefined || settled === undefined) return false;
  return prs.every((pr) => pr?.state !== "MERGED" || settled.some((mark) => samePrMark(mark, pr)));
};

/**
 * Merged, with nothing left: one of its PRs merged, or the thread was completed on a merge, no PR
 * it follows is still open, and it hasn't been reopened since (`reopenedSinceMerge`).
 */
export const mergedAndDone = (
  thread: Pick<Thread, "completedAt" | "completedReason" | "settledMerge">,
  prs: ReadonlyArray<Pick<PrStatus, "state" | "number" | "url"> | undefined>,
): boolean =>
  (thread.completedReason === "prMerged" || prs.some((pr) => pr?.state === "MERGED")) &&
  !anyPrOpen(prs) &&
  !reopenedSinceMerge(thread, prs);

/**
 * Worker states whose work is over: it takes no place under the concurrency cap, no part in
 * overlap, and `list_workers`' `since` leaves it out once it has gone quiet. It stays on the board
 * until it is archived.
 */
export const FINISHED_STATES: ReadonlySet<WorkerState> = new Set<WorkerState>([
  "delivered",
  "merged",
  "archived",
]);

/**
 * Completions the server made rather than somebody's word, so work resuming clears them: a merge.
 * `agent` and `user` completions stay until one of them reopens the thread.
 */
export const REOPENABLE_COMPLETIONS: ReadonlySet<CompletedReason> = new Set<CompletedReason>([
  "prMerged",
]);

/** `thread` with no completion. `settledMerge` stays, so the merges it records don't complete it again. */
export const withoutCompletion = (thread: Thread): Thread => {
  const { completedAt, completedReason, ...rest } = thread;
  void completedAt;
  void completedReason;
  return rest;
};
