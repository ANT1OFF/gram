import { UsageSummary, type UsageHistoryCoverage } from "@gram/contracts";
import { validUsageTokens, type UsageRecord } from "./aggregate.ts";
import type { HistoryScan } from "./history-reader.ts";
import { identity, type HistoryRecord } from "./history-records.ts";
import { decodeStored } from "../persistence/stored.ts";
import { addCodexCounts, codexTelemetryVersion, validCodexCounts } from "@gram/agents/codex";

import { canonicalHistory, historyKey as key } from "./history-canonical.ts";
const nativeKey = (provider: string, session: string, id: string) =>
  JSON.stringify([provider, session, id]);
const nativeIds = (raw: string | null | undefined): string[] | undefined => {
  if (raw == null) return undefined;
  const ids = new Set<string>();
  try {
    for (const line of raw.split("\n")) {
      const values: unknown = JSON.parse(line);
      if (!Array.isArray(values) || values.length === 0 || values.length > 128) return undefined;
      for (const value of values) {
        if (identity(value) === undefined || typeof value !== "string") return undefined;
        ids.add(value);
        if (ids.size > 128) return undefined;
      }
    }
  } catch {
    return undefined;
  }
  return [...ids];
};

const fromHistory = (record: HistoryRecord, source?: UsageRecord): UsageRecord => ({
  thread_id: source?.thread_id ?? JSON.stringify(["cli", record.provider, record.session]),
  started_at: source?.started_at ?? record.at,
  ended_at: source?.ended_at ?? record.at,
  reason: source?.reason ?? "completed",
  agent: record.provider,
  model: record.model,
  ...(record.cacheIncomplete === true ? { cache_incomplete: true } : {}),
  usage: JSON.stringify({
    tokens: record.tokens,
    ...(record.partial || !record.complete ? { partial: true } : {}),
    ...(record.provider === "codex" && record.basis !== undefined
      ? { telemetryVersion: codexTelemetryVersion(record.basis) }
      : {}),
  }),
});

