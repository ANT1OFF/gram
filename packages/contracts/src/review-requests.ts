import * as Schema from "effect/Schema";
import type { Thread } from "./domain.ts";
import { ChecksRollup, repoFromPrUrl, type GitState } from "./git.ts";
import type { ThreadId } from "./ids.ts";
import { ReviewVerdict } from "./review.ts";

/** A configured review bot's latest summary review of the PR; dismissed ones don't count. */
export const ReviewRequestBot = Schema.Struct({
  verdict: ReviewVerdict,
  /** The review is of the PR's head commit, so nothing was pushed since. */
  onHead: Schema.Boolean,
});
export type ReviewRequestBot = typeof ReviewRequestBot.Type;

/** Optional presentation data from the existing batched details read. Old payloads omit it. */
const PrInformation = {
  isBot: Schema.optionalKey(Schema.Boolean),
  labels: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Total labels, including any beyond the bounded read. */
  labelsCount: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  additions: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  deletions: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  /** GitHub updatedAt seen by the supplementary read; badges do not refresh this. */
  informationAt: Schema.optionalKey(Schema.String),
  informationStale: Schema.optionalKey(Schema.Boolean),
  /** A failed lookup carried these statuses; a successful search is not a details refresh. */
  detailsStale: Schema.optionalKey(Schema.Boolean),
};

/** An open pull request whose review is requested from the signed-in `gh` user. */
export const ReviewRequest = Schema.Struct({
  ...PrInformation,
  isDraft: Schema.optionalKey(Schema.Boolean),
  headRef: Schema.optionalKey(Schema.String),
  mergeState: Schema.optionalKey(Schema.String),
  detailsAt: Schema.optionalKey(Schema.String),
  /** `owner/name`. */
  repo: Schema.String,
  number: Schema.Int,
  title: Schema.String,
  url: Schema.String,
  /** The author's login; empty when GitHub reports none. */
  author: Schema.String,
  /** ISO-8601. */
  updatedAt: Schema.String,
  /** ISO-8601; absent when GitHub reports none. */
  createdAt: Schema.optionalKey(Schema.String),
  /** The head commit's checks. This and the two below are absent until a details lookup lands. */
  checks: Schema.optionalKey(ChecksRollup),
  /** APPROVED / CHANGES_REQUESTED / REVIEW_REQUIRED; absent when GitHub reports none. */
  reviewDecision: Schema.optionalKey(Schema.String),
  /** Absent when no configured bot has reviewed the PR. */
  bot: Schema.optionalKey(ReviewRequestBot),
  /** A known project whose origin is `repo`, so the PR can be checked out there. */
  projectRoot: Schema.optionalKey(Schema.String),
});
export type ReviewRequest = typeof ReviewRequest.Type;

/** What a review request's notification waits for; with both off it is raised at once. */
export interface ReviewRequestHolds {
  readonly checks: boolean;
  readonly bot: boolean;
}

/**
 * Whether `holds` let the PR's notification through. Checks count once they pass, or when the PR
 * has none. A bot counts once its review is of the head commit and doesn't request changes, so a PR
 * no configured bot reviews stays held. A PR whose details lookup hasn't landed is held too.
 */
export const reviewRequestReady = (
  request: Pick<ReviewRequest, "checks" | "bot">,
  holds: ReviewRequestHolds,
): boolean => {
  if (holds.checks && request.checks !== "passing" && request.checks !== "none") return false;
  if (holds.bot && !(request.bot?.onHead === true && request.bot.verdict !== "changesRequested")) {
    return false;
  }
  return true;
};

/** `reviewRequests.list`: the last result of the review-request poll. */
export const ReviewRequests = Schema.Struct({
  /** Most recently updated first. */
  requests: Schema.Array(ReviewRequest),
  /** Epoch ms of the last successful poll; absent until one succeeds. */
  checkedAt: Schema.optionalKey(Schema.Number),
});
export type ReviewRequests = typeof ReviewRequests.Type;

/**
 * An open pull request the signed-in `gh` user authored, drafts included: the sidebar's Open PRs.
 * Polled with the review requests, so it shares their checks, review decision and bot verdict.
 */
