import * as Schema from "effect/Schema";

export const UpstreamSyncFields = { repoPath: Schema.String };

/**
 * The current branch against its `origin/` upstream, from local refs only: fetch first to learn about
 * new commits.
 */
export const UpstreamSync = Schema.Struct({
  /** Absent when HEAD is detached or unborn. */
  branch: Schema.optionalKey(Schema.String),
  /** Absent without an `origin/` upstream. */
  ref: Schema.optionalKey(Schema.String),
  ahead: Schema.Int,
  behind: Schema.Int,
  /** Uncommitted changes to tracked files. */
  changedFiles: Schema.Int,
  /** Why `git.fastForward` would refuse, e.g. "it has 2 uncommitted changes"; absent when it can. */
  blocker: Schema.optionalKey(Schema.String),
});
export type UpstreamSync = typeof UpstreamSync.Type;

export const FastForwardResult = Schema.Struct({
  branch: Schema.String,
  ref: Schema.String,
  /** Commits the branch moved forward by. */
  commits: Schema.Int,
  head: Schema.String,
});
export type FastForwardResult = typeof FastForwardResult.Type;
