import * as Schema from "effect/Schema";
import { PrElsewhere } from "./pr-elsewhere.ts";
import { PrLabel, PrLatestReview, PrReviewRequest } from "./pr-people.ts";
import { PrReviewState } from "./review.ts";
import { TurnId } from "./ids.ts";

/** Local HEAD vs the branch's own remote counterpart (`origin/<branch>`). */
export const UpstreamState = Schema.Literals(["synced", "behind", "ahead", "diverged"]);
export type UpstreamState = typeof UpstreamState.Type;

export const ChecksRollup = Schema.Literals(["passing", "failing", "pending", "none"]);
export type ChecksRollup = typeof ChecksRollup.Type;

export const PrState = Schema.Literals(["OPEN", "MERGED", "CLOSED"]);
export type PrState = typeof PrState.Type;

/** The most failing check names a badge carries. */
export const MAX_FAILING_CHECK_NAMES = 5;

/** The PR badge payload (mirrors Rust `PrStatus`). */
/**
 * The `PrStale.reason` for a lookup `gh` refused because nobody is signed in. Named here so the UI
 * can say where to sign in without matching free text.
 */
export const PR_STALE_SIGNED_OUT = "not logged in to gh";

/** The badge is carried from an earlier refresh because GitHub couldn't be reached. */
export const PrStale = Schema.Struct({
  /** A few words, e.g. "rate limited". */
  reason: Schema.String,
  /** Epoch ms of the first failed refresh in this run of failures. */
  since: Schema.Number,
});
export type PrStale = typeof PrStale.Type;

export const PrStatus = Schema.Struct({
  number: Schema.Int,
  state: PrState,
  url: Schema.String,
  title: Schema.String,
  isDraft: Schema.Boolean,
  /** Every check on the head, required or not: what the badge draws. */
  checks: ChecksRollup,
  /**
   * The checks branch protection requires, including when their rollup equals `checks`.
   * Absent when none is marked required or GitHub was not asked, so `checks` stands.
   * Readiness goes by `requiredChecksOf`.
   */
  requiredChecks: Schema.optionalKey(ChecksRollup),
  /**
   * Fresh launch-only verification of declared CI and exact-head workflow runs. After a solo local
   * check of this head, only of the jobs the base's merge policy declares `alwaysJobs`.
   */
  mergeChecks: Schema.optionalKey(ChecksRollup),
  /**
   * The failing checks that gate the merge (the required ones, where GitHub marks any), by name and
   * at most `MAX_FAILING_CHECK_NAMES`, from a checks read made under this head and rollup, and when
   * it was made: the names can move under the same rollup, so a reader ages them out
   * (`CHECK_NAMES_MAX_AGE_MS`). Absent when nothing has read them, so they are unknown, not none.
   */
  failingChecks: Schema.optionalKey(
    Schema.Struct({
      names: Schema.Array(Schema.String),
      /** Epoch ms of the read. */
      readAt: Schema.Number,
    }),
  ),
  /** The PR's head commit equals the local branch tip or pushed tip. */
  headMatches: Schema.Boolean,
  /** Right PR, but the local branch has commits past its head. */
  aheadOfPr: Schema.Boolean,
  /** `baseRefName`; the rebase signal measures against this when set. */
  baseRef: Schema.optionalKey(Schema.String),
  /** `headRefName`: the PR's own branch, which a bound or followed PR needn't share with the checkout. */
  headRef: Schema.optionalKey(Schema.String),
  /** The author's login. */
  author: Schema.optionalKey(Schema.String),
  additions: Schema.optionalKey(Schema.Int),
  deletions: Schema.optionalKey(Schema.Int),
  changedFiles: Schema.optionalKey(Schema.Int),
  headRefOid: Schema.optionalKey(Schema.String),
  baseRefOid: Schema.optionalKey(Schema.String),
  /** GitHub `updatedAt`, a catch-all change stamp. */
  updatedAt: Schema.optionalKey(Schema.String),
  /** GitHub's `mergeStateStatus`, e.g. CLEAN / BLOCKED / DIRTY; absent from older fetch paths. */
  mergeState: Schema.optionalKey(Schema.String),
  /** APPROVED / CHANGES_REQUESTED / REVIEW_REQUIRED; absent when GitHub reports none. */
  reviewDecision: Schema.optionalKey(Schema.String),
  /** The reviews still asked for, people's and teams'; absent when none is. */
  reviewRequests: Schema.optionalKey(Schema.Array(PrReviewRequest)),
  /** Review-bot state; absent when no configured bot reviewed this PR. */
  review: Schema.optionalKey(PrReviewState),
  /**
   * The lookup didn't read the PR's reviews, so an absent `review` says nothing: a PR bound from
   * elsewhere with no review monitor on it, or a badge from the REST fallback.
   */
  reviewUnread: Schema.optionalKey(Schema.Literal(true)),
  /** Set while the badge is carried over failed refreshes; cleared by the next successful one. */
  stale: Schema.optionalKey(PrStale),
});
export type PrStatus = typeof PrStatus.Type;

