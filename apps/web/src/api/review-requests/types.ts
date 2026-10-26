import type { OwnPrs, ReviewRequests } from "@gram/contracts";

/** `reviewRequests.*` and `openPrs.*`: the open PRs that ask for the user's review, and theirs. */
export interface ReviewRequestsApi {
  /** Open PRs requesting the user's review, as last polled; empty without `gh` or with the setting off. */
  listReviewRequests(): Promise<ReviewRequests>;
  /**
   * Polls for review requests and open PRs again: at most once a minute, or at once with `force`.
   */
  refreshReviewRequests(options?: { force?: boolean }): Promise<void>;
  /** The user's own open PRs, drafts included, as last polled; empty without `gh`. */
  listOpenPrs(): Promise<OwnPrs>;
}
