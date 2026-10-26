import * as Schema from "effect/Schema";
import type { ReasoningVariant } from "./domain.ts";
import { AgentModel, type AgentModel as ListedModel } from "./models.ts";

/** A helper destination chosen independently from a coding thread's agent or gateway. */
export const HelperSource = Schema.Literals(["automatic", "claude", "codex", "gateway"]);
export type HelperSource = typeof HelperSource.Type;

/** Separate consent for each local CLI's provider; absence grants nothing. */
export const HelperContextScope = Schema.Literals(["off", "opening", "conversation"]);
export type HelperContextScope = typeof HelperContextScope.Type;

/** Automatic crosses local providers only; no policy implicitly selects a gateway. */
export const HelperLocalFallback = Schema.Literals(["automatic", "none"]);
export type HelperLocalFallback = typeof HelperLocalFallback.Type;

/** A discovery result, never a claim of account entitlement or remaining plan usage. */
export const HelperProviderStatus = Schema.Struct({
  provider: Schema.Literals(["claude", "codex"]),
  state: Schema.Literals(["ready", "auth", "unavailable", "restriction"]),
  detail: Schema.String,
  mode: Schema.optional(Schema.Literals(["tool-free", "guided"])),
  models: Schema.Array(AgentModel),
});
export type HelperProviderStatus = typeof HelperProviderStatus.Type;

/** Only actual discovered identities are selected, including a CLI alias's resolved identity. */
export const localHelperModel = (
  provider: "claude" | "codex",
  models: ReadonlyArray<ListedModel>,
  saved?: string,
): ListedModel | undefined => {
  if (saved !== undefined)
    return models.find((row) => row.id === saved || row.resolvedId === saved);
  if (provider === "codex")
    return models.find((row) => row.id === "gpt-6-luna" || row.resolvedId === "gpt-6-luna");
  return models.find(
    (row) =>
      /^claude-haiku-5-5(?:-|$)/.test(row.resolvedId ?? row.id) ||
      ((row.resolvedId ?? row.id) === "haiku" && /^Haiku 5\.5(?:\s|$)/.test(row.displayName)),
  );
};

/** A kind of helper-model job; each has its own switch, cache row and budget line. */
export const HelperKind = Schema.Literals([
  "title",
  "plan",
  "recap",
  "suggest",
  "wait",
  "notice",
  "stuck",
]);
export type HelperKind = typeof HelperKind.Type;

/** One line of the usage ledger: a kind on a model, for one UTC day. */
export const HelperUsageLine = Schema.Struct({
  kind: HelperKind,
  model: Schema.String,
  calls: Schema.Int,
  inputTokens: Schema.Int,
  outputTokens: Schema.Int,
  /** Historical gateway token estimate; local subscription rows record zero dollars. */
  costUsd: Schema.Finite,
  failures: Schema.Int,
});
export type HelperUsageLine = typeof HelperUsageLine.Type;

/**
 * Why helper calls stopped: the daily budget is reached, or the gateway's cost guard disabled the
 * key. Both last until `until`, midnight UTC.
 */
export const HelperPause = Schema.Struct({
  reason: Schema.Literals(["budget", "keyDisabled"]),
  /** Epoch ms. */
  until: Schema.Int,
});
export type HelperPause = typeof HelperPause.Type;

/**
 * What suggested replies did over the last `SUGGEST_COUNTS_DAYS` UTC days, from `since` on: the
 * evidence for their kill criterion (`suggestKeepRate`).
 */
export const SuggestCounts = Schema.Struct({
  /** The first UTC day counted, `YYYY-MM-DD`. */
  since: Schema.String,
  shown: Schema.Int,
  /** Turns whose suggestions were taken, whole or a word at a time: what the rate counts. */
  taken: Schema.Int,
  accepted: Schema.Int,
  wordAccepted: Schema.Int,
  editedAfter: Schema.Int,
  dismissed: Schema.Int,
});
export type SuggestCounts = typeof SuggestCounts.Type;

/** The dogfood week the kill criterion is judged over. */
export const SUGGEST_COUNTS_DAYS = 7;

/** Today's helper usage, for Settings → AI helpers. */
export const HelperStatus = Schema.Struct({
  source: Schema.optionalKey(HelperSource),
  providers: Schema.optionalKey(Schema.Array(HelperProviderStatus)),
  /** Last content-free outcome, shown so automatic local fallback cannot hide auth/consent errors. */
  lastOutcome: Schema.optionalKey(Schema.String),
  /** The UTC day, `YYYY-MM-DD`. */
  day: Schema.String,
  calls: Schema.Int,
  inputTokens: Schema.Int,
  outputTokens: Schema.Int,
  costUsd: Schema.Finite,
  failures: Schema.Int,
  lines: Schema.Array(HelperUsageLine),
  dailyBudgetUsd: Schema.Finite,
  paused: Schema.optionalKey(HelperPause),
  /** Absent from a server that doesn't count them. */
  suggestions: Schema.optionalKey(SuggestCounts),
});
export type HelperStatus = typeof HelperStatus.Type;

export const HelperPresenceFields = {
  /**
   * The user is typing in a composer. Background helper jobs wait while they do and for a few
   * seconds after, so rows don't re-flow under their hands. Sent at most every 2 s.
   */
  typing: Schema.Boolean,
};

/** Same effective effort for Settings and generation. Unlisted explicit choices are never replaced. */
export const localHelperEffort = (
  model: ListedModel | undefined,
  saved?: ReasoningVariant,
): ReasoningVariant | undefined =>
  saved ?? (model?.supportsEffort && model.efforts?.includes("high") ? "high" : undefined);

export const localHelperEffortSupported = (
  model: ListedModel,
  effort: ReasoningVariant | undefined,
): boolean =>
  effort === undefined || (model.supportsEffort && model.efforts?.includes(effort) === true);
