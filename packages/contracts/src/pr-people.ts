import * as Schema from "effect/Schema";

/** A pending review request: a user by login, or a team by `org/slug`. */
export const PrReviewRequest = Schema.Struct({
  kind: Schema.Literals(["user", "team"]),
  /** What `gh pr edit --add-reviewer` takes: a login or `org/slug`. */
  name: Schema.String,
  /** CODEOWNERS asked for it; absent when it didn't, and wherever GitHub wasn't asked. */
  codeOwner: Schema.optionalKey(Schema.Literal(true)),
});
export type PrReviewRequest = typeof PrReviewRequest.Type;

/** A reviewer's most recent review. */
export const PrLatestReview = Schema.Struct({
  author: Schema.String,
  /** APPROVED / CHANGES_REQUESTED / COMMENTED / DISMISSED. */
  state: Schema.String,
  /** ISO-8601; empty when GitHub reports none. */
  at: Schema.String,
});
export type PrLatestReview = typeof PrLatestReview.Type;

export const PrLabel = Schema.Struct({
  name: Schema.String,
  /** `rrggbb` without the `#`; empty when unknown. */
  color: Schema.String,
  description: Schema.String,
});
export type PrLabel = typeof PrLabel.Type;

/** `pr.requestReview`: the de-duplicated names GitHub was asked to add. */
export const PrRequestReviewResult = Schema.Struct({ reviewers: Schema.Array(Schema.String) });
export type PrRequestReviewResult = typeof PrRequestReviewResult.Type;

/** `pr.reviewerSuggestions`: recent reviewers in the repo, most frequent first, then collaborators. */
export const PrReviewerSuggestions = Schema.Struct({ logins: Schema.Array(Schema.String) });
export type PrReviewerSuggestions = typeof PrReviewerSuggestions.Type;

/** `pr.labels.list`: the labels defined in the PR's repository. */
export const PrLabelList = Schema.Struct({ labels: Schema.Array(PrLabel) });
export type PrLabelList = typeof PrLabelList.Type;
