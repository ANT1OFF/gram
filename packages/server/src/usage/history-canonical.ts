import { addCodexCounts, validCodexCounts } from "@gram/agents/codex";
import type { TokenUsage } from "@gram/contracts";
import type { HistoryRecord } from "./history-types.ts";

export const historyKey = (record: HistoryRecord) =>
  JSON.stringify([record.provider, record.session, record.id]);
const signature = (record: HistoryRecord) =>
  JSON.stringify([record.turn ?? null, record.model, record.at, record.tokens]);
const equalCounts = (a: TokenUsage, b: TokenUsage) =>
  ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens"].every(
    (key) => a[key as keyof TokenUsage] === b[key as keyof TokenUsage],
  );
const overlappingMinimum = (a: TokenUsage, b: TokenUsage): TokenUsage | undefined => {
  const minimum = Object.fromEntries(
    [
      "inputTokens",
      "outputTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
      "reasoningTokens",
    ].flatMap((key) => {
      const lane = key as keyof TokenUsage;
      return a[lane] === undefined && b[lane] === undefined
        ? []
        : [[key, Math.max(a[lane] ?? 0, b[lane] ?? 0)]];
    }),
  ) as unknown as TokenUsage;
  return validCodexCounts(minimum) ? minimum : undefined;
};

const validRequirement = (value: TokenUsage | undefined): value is TokenUsage =>
  value !== undefined && value !== null && typeof value === "object" && validCodexCounts(value);
// Independent copies constrain the same request; requirements never add amounts.
const mergeRequirements = (a: TokenUsage | undefined, b: TokenUsage | undefined) => {
  if (!validRequirement(a)) return validRequirement(b) ? { ...b } : undefined;
  if (!validRequirement(b)) return { ...a };
  return overlappingMinimum(a, b);
};

