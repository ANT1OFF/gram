import * as Schema from "effect/Schema";
import { ThreadId } from "./ids.ts";

/** `git.prRerunChecks`: the Actions runs whose failed jobs were queued again. */
export const PrRerunChecksResult = Schema.Struct({
  /** Distinct Actions run ids asked to rerun their failed jobs. */
  runIds: Schema.Array(Schema.String),
  /** Failing checks without an Actions run (other providers), which can't be rerun from here. */
  skipped: Schema.Array(Schema.String),
});
export type PrRerunChecksResult = typeof PrRerunChecksResult.Type;

export const MergeStrategy = Schema.Literals(["squash", "merge", "rebase"]);
export type MergeStrategy = typeof MergeStrategy.Type;

/** `pr.merge`: merges now, or with `auto` turns on GitHub auto-merge, which babysit mode refuses. */
export const PrMergePayload = Schema.Struct({
  threadId: ThreadId,
  strategy: MergeStrategy,
  auto: Schema.optionalKey(Schema.Boolean),
});
export type PrMergePayload = typeof PrMergePayload.Type;

/** `pr.ready`: `draft: false` marks the PR ready for review; `true` converts it to a draft. */
export const PrReadyPayload = Schema.Struct({ threadId: ThreadId, draft: Schema.Boolean });
export type PrReadyPayload = typeof PrReadyPayload.Type;

/** `pr.mergeOptions`: what the merge dialog may offer for the thread's PR. */
export const PrMergeOptions = Schema.Struct({
  /** The strategies the repository allows, squash first. */
  strategies: Schema.Array(MergeStrategy),
  /** The repository allows auto-merge. */
  autoMerge: Schema.Boolean,
  /** Babysit mode is on, so auto-merge is refused: the user merges. */
  babysit: Schema.Boolean,
});
export type PrMergeOptions = typeof PrMergeOptions.Type;