/** `owner/name` from a PR url like `https://github.com/owner/name/pull/12`. */
export const repoFromPrUrl = (url: string): string | undefined => {
  const match = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/\d+/.exec(url.trim());
  return match ? `${match[1]}/${match[2]}` : undefined;
};

/** What of a badge decides its PR's checks: the commit they ran on, and how they add up. */
export const prChecksStamp = (badge: Pick<PrStatus, "headRefOid" | "checks">): string =>
  `${badge.headRefOid ?? ""}:${badge.checks}`;

/** A badge's two rollups, as `requiredChecksOf` reads them. */
export interface ChecksOfPr {
  readonly checks: ChecksRollup;
  readonly requiredChecks?: ChecksRollup | undefined;
}

/** The checks that stand between a PR and merging: the required ones, or every one where unknown. */
export const requiredChecksOf = (pr: ChecksOfPr): ChecksRollup => pr.requiredChecks ?? pr.checks;

/** Whether the required checks leave nothing to wait for: they passed, or there are none. */
export const requiredChecksGreen = (pr: ChecksOfPr): boolean => {
  const checks = requiredChecksOf(pr);
  return checks === "passing" || checks === "none";
};

/**
 * GitHub's `mergeStateStatus` says it would merge: CLEAN, or UNSTABLE, which is a check it doesn't
 * require failing or still running. BLOCKED, BEHIND, DIRTY and the rest are not.
 */
export const mergeStateAllowsMerge = (mergeState: string | undefined): boolean =>
  mergeState === "CLEAN" || mergeState === "UNSTABLE";

/** Per-thread git state pushed on change (mirrors Rust `GitState`). */
export const GitState = Schema.Struct({
  /** False: `cwd` isn't a git repo, clear every git affordance. */
  repo: Schema.Boolean,
  /** Current branch; absent when detached or unborn. */
  branch: Schema.optionalKey(Schema.String),
  /** The effective cwd is a linked worktree (checkout topology, not provenance). */
  worktree: Schema.Boolean,
  head: Schema.String,
  /** Working-tree fingerprint; the diff panel refetches only when it changes. */
  changesToken: Schema.String,
  changedFiles: Schema.Int,
  /** Remote-tracking ref compared against for the rebase signal. */
  base: Schema.optionalKey(Schema.String),
  behindBase: Schema.Int,
  aheadBase: Schema.Int,
  /** A `git merge-tree` trial merge into `base` would conflict. */
  conflicts: Schema.Boolean,
  upstream: Schema.optionalKey(UpstreamState),
  /** Commits HEAD has that `origin/<branch>` doesn't; present while `upstream` is ahead or diverged. */
  aheadUpstream: Schema.optionalKey(Schema.Int),
  /**
   * A remote-tracking ref contains HEAD, so every commit here is on a remote (`headPushed`).
   * Measured with the rebase tier; absent until it has been, and while it is cleared.
   */
  headOnRemote: Schema.optionalKey(Schema.Boolean),
  pr: Schema.optionalKey(PrStatus),
  /**
   * Badges for the thread's `extraPrs`, matched to them by `url`. One is missing until its first
   * lookup lands, and for good when GitHub doesn't know the PR.
   */
  extraPrs: Schema.optionalKey(Schema.Array(PrStatus)),
  /** `owner/repo` of `origin`. */
  origin: Schema.optionalKey(Schema.String),
  /**
   * This main checkout is clean while another worktree of the repo holds uncommitted
   * work on a different branch, so the badge may not describe where the work is.
   */
  workElsewhere: Schema.optionalKey(Schema.Struct({ branch: Schema.String, path: Schema.String })),
  /** No PR here, but another worktree of the repo has an open one. Only while `pr` is absent. */
  prElsewhere: Schema.optionalKey(PrElsewhere),
  /**
   * The thread's bound or followed PRs that GitHub answered it has no such PR for: they hold
   * nothing open, unlike one whose badge simply hasn't landed. A thread's own state only.
   */
  missingPrs: Schema.optionalKey(
    Schema.Array(Schema.Struct({ repo: Schema.String, number: Schema.Int })),
  ),
  /**
   * The checkout's folder is gone, deleted outside Gram. The rest is what was last read
   * before it went, except the PR badge, which is still looked up from the repo's main checkout.
   */
  missing: Schema.optionalKey(Schema.Literal(true)),
});
export type GitState = typeof GitState.Type;

