import type { UsageSummary } from "@gram/contracts";
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";
import { NumberTicker, useMotionLevel } from "@/motion";
import { compactTokens } from "@/usage/usage-model";

import { contextUsage, type ContextUsage } from "./context-usage";

export { contextPercent, contextUsage, type ContextUsage } from "./context-usage";

const USD = { style: "currency", currency: "USD", minimumFractionDigits: 2 } as const;
const PERCENT = { style: "percent", maximumFractionDigits: 0 } as const;

export type ContextLevel = "normal" | "warning" | "critical";

/**
 * The raw tokens behind the percent: "138K / 200K tokens", or whichever side is known; `undefined`
 * when neither is.
 */
export function contextTokensLabel({ tokens, window }: ContextUsage): string | undefined {
  if (tokens !== undefined && window !== undefined)
    return `${compactTokens(tokens)} / ${compactTokens(window)} tokens`;
  if (tokens !== undefined) return `${compactTokens(tokens)} tokens in context`;
  if (window !== undefined) return `${compactTokens(window)} token window`;
  return undefined;
}

/**
 * Normal, then warning from 90%, then critical from 97%. Late on purpose: agents compact by
 * themselves, so a filling window is information, not a problem.
 */
export const contextLevel = (percent: number): ContextLevel =>
  percent >= 97 ? "critical" : percent >= 90 ? "warning" : "normal";

// Fills and the percent label use text-grade tokens, which the contrast matrix checks on every
// surface, so the bar holds the UI floor on its track and the label the text floor.
const TONE: Record<ContextLevel, string> = {
  normal: "[--meter:var(--color-primary)]",
  warning: "text-warning [--meter:var(--color-warning)]",
  critical: "text-destructive [--meter:var(--color-destructive)]",
};

/**
 * The context meter with the tokens it stands for and, where it applies, the cost ticker; the
 * context ring's popover.
 */
export function UsageBar({
  usage,
  countUp = true,
  showCost = false,
}: {
  usage: UsageSummary | undefined;
  /** Dollars too: only for a thread on a gateway's API key with Show dollar cost on (`costShown`). */
  showCost?: boolean;
  /**
   * Count the cost up between reports rather than roll straight to each. Only the focused pane does:
   * each step restyles every rolling digit, and four working panes counting at once cost ~19% of the
   * main thread.
   */
  countUp?: boolean;
}) {
  if (!usage) return null;
  const { costUsd, costEstimated } = usage;
  const context = contextUsage(usage);
  const tokens = contextTokensLabel(context);

  return (
    <div
      data-testid="usage"
      data-slot="usage-meter"
      className="flex items-center gap-3 py-1 text-[11px] whitespace-nowrap text-muted-foreground tabular-nums"
    >
      {context.percent !== undefined ? (
        <ContextMeter percent={context.percent} tokens={tokens} />
      ) : (
        <span data-testid="usage-context">{tokens ?? "Context not reported yet"}</span>
      )}
      {showCost && costUsd !== undefined && (
        <span
          data-testid="usage-cost"
          title={
            costEstimated
              ? "This thread so far. The running turn is an estimate until it ends."
              : "This thread so far"
          }
        >
          {costEstimated && "~"}
          <NumberTicker value={costUsd} format={USD} countUp={countUp} />
        </span>
      )}
    </div>
  );
}

function ContextMeter({ percent, tokens }: { percent: number; tokens: string | undefined }) {
  const motion = useMotionLevel();
  // At Full the fill grows in from empty when the meter first shows; otherwise it starts where it is.
  // Later changes glide through the fill's transition and roll the number.
  const [grown, setGrown] = useState(motion !== "full");
  useEffect(() => {
    if (grown) return;
    const frame = requestAnimationFrame(() => setGrown(true));
    return () => cancelAnimationFrame(frame);
  }, [grown]);
  const shown = grown ? percent : 0;
  const level = contextLevel(percent);

  return (
    <span data-level={level} className={cn("flex items-center gap-1.5", TONE[level])}>
      <span
        role="meter"
        aria-label="Context used"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={`${percent}% of the context window${tokens ? `, ${tokens}` : ""}`}
        className="h-1.5 w-16 overflow-hidden rounded-full bg-muted shadow-[0_0_8px_-3px_var(--meter)]"
      >
        <span
          data-testid="usage-fill"
          className="block h-full rounded-full bg-linear-to-r from-[color-mix(in_oklab,var(--meter)_55%,transparent)] to-(--meter) transition-[width] duration-(--dur-move-base) ease-(--ease-spring)"
          style={{ width: `${shown}%` }}
        />
      </span>
      <span data-testid="usage-context">
        <NumberTicker value={percent / 100} format={PERCENT} />
        {tokens && <span className="text-muted-foreground"> · {tokens}</span>}
      </span>
    </span>
  );
}
