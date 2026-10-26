import * as Schema from "effect/Schema";

// Review bots: automated reviewers whose rounds, verdicts and inline findings the app
// surfaces on a thread's PR.

export const ReviewBot = Schema.Struct({
  /** Author login to match: case-insensitive, `*` wildcards, a trailing `[bot]` optional either side. */
  loginPattern: Schema.String,
  /** Posted as a PR comment to ask the bot for another round. */
  rereviewCommand: Schema.String,
  /** The bot can APPROVE / REQUEST_CHANGES; when false its reviews are comments only. */
  canApprove: Schema.Boolean,
});
export type ReviewBot = typeof ReviewBot.Type;

/** External reviewers are opt-in; a synthetic example is never an installed bot. */
export const DEFAULT_REVIEW_BOTS: ReadonlyArray<ReviewBot> = [];

const normaliseLogin = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/\[bot\]$/, "");

/**
 * Whether `login` matches a bot's pattern: case-insensitive, `*` wildcards, and a trailing `[bot]`
 * optional on either side (GraphQL reports `example-code-review`, REST `example-code-review[bot]`).
 */
export const matchesBotLogin = (pattern: string, candidate: string): boolean => {
  const p = normaliseLogin(pattern);
  const l = normaliseLogin(candidate);
  if (p === "" || l === "") return false;
  const source = p
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`).test(l);
};

/** Whether `candidate` is one of the configured review bots: the AI reviewer, not a person. */
export const isBotLogin = (bots: ReadonlyArray<ReviewBot>, candidate: string): boolean =>
  bots.some((bot) => matchesBotLogin(bot.loginPattern, candidate));

/**
 * A finding's tag. `outstanding` is the bot's `[Still outstanding]`; `finding` is an untagged comment,
 * which is common: tags are optional, so severity never decides the verdict.
 */
export const ReviewSeverity = Schema.Literals(["blocker", "suggestion", "outstanding", "finding"]);
export type ReviewSeverity = typeof ReviewSeverity.Type;

export const ReviewVerdict = Schema.Literals(["approved", "changesRequested", "commented"]);
export type ReviewVerdict = typeof ReviewVerdict.Type;

/** Counts over threads a bot started. */
export const ReviewThreadCounts = Schema.Struct({
  unresolved: Schema.Int,
  /** Unresolved and tagged `[blocker]`. */
  blockers: Schema.Int,
  /** Unresolved and tagged `[suggestion]`. */
  suggestions: Schema.Int,
  outdatedUnresolved: Schema.Int,
  /** Unresolved threads a person started; the counts above are the bots' only. */
  humanUnresolved: Schema.optionalKey(Schema.Int),
});
export type ReviewThreadCounts = typeof ReviewThreadCounts.Type;

/** How much of a person's review body the badge carries. */
export const HUMAN_REVIEW_BODY_CHARS = 1000;

/** A person's standing verdict on a PR: their latest approval or change request, undismissed. */
export const HumanReview = Schema.Struct({
  /** GraphQL node id; a new submission is a new id. */
  id: Schema.String,
  author: Schema.String,
  verdict: Schema.Literals(["approved", "changesRequested"]),
  /** The commit the review was submitted on. */
  commitOid: Schema.String,
  /** ISO-8601. */
  submittedAt: Schema.String,
  /** Written by the reviewer on GitHub, cut to `HUMAN_REVIEW_BODY_CHARS`. */
  body: Schema.String,
});
export type HumanReview = typeof HumanReview.Type;

/**
 * The review state carried on `PrStatus.review`; absent when no configured bot touched the PR and no
 * person has an unresolved thread or a standing verdict on it.
 */
export const PrReviewState = Schema.Struct({
  /** Logins of configured bots that reviewed or commented. */
  bots: Schema.Array(Schema.String),
  /** A bot's APPROVED / CHANGES_REQUESTED review on the head commit; COMMENTED never counts. */
  verdictOnHead: Schema.optionalKey(Schema.Literals(["approved", "changesRequested"])),
  /** Author of verdictOnHead; distinguishes approval from another bot's comments. */
  verdictOnHeadBy: Schema.optionalKey(Schema.String),
  /** The latest bot summary review, on any commit; dismissed approvals don't count. */
  latestVerdict: Schema.optionalKey(ReviewVerdict),
  /** A bot summary review exists for the head commit. */
  reviewedHead: Schema.Boolean,
  /** A bot progress comment says a round is running. */
  roundInFlight: Schema.Boolean,
  /** Id of the latest bot summary review; moves once per completed round. */
  latestReviewId: Schema.optionalKey(Schema.String),
  /** The bot's summary reviews among the last twenty reviews read: its rounds, up to there. */
  rounds: Schema.optionalKey(Schema.Int),
  threads: ReviewThreadCounts,
  /**
   * People's standing verdicts, oldest first: reviewers that are neither a configured bot, a GitHub
   * App, nor the PR's author. Absent when there are none.
   */
  humanReviews: Schema.optionalKey(Schema.Array(HumanReview)),
});
export type PrReviewState = typeof PrReviewState.Type;

/** Fields from the `<!-- code-review-meta: … -->` comment; unknown keys are ignored. */
export const ReviewMeta = Schema.Struct({
  model: Schema.optionalKey(Schema.String),
  effort: Schema.optionalKey(Schema.String),
  strictness: Schema.optionalKey(Schema.String),
  scope: Schema.optionalKey(Schema.String),
});
export type ReviewMeta = typeof ReviewMeta.Type;

export const ReviewComment = Schema.Struct({
  /** GraphQL node id. */
  id: Schema.String,
  author: Schema.String,
  body: Schema.String,
  /** ISO-8601. */
  createdAt: Schema.String,
  url: Schema.String,
  /** The body of a ```suggestion block; empty text suggests deleting the lines. */
  suggestion: Schema.optionalKey(Schema.String),
});
export type ReviewComment = typeof ReviewComment.Type;