/**
 * Whether a checkout's commits are all on a remote, so removing it loses none: a remote-tracking
 * ref contains HEAD, or HEAD is its PR's head on GitHub, since a squash merge leaves HEAD in no
 * remote branch once GitHub deletes the PR's. The worktree sweep decides on this, from git asked
 * right before it acts; the close dialog and the merged notice read it off the published state.
 */
export const headPushed = (facts: {
  readonly head: string;
  readonly headOnRemote: boolean;
  readonly prHeadRefOid?: string | undefined;
}): boolean => facts.headOnRemote || (facts.head !== "" && facts.prHeadRefOid === facts.head);

export const WorktreeEntry = Schema.Struct({
  path: Schema.String,
  branch: Schema.optionalKey(Schema.String),
  detached: Schema.Boolean,
  /** The repo's main checkout (listed first by git). */
  isMain: Schema.Boolean,
  /** A thread is open in this checkout. */
  isOpen: Schema.Boolean,
  /** Epoch ms of the last agent activity here; 0 when unknown. */
  lastActivity: Schema.Number,
});
export type WorktreeEntry = typeof WorktreeEntry.Type;

export const DiffFileStatus = Schema.Literals([
  "added",
  "modified",
  "deleted",
  "renamed",
  "untracked",
]);
export type DiffFileStatus = typeof DiffFileStatus.Type;

export const DiffFile = Schema.Struct({
  path: Schema.String,
  oldPath: Schema.optionalKey(Schema.String),
  status: DiffFileStatus,
  additions: Schema.Int,
  deletions: Schema.Int,
  /** From the first `@@` hunk onward; empty when `binary` or `tooLarge`. */
  patch: Schema.String,
  binary: Schema.Boolean,
  tooLarge: Schema.Boolean,
});
export type DiffFile = typeof DiffFile.Type;

export const Diff = Schema.Struct({
  /** False: not a repo, and every other field is absent. */
  repo: Schema.Boolean,
  branch: Schema.optionalKey(Schema.String),
  /** The checkout that was diffed. */
  worktree: Schema.optionalKey(Schema.String),
  /** Set when this is the clean-tree branch-vs-base fallback. */
  base: Schema.optionalKey(Schema.String),
  /** Set when file bodies over the view cap were dropped. */
  note: Schema.optionalKey(Schema.String),
  files: Schema.optionalKey(Schema.Array(DiffFile)),
});
export type Diff = typeof Diff.Type;

export const CheckStatus = Schema.Literals(["passing", "failing", "pending", "neutral"]);
export type CheckStatus = typeof CheckStatus.Type;

export const CheckPhase = Schema.Literals(["queued", "running", "completed"]);
export type CheckPhase = typeof CheckPhase.Type;

