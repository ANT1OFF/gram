import type {
  PrLabelList,
  PrRequestReviewResult,
  PrReviewerSuggestions,
  ThreadId,
} from "@gram/contracts";

/** The people and labels on a thread's PR: reviewers to ask, and its GitHub labels. */
export interface PrPeopleApi {
  /** Asks users (logins) or teams (`org/slug`) to review the thread's PR; resolves with the names sent. */
  prRequestReview(threadId: ThreadId, reviewers: readonly string[]): Promise<PrRequestReviewResult>;
  /** Logins worth suggesting as reviewers; empty when `gh` can't tell. */
  prReviewerSuggestions(threadId: ThreadId): Promise<PrReviewerSuggestions>;
  /** The labels defined in the PR's repository (GitHub labels, not thread labels). */
  prLabelsList(threadId: ThreadId): Promise<PrLabelList>;
  prLabelsAdd(threadId: ThreadId, labels: readonly string[]): Promise<void>;
  prLabelsRemove(threadId: ThreadId, labels: readonly string[]): Promise<void>;
}