export const OwnPr = Schema.Struct({
  ...PrInformation,
  author: Schema.optionalKey(Schema.String),
  /** `owner/name`. */
  repo: Schema.String,
  number: Schema.Int,
  title: Schema.String,
  url: Schema.String,
  isDraft: Schema.Boolean,
  /**
   * ISO-8601: the later of GitHub's `updatedAt` as the search and the details lookup saw it, the
   * read `isDraft` comes from. A thread's badge that saw a later one knows the PR's state better.
   */
  updatedAt: Schema.String,
  /**
   * GitHub's `updatedAt` as the details lookup saw it, which is when the checks, merge state and
   * reviews below were read: older than `updatedAt` when the lookup was refused and its details
   * carried. Absent until a lookup lands.
   */
  detailsAt: Schema.optionalKey(Schema.String),
  /** `headRefOid` as the same lookup read it: the commit `bot.onHead` speaks of. */
  headOid: Schema.optionalKey(Schema.String),
  /** ISO-8601; absent when GitHub reports none. */
  createdAt: Schema.optionalKey(Schema.String),
  /**
   * `headRefName`, by which a thread on that branch owns the PR. This and the rest below are absent
   * until a details lookup lands.
   */
  headRef: Schema.optionalKey(Schema.String),
  /** GitHub's `mergeStateStatus`, e.g. CLEAN / BLOCKED / BEHIND / DIRTY. */
  mergeState: Schema.optionalKey(Schema.String),
  checks: Schema.optionalKey(ChecksRollup),
  /** APPROVED / CHANGES_REQUESTED / REVIEW_REQUIRED; absent when GitHub reports none. */
  reviewDecision: Schema.optionalKey(Schema.String),
  /** Absent when no configured bot has reviewed the PR. */
  bot: Schema.optionalKey(ReviewRequestBot),
  /** A known project whose origin is `repo`. */
  projectRoot: Schema.optionalKey(Schema.String),
});
export type OwnPr = typeof OwnPr.Type;

/** `openPrs.list`: the user's open PRs, as the review-request poll last found them. */
export const OwnPrs = Schema.Struct({
  /** Most recently updated first. */
  prs: Schema.Array(OwnPr),
  /** Epoch ms of the last successful search; absent until one succeeds. */
  checkedAt: Schema.optionalKey(Schema.Number),
});
export type OwnPrs = typeof OwnPrs.Type;

/** What `prOwner` knows of a thread that may own a PR. */
export interface PrOwnerCandidate {
  readonly threadId: ThreadId;
  /** The PRs the thread is bound to or follows, or carries a badge for. */
  readonly prs: ReadonlyArray<{ readonly repo: string; readonly number: number }>;
  /** The branch its checkout is on. */
  readonly branch?: string | undefined;
  /** Its checkout's origin, `owner/name`. */
  readonly origin?: string | undefined;
}

/**
 * What `prOwner` knows of `thread`, from its live git state where there is one: the branch it is on
 * now, which needn't be the one its checkout was made on, and the badges that state carries.
 * `origin` stands in while no state has been published. `undefined` for an orchestrator or a
 * dream, which follow no PR of their own whatever branch they are on.
 */
export const prOwnerCandidate = (
  thread: Pick<Thread, "id" | "role" | "boundPr" | "extraPrs" | "checkout" | "currentCheckout">,
  git: Pick<GitState, "branch" | "origin" | "pr" | "extraPrs"> | undefined,
  origin?: string | undefined,
): PrOwnerCandidate | undefined => {
  if (thread.role !== undefined) return undefined;
  const badges = [...(git?.pr === undefined ? [] : [git.pr]), ...(git?.extraPrs ?? [])];
  return {
    threadId: thread.id,
    prs: [
      ...(thread.boundPr === undefined ? [] : [thread.boundPr]),
      ...(thread.extraPrs ?? []),
      ...badges.flatMap((badge) => {
        const repo = repoFromPrUrl(badge.url);
        return repo === undefined ? [] : [{ repo, number: badge.number }];
      }),
    ],
    branch: git === undefined ? (thread.currentCheckout ?? thread.checkout).branch : git.branch,
    origin: git?.origin ?? origin,
  };
};

/**
 * The thread that owns `pr`: the first candidate bound to it or carrying its badge, else the first
 * whose checkout is on its head branch in its repository. Candidates come in the caller's order of
 * preference. GitHub treats `owner/name` case-insensitively; branch names it does not.
 */
export const prOwner = (
  pr: { readonly repo: string; readonly number: number; readonly headRef?: string | undefined },
  candidates: Iterable<PrOwnerCandidate>,
): ThreadId | undefined => {
  const repo = pr.repo.toLowerCase();
  let onBranch: ThreadId | undefined;
  for (const candidate of candidates) {
    if (candidate.prs.some((p) => p.number === pr.number && p.repo.toLowerCase() === repo)) {
      return candidate.threadId;
    }
    if (
      onBranch === undefined &&
      pr.headRef !== undefined &&
      candidate.branch === pr.headRef &&
      candidate.origin?.toLowerCase() === repo
    ) {
      onBranch = candidate.threadId;
    }
  }
  return onBranch;
};