export const PrCheckRun = Schema.Struct({
  name: Schema.String,
  status: CheckStatus,
  link: Schema.String,
  /** The GitHub Actions run behind the check; absent for other providers' checks. */
  runId: Schema.optionalKey(Schema.String),
  /** GitHub's raw conclusion (SUCCESS, FAILURE, CANCELLED, …); absent until the check completes. */
  conclusion: Schema.optionalKey(Schema.String),
  phase: Schema.optionalKey(CheckPhase),
  /** ISO-8601. */
  startedAt: Schema.optionalKey(Schema.String),
  /** ISO-8601. */
  completedAt: Schema.optionalKey(Schema.String),
  /** Branch protection requires it; absent when GitHub wasn't asked, or marks none required. */
  required: Schema.optionalKey(Schema.Boolean),
});
export type PrCheckRun = typeof PrCheckRun.Type;

export const PrCommit = Schema.Struct({
  oid: Schema.String,
  headline: Schema.String,
  author: Schema.String,
  /** ISO-8601. */
  at: Schema.String,
});
export type PrCommit = typeof PrCommit.Type;

export const PrComment = Schema.Struct({
  kind: Schema.Literals(["comment", "review"]),
  author: Schema.String,
  /** Review state (APPROVED, CHANGES_REQUESTED, …); empty for plain comments. */
  state: Schema.String,
  body: Schema.String,
  /** ISO-8601. */
  at: Schema.String,
});
export type PrComment = typeof PrComment.Type;

export const PrDetail = Schema.Struct({
  headRefOid: Schema.optionalKey(Schema.String),
  number: Schema.Int,
  state: PrState,
  url: Schema.String,
  title: Schema.String,
  body: Schema.String,
  isDraft: Schema.Boolean,
  author: Schema.String,
  baseRefName: Schema.String,
  headRefName: Schema.String,
  additions: Schema.Int,
  deletions: Schema.Int,
  changedFiles: Schema.Int,
  commits: Schema.Int,
  /** APPROVED / CHANGES_REQUESTED / REVIEW_REQUIRED; empty when GitHub reports none. */
  reviewDecision: Schema.String,
  /** Submitted reviews, including bodiless approvals. */
  reviews: Schema.optionalKey(Schema.Int),
  checks: ChecksRollup,
  checksPassed: Schema.Int,
  checksTotal: Schema.Int,
  checkRuns: Schema.Array(PrCheckRun),
  commitList: Schema.Array(PrCommit),
  conversation: Schema.Array(PrComment),
  files: Schema.Array(DiffFile),
  /** Explains why `files` is empty ("Diff too large to display"). */
  note: Schema.optionalKey(Schema.String),
  reviewRequests: Schema.optionalKey(Schema.Array(PrReviewRequest)),
  /** One entry per reviewer: their most recent review. */
  latestReviews: Schema.optionalKey(Schema.Array(PrLatestReview)),
  labels: Schema.optionalKey(Schema.Array(PrLabel)),
});
export type PrDetail = typeof PrDetail.Type;

export const PrDetailResult = Schema.Struct({
  /** False: `gh` is missing or logged out. */
  available: Schema.Boolean,
  detail: Schema.optionalKey(PrDetail),
  error: Schema.optionalKey(Schema.String),
});
export type PrDetailResult = typeof PrDetailResult.Type;

/**
 * `git.prChecks`: the thread's PR's checks by name, which the badge's rollup doesn't say and
 * `git.prDetail` only answers with the whole PR and its diff.
 */
export const PrChecksResult = Schema.Struct({
  /** Empty when the thread has no PR, as well as when its PR has no checks. */
  checks: Schema.Array(PrCheckRun),
});
export type PrChecksResult = typeof PrChecksResult.Type;

export const BranchList = Schema.Struct({
  branches: Schema.Array(Schema.String),
  default: Schema.optionalKey(Schema.String),
});
export type BranchList = typeof BranchList.Type;

export const DiffScope = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("uncommitted") }),
  Schema.Struct({ kind: Schema.Literal("branch") }),
  Schema.Struct({ kind: Schema.Literal("turn"), turnId: TurnId }),
]);
export type DiffScope = typeof DiffScope.Type;