/** Deduplicate completed requests before grouping modern Codex requests into native turns. */
export function canonicalHistory(
  input: readonly HistoryRecord[],
  provenance: readonly { provider: string; session: string; fileIdentity?: string }[] = [],
) {
  const unique = new Map<string, HistoryRecord>(),
    conflicts = new Set<string>();
  let duplicateRecords = 0,
    omittedRecords = 0,
    supersededRecords = 0,
    coalescedRecords = 0,
    uncertain = 0;
  const uncertainProviders = new Set<string>();
  const origins = new Map<string, Set<string>>();
  for (const record of [...input, ...provenance]) {
    if (record.provider !== "codex") continue;
    const scope = JSON.stringify([record.provider, record.session]);
    const sources = origins.get(scope) ?? new Set<string>();
    sources.add(record.fileIdentity ?? "unknown-origin");
    origins.set(scope, sources);
  }
  for (const record of input) {
    const uncertainCopy =
      record.provider === "codex" &&
      record.nativeIds.length === 0 &&
      (origins.get(JSON.stringify([record.provider, record.session]))?.size ?? 0) > 1;
    if (!record.trusted || uncertainCopy) {
      omittedRecords++;
      uncertain++;
      uncertainProviders.add(record.provider);
      continue;
    }
    const id = historyKey(record),
      previous = unique.get(id);
    if (conflicts.has(id)) {
      omittedRecords++;
      continue;
    }
    if (previous !== undefined && signature(previous) !== signature(record)) {
      unique.delete(id);
      conflicts.add(id);
      omittedRecords += 2;
      uncertain++;
      uncertainProviders.add(record.provider);
      continue;
    }
    if (previous === undefined) {
      const copy = structuredClone(record);
      if (
        copy.provider === "codex" &&
        copy.turn !== undefined &&
        !validRequirement(copy.expectedTurnTokens)
      ) {
        copy.complete = false;
        delete copy.expectedTurnTokens;
      }
      unique.set(id, copy);
      continue;
    }
    duplicateRecords++;
    const ids = new Set([...previous.nativeIds, ...record.nativeIds]);
    if (ids.size > 128) {
      previous.complete = false;
      uncertain++;
      uncertainProviders.add(record.provider);
    }
    previous.nativeIds = [...ids].slice(0, 128);
    previous.complete &&= record.complete;
    if (previous.provider === "codex" && previous.turn !== undefined) {
      const requirement = mergeRequirements(previous.expectedTurnTokens, record.expectedTurnTokens);
      if (
        !validRequirement(previous.expectedTurnTokens) ||
        !validRequirement(record.expectedTurnTokens) ||
        requirement === undefined
      )
        previous.complete = false;
      if (requirement === undefined) delete previous.expectedTurnTokens;
      else previous.expectedTurnTokens = requirement;
    }
    previous.partial ||= record.partial;
    if (record.cacheIncomplete) previous.cacheIncomplete = true;
    if (record.modelConflict) previous.modelConflict = true;
    if (
      previous.modelWitness !== undefined &&
      record.modelWitness !== undefined &&
      previous.modelWitness !== record.modelWitness
    ) {
      previous.modelConflict = true;
      previous.model = null;
    }
    if (previous.modelWitness === undefined && record.modelWitness !== undefined)
      previous.modelWitness = record.modelWitness;
    previous.turnComplete ||= record.turnComplete === true;
    if (record.basis === "last-request") previous.basis = "last-request";
  }
  const modern = new Map<string, HistoryRecord[]>();
  for (const record of unique.values())
    if (record.provider === "codex" && record.turn !== undefined) {
      const id = JSON.stringify([record.provider, record.session, record.turn]);
      const group = modern.get(id) ?? [];
      group.push(record);
      modern.set(id, group);
    }
  for (const group of modern.values()) {
    const first = group[0]!,
      turn = first.turn!;
    let tokens = first.tokens,
      expected = first.expectedTurnTokens,
      requirementsValid = validRequirement(expected);
    for (const record of group.slice(1)) {
      tokens = addCodexCounts(tokens, record.tokens);
      expected = mergeRequirements(expected, record.expectedTurnTokens);
      requirementsValid &&= validRequirement(record.expectedTurnTokens) && expected !== undefined;
    }
    for (const record of group) unique.delete(historyKey(record));
    if (!validCodexCounts(tokens)) {
      omittedRecords += group.length;
      uncertain++;
      uncertainProviders.add(first.provider);
      continue;
    }
    coalescedRecords += group.length - 1;
    const knownModels = [
      ...new Set(
        group.flatMap((record) =>
          record.modelWitness !== undefined
            ? [record.modelWitness]
            : record.model === null
              ? []
              : [record.model],
        ),
      ),
    ];
    const mixedModels = group.some((record) => record.modelConflict) || knownModels.length > 1;
    const combined: HistoryRecord = {
      ...first,
      id: turn,
      tokens,
      model:
        !mixedModels && group.every((record) => record.model === first.model) ? first.model : null,
      complete:
        requirementsValid &&
        validRequirement(expected) &&
        equalCounts(tokens, expected) &&
        group.every(
          (record) =>
            record.complete &&
            record.turnComplete &&
            validRequirement(record.expectedTurnTokens) &&
            [
              "inputTokens",
              "outputTokens",
              "cacheReadTokens",
              "cacheWriteTokens",
              "reasoningTokens",
            ].every((key) => {
              const lane = key as keyof TokenUsage;
              const required = record.expectedTurnTokens![lane] ?? 0;
              return required === 0 || (tokens[lane] !== undefined && tokens[lane]! >= required);
            }),
        ),
      partial: group.some((record) => record.partial),
      ...(mixedModels ? { modelConflict: true } : {}),
      ...(knownModels[0] === undefined ? {} : { modelWitness: knownModels[0] }),
      ...(group.some((record) => record.cacheIncomplete) ? { cacheIncomplete: true } : {}),
    };
    if (expected === undefined) delete combined.expectedTurnTokens;
    else combined.expectedTurnTokens = expected;
    const old = unique.get(historyKey(combined));
    if (old !== undefined) {
      if (old.complete && !old.partial && !equalCounts(old.tokens, tokens)) {
        combined.complete = false;
        uncertain++;
        uncertainProviders.add(first.provider);
      }
      // These representations overlap; neither summing them nor choosing the
      // smaller incomplete projection preserves previously proven contributions.
      // Keep lane minima only when their sum/subsets remain representable and safe.
      if (old.basis !== undefined && validCodexCounts(old.tokens)) {
        const minimum = overlappingMinimum(old.tokens, tokens);
        if (minimum === undefined || !equalCounts(minimum, tokens)) {
          combined.tokens = minimum ?? old.tokens;
          combined.complete = false;
          combined.partial = true;
          if (equalCounts(combined.tokens, old.tokens)) {
            combined.at = old.at;
            combined.basis = old.basis;
            combined.model = old.model;
            if (old.cacheIncomplete || minimum === undefined) combined.cacheIncomplete = true;
            else delete combined.cacheIncomplete;
          } else {
            combined.model = old.model === combined.model ? combined.model : null;
            // Lane minima from overlapping sources are not a full cache split of
            // this new primary minimum, even when both cache lanes have witnesses.
            combined.cacheIncomplete = true;
          }
          if (minimum === undefined) {
            uncertain++;
            uncertainProviders.add(first.provider);
          }
        }
      }
      const witnesses = new Set(
        [old.model, old.modelWitness, combined.model, combined.modelWitness].filter(
          (model): model is string => model != null,
        ),
      );
      if (old.modelConflict || combined.modelConflict || witnesses.size > 1) {
        combined.model = null;
        combined.modelConflict = true;
      }
      const witness = witnesses.values().next().value;
      if (combined.modelWitness === undefined && witness !== undefined)
        combined.modelWitness = witness;
      unique.delete(historyKey(combined));
      supersededRecords++;
    }
    unique.set(historyKey(combined), combined);
  }
  return {
    unique,
    duplicateRecords,
    omittedRecords,
    supersededRecords,
    coalescedRecords,
    uncertain,
    uncertainProviders,
  };
}
