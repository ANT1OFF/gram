import type { TokenUsage } from "@gram/contracts";
import * as Predicate from "effect/Predicate";

type Counts = TokenUsage;
const keys = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
] as const;
const OPTIONAL_KEYS = ["cacheReadTokens", "cacheWriteTokens", "reasoningTokens"] as const;
type OptionalCounts = Partial<Record<(typeof OPTIONAL_KEYS)[number], number>>;
const isCount = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
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
      (key) => counts[key] === undefined || (Number.isSafeInteger(counts[key]) && counts[key] >= 0),
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
  if (!Predicate.isObject(value)) return undefined;
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
  const [inputTokens, outputTokens] = [value[names[0]!], value[names[1]!]];
  if (!isCount(inputTokens) || !isCount(outputTokens)) return undefined;
  const optional: OptionalCounts = {};
  for (const [index, key] of OPTIONAL_KEYS.entries()) {
    const n = value[names[index + 2]!];
    if (n === undefined) continue;
    if (!isCount(n)) return undefined;
    optional[key] = n;
  }
  const result: Counts = { inputTokens, outputTokens, ...optional };
  return validCodexCounts(result) ? result : undefined;
}

const same = (a: Counts, b: Counts) => keys.every((key) => a[key] === b[key]);
const primaryCounts = (c: Counts) => ({ inputTokens: c.inputTokens, outputTokens: c.outputTokens });
const primaryFits = (amount: Counts, progress: Counts | undefined) =>
  progress !== undefined &&
  amount.inputTokens <= progress.inputTokens &&
  amount.outputTokens <= progress.outputTokens;
const difference = (a: Counts, b: Counts): Counts | undefined => {
  if (a.inputTokens < b.inputTokens || a.outputTokens < b.outputTokens) return undefined;
  const optional: OptionalCounts = {};
  for (const key of OPTIONAL_KEYS) {
    const [x, y] = [a[key], b[key]];
    if (x === undefined || y === undefined) continue;
    if (x < y) return undefined;
    optional[key] = x - y;
  }
  const counts: Counts = {
    inputTokens: a.inputTokens - b.inputTokens,
    outputTokens: a.outputTokens - b.outputTokens,
    ...optional,
  };
  return validCodexCounts(counts) ? counts : undefined;
};
export const addCodexCounts = (a: Counts, b: Counts): Counts => {
  const optional: OptionalCounts = {};
  for (const key of OPTIONAL_KEYS) {
    const [x, y] = [a[key], b[key]];
    if (x !== undefined && y !== undefined) optional[key] = x + y;
  }
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...optional,
  };
};

/** Session counters are a baseline, never a turn snapshot. A new mapper may be resuming history. */
export function makeCodexUsageLedger(fresh = false) {
  let previous: Counts | undefined = fresh ? zero() : undefined;
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
    if (active && !observedTotal) previous = undefined;
    active = false;
    observedTotal = false;
  };
  const seen = new Set<string>();
  let seenBytes = 0;
  return {
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
    baseline: () => (previous === undefined ? undefined : { ...previous }),
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
          (key) => total[key] !== undefined && last[key] !== undefined && total[key] < last[key],
        )
      ) {
        invalidateBaseline();
        return { partial: true };
      }
      const stamp = JSON.stringify([total, last]);
      if (seen.has(stamp)) return { partial: false };
      if (seen.size >= 4096) {
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
        if (stablePrimary) {
          detailConflict = keys
            .slice(2)
            .some(
              (key) =>
                before?.[key] !== undefined &&
                total[key] !== undefined &&
                before[key] !== total[key],
            );
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
        if (last !== undefined && (before !== undefined || !knownThisTurn)) {
          if (overlapPrimary !== undefined && last.inputTokens + last.outputTokens > 0)
            return { partial: true };
          knownThisTurn = true;
          return { tokens: last, basis: "last-request", partial: true };
        }
        return { partial: true };
      }
      invalidateBaseline();
      if (last === undefined || knownThisTurn) return { partial: true };
      if (overlapPrimary !== undefined && last.inputTokens + last.outputTokens > 0)
        return { partial: true };
      knownThisTurn = true;
      return { tokens: last, basis: "last-request", partial: true };
    },
  };
}
