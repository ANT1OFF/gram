import type { TokenUsage } from "@gram/contracts";

type Counts = TokenUsage;
const keys = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
] as const;
const zero = (): Counts => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
});
export function validCodexCounts(counts: Counts): boolean {
  return (
    keys.every(
      (key) =>
        counts[key] === undefined || (Number.isSafeInteger(counts[key]) && counts[key]! >= 0),
    ) &&
    Number.isSafeInteger(counts.inputTokens + counts.outputTokens) &&
    (counts.cacheReadTokens ?? 0) + (counts.cacheWriteTokens ?? 0) <= counts.inputTokens &&
    (counts.reasoningTokens ?? 0) <= counts.outputTokens
  );
}
export type CodexUsageBasis = "delta" | "last-request";
export const codexTelemetryVersion = (basis: CodexUsageBasis) =>
  basis === "delta" ? ("codex-request-delta-v1" as const) : ("codex-last-request-v1" as const);

/** Validate telemetry, preserving absent cache detail rather than guessing zero. */
export function codexCounts(value: unknown, snake = false): Counts | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const names = snake
    ? [
        "input_tokens",
        "output_tokens",
        "cached_input_tokens",
        "cache_write_input_tokens",
        "reasoning_output_tokens",
      ]
    : [
        "inputTokens",
        "outputTokens",
        "cachedInputTokens",
        "cacheWriteInputTokens",
        "reasoningOutputTokens",
      ];
  const counts: Record<string, number> = {};
  for (const [index, key] of keys.entries()) {
    const n = raw[names[index]!];
    if (n === undefined && index > 1) continue;
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) return undefined;
    counts[key] = n;
  }
  const result = counts as unknown as Counts;
  return validCodexCounts(result) ? result : undefined;
}

const same = (a: Counts, b: Counts) => keys.every((key) => a[key] === b[key]);
const primaryCounts = (c: Counts) => ({ inputTokens: c.inputTokens, outputTokens: c.outputTokens });
const primaryFits = (amount: Counts, progress: Counts | undefined) =>
  progress !== undefined &&
  amount.inputTokens <= progress.inputTokens &&
  amount.outputTokens <= progress.outputTokens;
const difference = (a: Counts, b: Counts): Counts | undefined => {
  const result: Record<string, number> = {};
  for (const key of keys) {
    if (a[key] === undefined || b[key] === undefined) continue;
    if (a[key]! < b[key]!) return undefined;
    result[key] = a[key]! - b[key]!;
  }
  if (result.inputTokens === undefined || result.outputTokens === undefined) return undefined;
  const counts = result as unknown as Counts;
  return validCodexCounts(counts) ? counts : undefined;
};
export const addCodexCounts = (a: Counts, b: Counts): Counts => {
  const result: Record<string, number> = {};
  for (const key of keys) {
    if (
      key !== "inputTokens" &&
      key !== "outputTokens" &&
      (a[key] === undefined || b[key] === undefined)
    )
      continue;
    result[key] = (a[key] ?? 0) + (b[key] ?? 0);
  }
  return result as unknown as Counts;
};

