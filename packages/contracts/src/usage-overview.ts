import * as Schema from "effect/Schema";

export const UsageProvider = Schema.Literals(["claude", "codex"]);
export type UsageProvider = typeof UsageProvider.Type;
export const UsagePeriod = Schema.Literals([1, 7, 30, 90]);
export type UsagePeriod = typeof UsagePeriod.Type;
export const UsageOverviewQuery = Schema.Struct({
  days: UsagePeriod,
  provider: Schema.optionalKey(UsageProvider),
});
export type UsageOverviewQuery = typeof UsageOverviewQuery.Type;

/** Disjoint buckets. Reasoning is already included in output. Missing cache detail stays unsplit. */
export const UsageTotals = Schema.Struct({
  totalTokens: Schema.Number,
  uncachedInputTokens: Schema.Number,
  cacheReadTokens: Schema.Number,
  cacheWriteTokens: Schema.Number,
  unclassifiedInputTokens: Schema.Number,
  outputTokens: Schema.Number,
});
export type UsageTotals = typeof UsageTotals.Type;
export const UsageOverviewRow = Schema.Struct({
  day: Schema.String,
  provider: UsageProvider,
  model: Schema.NullOr(Schema.String),
  turns: Schema.Int,
  missingCacheRead: Schema.Boolean,
  missingCacheWrite: Schema.Boolean,
  totals: UsageTotals,
});
export type UsageOverviewRow = typeof UsageOverviewRow.Type;

/** A historical CLI quota observation, never a fresh account reading or a token amount. */
export const UsageLimitObservation = Schema.Struct({
  provider: UsageProvider,
  window: Schema.Literals(["five_hour", "seven_day"]),
  /** Epoch milliseconds of the rollout event, not the import. */
  at: Schema.Number,
  /** Share used, from 0 to 1. */
  utilization: Schema.Number,
  resetsAt: Schema.optionalKey(Schema.Number),
});
export type UsageLimitObservation = typeof UsageLimitObservation.Type;
/** At most this many most recent distinct observations per provider/window. */
export const LOCAL_LIMIT_OBSERVATIONS_MAX = 120;
export const UsageLocalLimitHistory = Schema.Struct({
  observations: Schema.Array(UsageLimitObservation),
  invalidReadings: Schema.Int,
  /** A sample or metadata budget was reached; this is never complete account history. */
  truncated: Schema.Boolean,
});
export type UsageLocalLimitHistory = typeof UsageLocalLimitHistory.Type;
export const UsageHistoryCoverage = Schema.Struct({
  sources: Schema.Array(
    Schema.Struct({
      provider: UsageProvider,
      status: Schema.Literals(["available", "missing", "partial"]),
      files: Schema.Int,
      skippedFiles: Schema.Int,
      invalidLines: Schema.Int,
      /** Valid JSON lines unrelated to supported usage/session metadata, including unknown types. */
      skippedLines: Schema.optionalKey(Schema.Int),
    }),
  ),
  importedRecords: Schema.Int,
  matchedTurns: Schema.Int,
  unmatchedGramTurns: Schema.Int,
  untrustedGramTurns: Schema.Int,
  ambiguousGramTurns: Schema.Int,
  selectedGramTurns: Schema.Int,
  ambiguousRecords: Schema.Int,
  historyRecords: Schema.Int,
  matchedRecords: Schema.Int,
  overlappingRecords: Schema.Int,
  duplicateRecords: Schema.Int,
  omittedRecords: Schema.Int,
  coalescedRecords: Schema.Int,
  supersededRecords: Schema.Int,
});
export type UsageHistoryCoverage = typeof UsageHistoryCoverage.Type;
/** One model's known tokens within a breakdown row; `model` null when no recording named it. */
export const UsageModelShare = Schema.Struct({
  provider: UsageProvider,
  model: Schema.NullOr(Schema.String),
  totalTokens: Schema.Number,
});
export type UsageModelShare = typeof UsageModelShare.Type;
/** What a breakdown row counted: the same disjoint buckets as `UsageTotals`, and its models. */
const breakdownFields = {
  totals: UsageTotals,
  /** Largest first. */
  models: Schema.Array(UsageModelShare),
};
/** Most threads a breakdown names; the rest are only in their workspace's or Solo's totals. */
export const USAGE_BREAKDOWN_THREADS = 25;
export const UsageThreadRole = Schema.Literals(["orchestrator", "worker", "dream", "solo"]);
export type UsageThreadRole = typeof UsageThreadRole.Type;
/**
 * Where the period's counted tokens went, from the same records as the totals: Gram's threads by
 * workspace, threads in no workspace (Solo), and CLI sessions Gram never ran (Outside Gram, from
 * local history). Threads are named as they are now; a deleted thread or workspace keeps its id.
 */
export const UsageBreakdown = Schema.Struct({
  workspaces: Schema.Array(
    Schema.Struct({
      workspaceId: Schema.String,
      /** Null once the workspace is gone. */
      name: Schema.NullOr(Schema.String),
      threads: Schema.Int,
      ...breakdownFields,
    }),
  ),
  solo: Schema.Struct({ threads: Schema.Int, ...breakdownFields }),
  /** The largest `USAGE_BREAKDOWN_THREADS`, largest first. */
  threads: Schema.Array(
    Schema.Struct({
      threadId: Schema.String,
      /** Null for a thread that is no longer stored, open or closed. */
      title: Schema.NullOr(Schema.String),
      workspaceId: Schema.NullOr(Schema.String),
      role: UsageThreadRole,
      ...breakdownFields,
    }),
  ),
  /** CLI sessions from local history with no matching Gram turn, by provider. */
  outside: Schema.Array(
    Schema.Struct({ provider: UsageProvider, sessions: Schema.Int, ...breakdownFields }),
  ),
});
export type UsageBreakdown = typeof UsageBreakdown.Type;
export const UsageOverview = Schema.Struct({
  from: Schema.Number,
  to: Schema.Number,
  /** Rolling period, grouped by the UTC date on which a turn started. */
  timezone: Schema.Literal("UTC"),
  provider: Schema.NullOr(UsageProvider),
  totals: UsageTotals,
  recordedTurns: Schema.Int,
  recordedConversations: Schema.Int,
  missingUsageTurns: Schema.Int,
  invalidUsageTurns: Schema.Int,
  /** Across the whole period: these cannot be assigned to a selected provider. Excluded from totals. */
  unattributedTurns: Schema.Int,
  unknownModelTurns: Schema.Int,
  incompleteCacheTurns: Schema.Int,
  interruptedTurns: Schema.Int,
  openTurns: Schema.Int,
  partialUsageTurns: Schema.optionalKey(Schema.Int),
  history: Schema.optionalKey(UsageHistoryCoverage),
  /** Opt-out applies to these local observations too. Currently supplied by Codex rollouts only. */
  localLimitHistory: Schema.optionalKey(UsageLocalLimitHistory),
  /** Absent from servers that predate it. */
  breakdown: Schema.optionalKey(UsageBreakdown),
  rows: Schema.Array(UsageOverviewRow),
});
export type UsageOverview = typeof UsageOverview.Type;
