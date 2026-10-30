import * as Schema from "effect/Schema";
import { currentBaseOf, mergeStateAllowsMerge, requiredChecksOf, type PrStatus } from "./git.ts";
import { matchesBotLogin, type ReviewBot } from "./review.ts";

export const MergeReviewPolicy = Schema.Literals(["automatic", "solo", "bot"]);
export type MergeReviewPolicy = typeof MergeReviewPolicy.Type;

/** Exact GitHub owner/repo identifiers; URLs, wildcards and paths are never policy scopes. */
export const MergePolicyRepo = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+$/),
  Schema.makeFilter((repo: string) => ![".", ".."].includes(repo.split("/")[1]!)),
);
export const RepoMergeReviewPolicy = Schema.Struct({
  repo: MergePolicyRepo,
  policy: MergeReviewPolicy,
});
export const RepoMergeReviewPolicies = Schema.Array(RepoMergeReviewPolicy).check(
  Schema.makeFilter((entries) =>
    new Set(entries.map((entry) => entry.repo.toLowerCase())).size === entries.length
      ? true
      : "A repository can have only one merge review policy.",
  ),
);

export interface MergeReviewCharter {
  readonly mergeReviewPolicy?: MergeReviewPolicy | undefined;
  readonly repoMergeReviewPolicies?: ReadonlyArray<typeof RepoMergeReviewPolicy.Type> | undefined;
}

/** A charter that sets no policy gets the bot gate. Overrides belong only to this workspace. */
export const mergeReviewPolicyOf = (
  charter: MergeReviewCharter | undefined,
  repo: string,
  bots: ReadonlyArray<ReviewBot>,
): "solo" | "bot" => {
  const policy =
    charter?.repoMergeReviewPolicies?.find(
      (entry) => entry.repo.toLowerCase() === repo.toLowerCase(),
    )?.policy ??
    charter?.mergeReviewPolicy ??
    "bot";
  return policy === "automatic" ? (bots.some((bot) => bot.canApprove) ? "bot" : "solo") : policy;
};

/** Whether the head's verdict comes from a configured bot that can approve. */
export const approvingBotOnHead = (badge: PrStatus, bots: ReadonlyArray<ReviewBot>): boolean => {
  const author = badge.review?.verdictOnHeadBy;
  return (
    author !== undefined &&
    bots.some((bot) => bot.canApprove && matchesBotLogin(bot.loginPattern, author))
  );
};

/**
 * Gram's own passing full check of a head merged onto its base (`git/local-checks.ts` on the
 * server). Solo development accepts it as the merge's check in place of GitHub CI.
 */
export interface LocalCheckPass {
  readonly head: string;
  readonly base: string;
}

/** Whether `localCheck` vouches for exactly the head `badge` shows, on exactly its base. */
export const localCheckOnHead = (
  badge: Pick<PrStatus, "headRefOid" | "baseRefOid" | "baseTipOid">,
  localCheck: LocalCheckPass | undefined,
): boolean =>
  localCheck !== undefined &&
  badge.headRefOid !== undefined &&
  currentBaseOf(badge) !== undefined &&
  localCheck.head === badge.headRefOid &&
  localCheck.base === currentBaseOf(badge);

/**
 * GitHub remains authoritative in both policies. Solo needs actual passing CI, or Gram's own check
 * of the exact head: then pending or absent CI doesn't hold the merge, failing CI still does, and
 * so do pending jobs the repo's merge policy declares a local check can't stand in for.
 */
export const mergePolicyReady = (
  badge: PrStatus,
  policy: "solo" | "bot",
  bots?: ReadonlyArray<ReviewBot>,
  localCheck?: LocalCheckPass,
): boolean => {
  if (
    badge.state !== "OPEN" ||
    badge.isDraft ||
    badge.stale !== undefined ||
    badge.headRefOid === undefined ||
    badge.reviewUnread === true ||
    !mergeStateAllowsMerge(badge.mergeState)
  )
    return false;
  if (badge.reviewDecision === "REVIEW_REQUIRED" || badge.reviewDecision === "CHANGES_REQUESTED")
    return false;
  if (
    badge.review?.verdictOnHead === "changesRequested" ||
    badge.review?.humanReviews?.some((review) => review.verdict === "changesRequested")
  )
    return false;
  const checks = requiredChecksOf(badge);
  if (policy === "solo" && localCheckOnHead(badge, localCheck)) {
    if (badge.mergeChecks === "failing" || badge.mergeChecks === "pending") return false;
    if (checks === "failing") return false;
  } else {
    if (
      badge.mergeChecks !== undefined &&
      badge.mergeChecks !== "passing" &&
      badge.mergeChecks !== "none"
    )
      return false;
    if (checks !== "passing" && !(policy === "bot" && checks === "none")) return false;
  }
  if (policy === "bot" && bots !== undefined && !approvingBotOnHead(badge, bots)) return false;
  return policy === "solo" || badge.review?.verdictOnHead === "approved";
};
