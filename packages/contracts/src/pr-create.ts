import * as Schema from "effect/Schema";
import { ThreadId } from "./ids.ts";

/** A base branch name as GitHub knows it: `main`, not `origin/main`. */
const BaseBranch = Schema.String.check(
  Schema.isPattern(/^(?!origin\/)(?!.*\.\.)[A-Za-z0-9._/-]+$/),
);

export const PrDraftFields = Schema.Struct({ threadId: ThreadId, base: BaseBranch });
export type PrDraftFields = typeof PrDraftFields.Type;

/** The create-PR dialog's pre-fill from the branch's commits since `base`. */
export const PrDraft = Schema.Struct({
  title: Schema.String,
  body: Schema.String,
  commits: Schema.Int,
});
export type PrDraft = typeof PrDraft.Type;

export const PrCreateFields = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String.check(Schema.isMinLength(1)),
  body: Schema.String,
  base: BaseBranch,
  draft: Schema.Boolean,
});
export type PrCreateFields = typeof PrCreateFields.Type;

export const CreatedPr = Schema.Struct({
  /** `owner/repo`. */
  repo: Schema.String,
  number: Schema.Int,
  url: Schema.String,
});
export type CreatedPr = typeof CreatedPr.Type;