/** Session counters are a baseline, never a turn snapshot. A new mapper may be resuming history. */
export function makeCodexUsageLedger(fresh = false) {
  let previous: Counts | undefined = fresh ? zero() : undefined;
  // Overlap is an admission constraint, not a cumulative baseline or a known amount.
  // Losing telemetry or changing reception scope cannot make its stale last disjoint.
  let overlapPrimary: Pick<Counts, "inputTokens" | "outputTokens"> | undefined;
  let knownThisTurn = false,
    first = true,
    active = false,
    observedTotal = false,
    detailConflict = false;
  const invalidateBaseline = () => {
    previous = undefined;
    observedTotal = false;
  };
  const endTurn = () => {
    // No report cannot certify that an intervening turn left session counters unchanged.
    if (active && !observedTotal) previous = undefined;
    active = false;
    observedTotal = false;
  };
  const seen = new Set<string>();
  let seenBytes = 0;
  return {
    // Cumulative continuity and current-scope replay protection have separate lifetimes.
    invalidateBaseline,
    endTurn,
    startTurn() {
      endTurn();
      active = true;
      knownThisTurn = false;
      first = true;
      seen.clear();
      seenBytes = 0;
    },
    // Read-only observed session evidence for the history producer coverage check.
    baseline: () => (previous === undefined ? undefined : { ...previous }),
    // Private producer evidence; never a wire/provenance marker or a token amount.
    detailConflict: () => detailConflict,
    retainedBytes() {
      return (
        seenBytes +
        (previous === undefined ? 0 : JSON.stringify(previous).length) +
        (overlapPrimary === undefined ? 0 : JSON.stringify(overlapPrimary).length)
      );
    },
    observe(
      total: Counts | undefined,
      last: Counts | undefined,
    ): { tokens?: Counts; basis?: CodexUsageBasis; partial: boolean } {
      detailConflict = false;
      if (
        (total !== undefined && !validCodexCounts(total)) ||
        (last !== undefined && !validCodexCounts(last))
      ) {
        invalidateBaseline();
        return { partial: true };
      }
      if (total === undefined && last === undefined) {
        invalidateBaseline();
        return { partial: true };
      }
      if (
        total !== undefined &&
        last !== undefined &&
        keys.some(
          (key) => total[key] !== undefined && last[key] !== undefined && total[key]! < last[key]!,
        )
      ) {
        invalidateBaseline();
        return { partial: true };
      }
      const stamp = JSON.stringify([total, last]);
      if (seen.has(stamp)) return { partial: false };
      if (seen.size >= 4096) {
        // A refused increment must not be allocated to the next actual request.
        invalidateBaseline();
        return { partial: true };
      }
      seen.add(stamp);
      seenBytes += stamp.length;
      const initial = first;
      first = false;
      if (total !== undefined) {
        const before = previous;
        previous = total;
        observedTotal = true;
        const stablePrimary =
          (before !== undefined &&
            total.inputTokens === before.inputTokens &&
            total.outputTokens === before.outputTokens) ||
          (overlapPrimary !== undefined &&
            total.inputTokens === overlapPrimary.inputTokens &&
            total.outputTokens === overlapPrimary.outputTokens);
        const observedProgress =
          before === undefined
            ? undefined
            : difference(primaryCounts(total), primaryCounts(before));
        if (overlapPrimary !== undefined) {
          const reset =
            total.inputTokens < overlapPrimary.inputTokens ||
            total.outputTokens < overlapPrimary.outputTokens;
          const supportedLast =
            last !== undefined &&
            last.inputTokens + last.outputTokens > 0 &&
            primaryFits(last, difference(primaryCounts(total), overlapPrimary));
          // This pair constrains admission; it never supplies a missing delta baseline.
          // Insufficient progress remains constrained at the latest observed primary.
          overlapPrimary = reset || supportedLast ? undefined : primaryCounts(total);
        }
        if (
          total.inputTokens + total.outputTokens > 0 &&
          (stablePrimary ||
            (last !== undefined &&
              last.inputTokens + last.outputTokens > 0 &&
              observedProgress !== undefined &&
              !primaryFits(last, observedProgress)))
        )
          overlapPrimary = primaryCounts(total);
        if (
          before !== undefined &&
          same(total, before) &&
          !(
            initial &&
            (total.inputTokens + total.outputTokens === 0 ||
              (last !== undefined && last.inputTokens + last.outputTokens === 0))
          )
        )
          return {
            partial: initial && last !== undefined && last.inputTokens + last.outputTokens > 0,
          };
        // Auxiliary refinements cannot prove another request when primary counters
        // have not advanced. A reception scope change does not prove disjointness.
        if (stablePrimary) {
          detailConflict = keys
            .slice(2)
            .some(
              (key) =>
                before?.[key] !== undefined &&
                total[key] !== undefined &&
                before[key] !== total[key],
            );
          // Explicit zero is independent evidence of a zero request, even when
          // auxiliary refinement prevents a complete session-counter difference.
          if (
            initial &&
            (total.inputTokens + total.outputTokens === 0 ||
              (last !== undefined && last.inputTokens + last.outputTokens === 0))
          ) {
            const delta = before === undefined ? undefined : difference(total, before);
            if (delta !== undefined) {
              knownThisTurn = true;
              return { tokens: delta, basis: "delta", partial: false };
            }
            if (last !== undefined && last.inputTokens + last.outputTokens === 0) {
              knownThisTurn = true;
              return { tokens: last, basis: "last-request", partial: true };
            }
          }
          return { partial: true };
        }
        const delta = before === undefined ? undefined : difference(total, before);
        if (delta !== undefined) {
          knownThisTurn = true;
          return { tokens: delta, basis: "delta", partial: false };
        }
        // Invalid auxiliary differences do not erase a proven primary increment.
        // A mismatching latest-last snapshot cannot certify a disjoint larger amount.
        if (before !== undefined) {
          const primary = difference(
            { inputTokens: total.inputTokens, outputTokens: total.outputTokens },
            { inputTokens: before.inputTokens, outputTokens: before.outputTokens },
          );
          if (
            primary !== undefined &&
            primary.inputTokens + primary.outputTokens > 0 &&
            (last === undefined ||
              last.inputTokens !== primary.inputTokens ||
              last.outputTokens !== primary.outputTokens)
          ) {
            knownThisTurn = true;
            detailConflict = true;
            return { tokens: primary, basis: "delta", partial: true };
          }
        }
        // With no baseline (or after a reset), the last request is authoritative; totals are not.
        if (last !== undefined && (before !== undefined || !knownThisTurn)) {
          if (overlapPrimary !== undefined && last.inputTokens + last.outputTokens > 0)
            return { partial: true };
          knownThisTurn = true;
          return { tokens: last, basis: "last-request", partial: true };
        }
        return { partial: true };
      }
      invalidateBaseline();
      // Without totals/response IDs, updates and distinct requests cannot be distinguished.
      // Keep one proven request, then wait for an observed total baseline before adding deltas.
      if (last === undefined || knownThisTurn) return { partial: true };
      if (overlapPrimary !== undefined && last.inputTokens + last.outputTokens > 0)
        return { partial: true };
      knownThisTurn = true;
      return { tokens: last, basis: "last-request", partial: true };
    },
  };
}
