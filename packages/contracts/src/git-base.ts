import * as Schema from "effect/Schema";

/** A base branch for a new worktree: one of `git.branches`, e.g. `origin/develop`. */
export const BaseRefFields = {
  repoPath: Schema.String,
  base: Schema.String,
};

/** How fresh the local copy of a base branch is, from local data only. */
export const BaseRefStatus = Schema.Struct({
  ref: Schema.String,
  /** Epoch ms of the repo's last fetch; absent when it has never fetched. */
  fetchedAt: Schema.optionalKey(Schema.Number),
});
export type BaseRefStatus = typeof BaseRefStatus.Type;

export const FetchBaseResult = Schema.Struct({
  ref: Schema.String,
  fetchedAt: Schema.optionalKey(Schema.Number),
  /** Commits the fetch added to `ref`. */
  newCommits: Schema.Int,
});
export type FetchBaseResult = typeof FetchBaseResult.Type;
