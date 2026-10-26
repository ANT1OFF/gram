import * as Schema from "effect/Schema";

export const UpstreamStatusFields = { repoPath: Schema.String };

/** The current checkout's branch and how fresh its `origin/` upstream is, from local data only. */
export const UpstreamRefStatus = Schema.Struct({
  /** Absent when HEAD is detached or unborn. */
  branch: Schema.optionalKey(Schema.String),
  /** The branch's `origin/` upstream; absent without one, or when it tracks another remote. */
  ref: Schema.optionalKey(Schema.String),
  /** Epoch ms of the repo's last fetch; absent without an upstream or when it has never fetched. */
  fetchedAt: Schema.optionalKey(Schema.Number),
});
export type UpstreamRefStatus = typeof UpstreamRefStatus.Type;
