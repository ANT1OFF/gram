import type { UsageSummary } from "@gram/contracts";

/** How full the context window is; each part only when the agent reported what it takes. */
export interface ContextUsage {
  /** The latest request's whole prompt. */
  tokens?: number;
  /** The model's window; a zero window is unknown, not empty. */
  window?: number;
  /** Whole percent of `window` that `tokens` fill, at most 100. */
  percent?: number;
}

type ContextReport = Pick<UsageSummary, "contextTokens" | "contextWindow">;

/**
 * The context the latest request filled, against the window. The turn's cumulative tokens count the
 * context once per tool call, so they're never a stand-in: usage without `contextTokens` gets no
 * meter. The ring, the meter and its token count, and the board's
 * fresh-session offer all read this. Apart from the meter's component so a model reads it without
 * React.
 */
export function contextUsage(usage: ContextReport): ContextUsage {
  const { contextTokens: tokens } = usage;
  const window = usage.contextWindow || undefined;
  return {
    ...(tokens === undefined ? {} : { tokens }),
    ...(window === undefined ? {} : { window }),
    ...(tokens === undefined || window === undefined
      ? {}
      : { percent: Math.min(100, Math.round((tokens / window) * 100)) }),
  };
}

/** Whole percent of the context window the latest request filled; see `contextUsage`. */
export const contextPercent = (usage: ContextReport): number | undefined =>
  contextUsage(usage).percent;
