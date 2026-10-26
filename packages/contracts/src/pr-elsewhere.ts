import * as Schema from "effect/Schema";
import { ThreadId } from "./ids.ts";

/** An open PR on another worktree of the same repo, for a checkout whose own branch has none. */
export const PrElsewhere = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  url: Schema.String,
  /** `owner/repo`. */
  repo: Schema.String,
  /** The other worktree's branch: the PR's head. */
  branch: Schema.String,
  worktreePath: Schema.String,
  /** The open thread working in that worktree, if any. */
  threadId: Schema.optionalKey(ThreadId),
});
export type PrElsewhere = typeof PrElsewhere.Type;
