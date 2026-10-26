// When a thread completes on a merge, and when that completion is undone. A merge settles a thread
// once; work since (a commit, new uncommitted changes) or a PR of its still open reopens it; the
// next merge settles it again. Pure over what the publisher last sent the thread, so each case is a
// unit test. The completion rules shared with the web app and the ledger are `completion.ts` in
// contracts; this is only the server's side of them.

import {
  anyPrOpen,
  isBoundBadge,
  MAX_SETTLED_MERGES,
  REOPENABLE_COMPLETIONS,
  samePr,
  samePrMark,
  type GitState,
  type MergeSettle,
  type PrMark,
  type PrStatus,
  type Thread,
} from "@gram/contracts";
import { repoFromPrUrl } from "@gram/git";

/** What the publisher does about a thread's completion after sending it a state. */
export type CompletionStep =
  /** Complete it (`prMerged`) and tell the user `prs` merged. */
  | { readonly kind: "settle"; readonly prs: ReadonlyArray<PrMark>; readonly merge: MergeSettle }
  /** Clear a completion the server made: work resumed, or a PR of its is open. */
  | { readonly kind: "reopen" }
  /** Record `merge` alone: a completion somebody else made. */
  | { readonly kind: "record"; readonly merge: MergeSettle }
  | { readonly kind: "none" };

const NONE: CompletionStep = { kind: "none" };

const markOf = (badge: Pick<PrStatus, "number" | "url">): PrMark => ({
  number: badge.number,
  url: badge.url,
});

/**
 * The checkout's own PR when the thread's badge is a PR bound from elsewhere and this is another: a
 * thread bound to its first PR that opens a second from its branch has both. `checkout` is the
 * checkout's state before `threadState` put the bound PR in.
 */
export const branchPrOf = (
  thread: Pick<Thread, "boundPr" | "extraPrs">,
  checkout: Pick<GitState, "pr" | "origin"> | undefined,
): PrStatus | undefined => {
  const own = checkout?.pr;
  const bound = thread.boundPr;
  if (own === undefined || bound === undefined) return undefined;
  const repo = repoFromPrUrl(own.url) ?? checkout?.origin ?? bound.repo;
  const ref = { repo, number: own.number };
  if (samePr(ref, bound)) return undefined;
  return (thread.extraPrs ?? []).some((extra) => samePr(extra, ref)) ? undefined : own;
};

/**
 * Work since `merge` was recorded: a commit with something not in the base (so switching to the
 * default branch and pulling isn't work, and with no base there is nothing ahead of one), or
 * uncommitted changes that differ from the ones it settled with (so a stray file left over from
 * before isn't either, as long as HEAD stays put).
 */
export const workSince = (
  merge: MergeSettle,
  state: Pick<GitState, "repo" | "head" | "changesToken" | "changedFiles" | "aheadBase">,
): boolean => {
  if (!state.repo || merge.head === undefined) return false;
  // A checkout on the default branch has no base (`resolveBase`), and nothing ahead of one.
  if (state.head !== merge.head && state.aheadBase > 0) return true;
  return (
    merge.changesToken !== undefined &&
    state.changesToken !== merge.changesToken &&
    state.changedFiles > 0
  );
};

/**
 * The step for `thread` now that it was sent `state`. `prs` are all of its PRs (`threadPrBadges`,
 * then its branch's own when that is another), with `undefined` for one not looked up yet and
 * without the ones GitHub says don't exist.
 *
 * 1. A completion the server made is cleared while any PR is open, and a merge's once work resumes.
 * 2. A PR of its merged (the checkout's only if it is the thread's), nothing is open or unknown, and
 *    a merge is in that wasn't when it last settled:
 *    it settles. The agent's or the user's completion stands, and only the merges are recorded, so
 *    reopening it later doesn't complete it on the same merge.
 */
export const completionStep = (
  thread: Pick<Thread, "role" | "boundPr" | "completedAt" | "completedReason" | "settledMerge">,
  state: GitState,
  prs: ReadonlyArray<PrStatus | undefined>,
): CompletionStep => {
  if (thread.role === "orchestrator") return NONE;
  const reason = thread.completedReason;
  const reopenable = reason !== undefined && REOPENABLE_COMPLETIONS.has(reason);
  const recorded = thread.settledMerge;
  if (reopenable && prs.some((pr) => pr?.state === "OPEN")) return { kind: "reopen" };
  if (reason === "prMerged" && recorded !== undefined && workSince(recorded, state)) {
    return { kind: "reopen" };
  }

  if (anyPrOpen(prs)) return NONE;
  // The checkout's PR merged is this thread's merge only if it is the one bound, or the branch
  // still stands where it merged; a followed PR's merge counts whatever the main one did.
  const badge = state.pr;
  const matches =
    thread.boundPr === undefined ? badge?.headMatches : isBoundBadge(badge, thread.boundPr);
  if (badge?.state === "MERGED" && matches !== true) return NONE;
  if (!prs.some((pr) => pr?.state === "MERGED")) return NONE;
  const seen = recorded?.merged ?? [];
  const fresh = prs.flatMap((pr) =>
    pr?.state === "MERGED" && !seen.some((mark) => samePrMark(mark, pr)) ? [markOf(pr)] : [],
  );
  // What it already settled on stays, the PRs it was bound to before a rebind included.
  const merge: MergeSettle = {
    merged: [...seen, ...fresh].slice(-MAX_SETTLED_MERGES),
    ...(state.repo ? { head: state.head, changesToken: state.changesToken } : {}),
  };
  if (fresh.length === 0) return NONE;
  if (thread.completedAt === undefined || reopenable) return { kind: "settle", prs: fresh, merge };
  return { kind: "record", merge };
};