/** Exact provider + captured session + native IDs only. No current thread model/session inference. */
export function mergeHistoryUsage(
  gram: readonly UsageRecord[],
  scan: HistoryScan,
): { records: UsageRecord[]; coverage: UsageHistoryCoverage } {
  const canonical = canonicalHistory(scan.records, scan.provenance),
    unique = canonical.unique;
  let ambiguousRecords = scan.ambiguous + canonical.uncertain,
    omittedRecords = canonical.omittedRecords;
  const sessions = new Map<string, Set<string>>();
  const incompleteAncestry = new Set<string>();
  for (const proof of scan.provenance ?? []) {
    const id = JSON.stringify([proof.provider, proof.session]);
    const known = sessions.get(id) ?? new Set<string>();
    for (const native of proof.nativeIds) known.add(native);
    sessions.set(id, known);
    if (!proof.complete) incompleteAncestry.add(id);
  }
  for (const record of unique.values()) {
    const id = JSON.stringify([record.provider, record.session]);
    const turns = sessions.get(id) ?? new Set<string>();
    for (const native of record.nativeIds) turns.add(native);
    sessions.set(id, turns);
  }
  // Fork inheritance is identified against the actual parent's stable native IDs, never by time.
  for (const [id, record] of unique) {
    if (record.parent === null) continue;
    const parent = sessions.get(JSON.stringify([record.provider, record.parent]));
    if (parent === undefined || record.nativeIds.length === 0) {
      unique.delete(id);
      ambiguousRecords++;
      omittedRecords++;
      continue;
    }
    if (record.nativeIds.every((native) => parent.has(native))) {
      unique.delete(id);
      omittedRecords++;
    } else if (incompleteAncestry.has(JSON.stringify([record.provider, record.parent]))) {
      unique.delete(id);
      ambiguousRecords++;
      omittedRecords++;
    }
  }
  const uncertainProviders = new Set(canonical.uncertainProviders);
  for (const source of scan.sources)
    if (source.status === "partial") uncertainProviders.add(source.provider);
  const indexed = new Map<string, HistoryRecord>();
  const nativeConflicts = new Set<string>();
  for (const record of unique.values()) {
    for (const id of record.nativeIds) {
      const scoped = nativeKey(record.provider, record.session, id);
      const previous = indexed.get(scoped);
      if (previous !== undefined && key(previous) !== key(record)) {
        nativeConflicts.add(key(previous));
        nativeConflicts.add(key(record));
      } else indexed.set(scoped, record);
    }
  }
  for (const id of nativeConflicts) {
    unique.delete(id);
    ambiguousRecords++;
    omittedRecords++;
  }
  for (const [id, record] of indexed) if (nativeConflicts.has(key(record))) indexed.delete(id);
  const gramClaims = new Map<string, UsageRecord>(),
    duplicateGram = new Set<UsageRecord>();
  for (const record of gram) {
    const session = identity(record.source_session),
      ids = nativeIds(record.native_ids);
    if (session === undefined || ids === undefined || record.agent == null) continue;
    for (const id of ids) {
      const scoped = nativeKey(record.agent, session, id),
        previous = gramClaims.get(scoped);
      if (previous !== undefined && previous !== record) {
        duplicateGram.add(previous);
        duplicateGram.add(record);
      } else gramClaims.set(scoped, record);
    }
  }
  const used = new Set<string>(),
    result: UsageRecord[] = [];
  let matchedTurns = 0,
    unmatchedGramTurns = 0,
    untrustedGramTurns = 0,
    importedRecords = 0,
    matchedRecords = 0,
    overlappingRecords = 0,
    ambiguousGramTurns = 0;
  const providersWithHistory = new Set([...unique.values()].map((record) => record.provider));
  const negativeProof = new Map<string, boolean>(),
    observedIds = new Map<string, Set<string>>();
  for (const provider of ["codex", "claude"])
    negativeProof.set(
      provider,
      !uncertainProviders.has(provider) &&
        scan.sources.every((source) => source.provider !== provider || source.status !== "partial"),
    );
  for (const candidate of unique.values()) {
    const ids = observedIds.get(candidate.provider) ?? new Set<string>();
    for (const id of candidate.nativeIds) ids.add(id);
    observedIds.set(candidate.provider, ids);
    if (!candidate.complete || candidate.nativeIds.length === 0)
      negativeProof.set(candidate.provider, false);
  }
  for (const record of gram) {
    const ids = nativeIds(record.native_ids),
      session = identity(record.source_session);
    const supported = record.agent === "codex" || record.agent === "claude";
    const candidates =
      !supported || ids === undefined || session === undefined
        ? []
        : ids.flatMap((id) => {
            const candidate = indexed.get(nativeKey(record.agent!, session, id));
            return candidate === undefined ? [] : [candidate];
          });
    const matched = [
      ...new Map(candidates.map((candidate) => [key(candidate), candidate])).values(),
    ];
    const identityCovered =
      ids !== undefined &&
      ids.length > 0 &&
      session !== undefined &&
      !duplicateGram.has(record) &&
      ids.every((id) => indexed.has(nativeKey(record.agent!, session, id))) &&
      matched.every(
        (candidate) =>
          candidate.nativeIds.every((id) => ids.includes(id)) && !used.has(key(candidate)),
      );
    const completeContext = identityCovered && matched.every((candidate) => candidate.complete);
    const fullyCovered = completeContext && matched.every((candidate) => !candidate.partial);
    const cliModel = matched.every(
      (candidate) => candidate.model !== null && candidate.model === matched[0]?.model,
    )
      ? (matched[0]?.model ?? null)
      : null;
    const modelConflict =
      record.model_conflict === 1 ||
      new Set(matched.flatMap((candidate) => (candidate.model === null ? [] : [candidate.model])))
        .size > 1 ||
      matched.some(
        (candidate) =>
          candidate.modelConflict ||
          ((record.model_witness ?? record.model) !== null &&
            (candidate.modelWitness ?? candidate.model) !== null &&
            (record.model_witness ?? record.model) !== (candidate.modelWitness ?? candidate.model)),
      );
    if (fullyCovered && record.ended_at !== null) {
      matchedTurns++;
      matchedRecords += matched.length;
      const first = matched[0]!;
      let tokens = first.tokens;
      for (const candidate of matched.slice(1)) tokens = addCodexCounts(tokens, candidate.tokens);
      const combined = {
        ...first,
        tokens,
        model: modelConflict ? null : (cliModel ?? record.model),
      };
      for (const candidate of matched) used.add(key(candidate));
      result.push(fromHistory(combined, record));
      continue;
    }
    const decoded = record.usage === null ? undefined : decodeStored(UsageSummary, record.usage);
    const validAmount =
      decoded?.ok === true && validUsageTokens(record.agent, decoded.value.tokens);
    const normalized =
      decoded?.ok === true &&
      validCodexCounts(decoded.value.tokens) &&
      (decoded.value.telemetryVersion === "codex-request-delta-v1" ||
        (decoded.value.telemetryVersion === "codex-last-request-v1" &&
          decoded.value.partial === true));
    // Codex amounts without a request telemetry version can contain session totals. Unscoped Claude
    // amounts cannot safely be combined with CLI requests. Excluded amounts are unknown, not lower
    // bounds or repaired rows.
    const independentClaude =
      record.agent === "claude" &&
      ids !== undefined &&
      negativeProof.get("claude") === true &&
      ids.every((id) => !observedIds.get("claude")?.has(id));
    const untrusted = record.agent === "codex" && record.usage !== null && !normalized;
    const uncertainClaudeOverlap =
      record.agent === "claude" &&
      providersWithHistory.has("claude") &&
      !fullyCovered &&
      (session === undefined || sessions.has(JSON.stringify(["claude", session]))) &&
      !independentClaude &&
      (ids === undefined ||
        matched.length === 0 ||
        matched.some((candidate) => candidate.nativeIds.some((id) => !ids.includes(id)))) &&
      negativeProof.get("claude") !== true;
    const ambiguousGram =
      supported &&
      (uncertainClaudeOverlap ||
        duplicateGram.has(record) ||
        (providersWithHistory.has(record.agent as "codex" | "claude") &&
          ((session === undefined && !independentClaude) ||
            (ids === undefined && sessions.has(JSON.stringify([record.agent, session]))))));
    if (record.ended_at !== null && (untrusted || ambiguousGram)) {
      if (untrusted) untrustedGramTurns++;
      else ambiguousGramTurns++;
      continue;
    }
    unmatchedGramTurns++;
    const recoverModel =
      record.agent === "codex" &&
      normalized &&
      record.ended_at !== null &&
      record.model_conflict === 0 &&
      completeContext &&
      !modelConflict &&
      cliModel !== null;
    result.push(
      modelConflict
        ? { ...record, model: null }
        : recoverModel && record.model === null
          ? { ...record, model: cliModel }
          : record,
    );
    // Missing/invalid/open Gram snapshots contribute no tokens: their CLI requests remain visible.
    // Only a valid included amount may suppress an incomplete exact overlap, including real zero.
    if (record.ended_at !== null && validAmount)
      for (const candidate of matched) {
        used.add(key(candidate));
        overlappingRecords++;
      }
  }
  for (const record of unique.values()) {
    if (used.has(key(record))) continue;
    result.push(fromHistory(record));
    importedRecords++;
  }
  return {
    records: result,
    coverage: {
      sources: scan.sources,
      importedRecords,
      matchedTurns,
      unmatchedGramTurns,
      untrustedGramTurns,
      ambiguousRecords,
      ambiguousGramTurns,
      selectedGramTurns: gram.length,
      historyRecords: scan.records.length,
      matchedRecords,
      overlappingRecords,
      omittedRecords,
      duplicateRecords: canonical.duplicateRecords,
      coalescedRecords: canonical.coalescedRecords,
      supersededRecords: canonical.supersededRecords,
    },
  };
}
