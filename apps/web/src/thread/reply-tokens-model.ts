import type { UsageSummary } from "@gram/contracts";

import { compactTokens, wholeTokens } from "@/usage/usage-model";

import { contextUsage, type ContextUsage } from "./context-usage";

// The tokens a turn used, as its last reply shows them: one short count beside the reply's time,
// and what makes it up behind it. No React.

export interface TokenRow {
  readonly key: "input" | "cacheRead" | "cacheWrite" | "output" | "reasoning";
  readonly label: string;
  /** "41,000". */
  readonly value: string;
  readonly tokens: number;
  /** Shown indented, under the row it is part of: thinking is part of the output. */
  readonly part?: true;
}

export interface ReplyTokens {
  /** Every token the turn's requests read or wrote. */
  readonly total: number;
  /** "44K tokens", or "≥ 44K tokens" when the agent's report had no trustworthy baseline. */
  readonly label: string;
  readonly rows: readonly TokenRow[];
  /** How full the window was after the turn, when the agent says. */
  readonly context: ContextUsage;
  /** The counts are a lower bound. */
  readonly partial: boolean;
}

/** What a reply's usage stamp says; `undefined` for a reply without one, or a turn that used none. */
export function replyTokens(usage: UsageSummary | undefined): ReplyTokens | undefined {
  if (usage === undefined) return undefined;
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens } =
    usage.tokens;
  const total = inputTokens + outputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0);
  if (total === 0) return undefined;
  const partial = usage.partial === true;
  const row = (key: TokenRow["key"], label: string, tokens: number): TokenRow => ({
    key,
    label,
    tokens,
    value: wholeTokens(tokens),
  });
  const rows: TokenRow[] = [row("input", "Input", inputTokens)];
  if (cacheReadTokens !== undefined && cacheReadTokens > 0)
    rows.push(row("cacheRead", "Cache read", cacheReadTokens));
  if (cacheWriteTokens !== undefined && cacheWriteTokens > 0)
    rows.push(row("cacheWrite", "Cache write", cacheWriteTokens));
  rows.push(row("output", "Output", outputTokens));
  if (reasoningTokens !== undefined && reasoningTokens > 0)
    rows.push({ ...row("reasoning", "Thinking", reasoningTokens), part: true });
  return {
    total,
    label: `${partial ? "≥ " : ""}${compactTokens(total)} tokens`,
    rows,
    context: contextUsage(usage),
    partial,
  };
}

/** Whole percent of all the turn's tokens that came from the prompt cache; `undefined` with none. */
export const cachedShare = (tokens: ReplyTokens): number | undefined => {
  const read = tokens.rows.find((row) => row.key === "cacheRead")?.tokens;
  return read === undefined ? undefined : Math.round((read / tokens.total) * 100);
};