export const ReviewThread = Schema.Struct({
  /** GraphQL node id, used to reply and resolve. */
  id: Schema.String,
  path: Schema.String,
  /** End line on the PR head; absent when outdated. */
  line: Schema.optionalKey(Schema.Int),
  startLine: Schema.optionalKey(Schema.Int),
  isResolved: Schema.Boolean,
  isOutdated: Schema.Boolean,
  severity: ReviewSeverity,
  /** The thread was started by a configured bot. */
  byBot: Schema.Boolean,
  comments: Schema.Array(ReviewComment),
});
export type ReviewThread = typeof ReviewThread.Type;

/** A bot summary review, with the meta comment parsed out of the body. */
export const BotReview = Schema.Struct({
  id: Schema.String,
  author: Schema.String,
  verdict: ReviewVerdict,
  /** Markdown with the meta comment removed. */
  body: Schema.String,
  commitOid: Schema.String,
  /** ISO-8601. */
  submittedAt: Schema.String,
  onHead: Schema.Boolean,
  meta: Schema.optionalKey(ReviewMeta),
});
export type BotReview = typeof BotReview.Type;

export const PrReview = Schema.Struct({
  /** False: `gh` is missing or logged out. */
  available: Schema.Boolean,
  error: Schema.optionalKey(Schema.String),
  /** Absent when the thread has no PR. */
  pr: Schema.optionalKey(
    Schema.Struct({
      number: Schema.Int,
      url: Schema.String,
      headRefOid: Schema.String,
      /** GitHub's `reviewDecision`; empty when none. */
      reviewDecision: Schema.String,
      /** GitHub's `mergeStateStatus`, e.g. CLEAN / BLOCKED / UNKNOWN. */
      mergeStateStatus: Schema.String,
      /** OPEN / CLOSED / MERGED. */
      state: Schema.optionalKey(Schema.String),
      /** The `gh` user opened this PR; babysitting others' PRs always asks. */
      viewerDidAuthor: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  state: Schema.optionalKey(PrReviewState),
  latestReview: Schema.optionalKey(BotReview),
  threads: Schema.Array(ReviewThread),
});
export type PrReview = typeof PrReview.Type;

export const ApplySuggestionResult = Schema.Struct({
  /** Checkout-relative path that was patched. */
  path: Schema.String,
  startLine: Schema.Int,
  endLine: Schema.Int,
});
export type ApplySuggestionResult = typeof ApplySuggestionResult.Type;

/** A completed bot round, published once per round after a quiet window. */
export const ReviewRound = Schema.Struct({
  number: Schema.Int,
  reviewId: Schema.String,
  verdict: Schema.optionalKey(ReviewVerdict),
  verdictOnHead: Schema.optionalKey(Schema.Literals(["approved", "changesRequested"])),
  counts: ReviewThreadCounts,
});
export type ReviewRound = typeof ReviewRound.Type;
