/*
 * A guess at what a running turn has cost. The SDK prices a turn only in its `result`, so until
 * then the ticker would stand still through minutes of work. Nothing here is a bill: every figure
 * is replaced by the SDK's own the moment the turn ends.
 */
import type { ModelUsage } from "@anthropic-ai/claude-agent-sdk";
import type { TokenUsage } from "@gram/contracts";

/**
 * Historical ratios used for interim estimates, not a provider price sheet. Cache writes use
 * the 5-minute ratio; learned result rates can reflect a different cache policy. The result
 * replaces the estimate, and subscription usage does not imply a per-token charge.
 */
const WEIGHT = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } as const;

/** `tokens` in input-token equivalents; reasoning tokens are already inside `outputTokens`. */
export const weightedTokens = (tokens: TokenUsage): number =>
  tokens.inputTokens * WEIGHT.input +
  tokens.outputTokens * WEIGHT.output +
  (tokens.cacheReadTokens ?? 0) * WEIGHT.cacheRead +
  (tokens.cacheWriteTokens ?? 0) * WEIGHT.cacheWrite;

/**
 * USD per input token that the SDK's model list advertises for a model, which is where a session
 * that has priced nothing should look first: its descriptions end "… · $2/$10 per Mtok". `undefined`
 * for a description without one, as a gateway's models have.
 */
export const advertisedRate = (description: string | undefined): number | undefined => {
  const perMtok = /\$(\d+(?:\.\d+)?)\s*\/\s*\$\d+(?:\.\d+)?\s+per\s+Mtok/i.exec(
    description ?? "",
  )?.[1];
  return perMtok === undefined ? undefined : Number(perMtok) / 1e6;
};

/**
 * Historical USD per input token by family (Sonnet 4 and Haiku 4 kept apart). The last resort, for a session with
 * neither a result nor an advertised price, so being a generation behind here costs one turn's
 * estimate, not a bill.
 */
const LIST_RATES: ReadonlyArray<readonly [RegExp, number]> = [
  [/fable/i, 10e-6],
  [/opus/i, 5e-6],
  [/sonnet-4/i, 3e-6],
  [/sonnet/i, 2e-6],
  [/haiku-4/i, 1e-6],
  [/haiku/i, 0.1e-6],
];

/** The list rate for `model`'s family; `undefined` for an id that names none. */
export const listRate = (model: string): number | undefined =>
  LIST_RATES.find(([family]) => family.test(model))?.[1];

/**
 * USD per input-token equivalent that a `modelUsage` entry works out to; `undefined` for one that
 * has priced nothing, as right after a resume.
 */
export const learnedRate = (entry: ModelUsage): number | undefined => {
  const weight = weightedTokens({
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    cacheReadTokens: entry.cacheReadInputTokens,
    cacheWriteTokens: entry.cacheCreationInputTokens,
  });
  return entry.costUSD > 0 && weight > 0 ? entry.costUSD / weight : undefined;
};
