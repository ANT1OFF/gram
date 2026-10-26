import {
  UsageSummary,
  type UsageOverview,
  type UsageOverviewQuery,
  type UsageOverviewRow,
  type UsageProvider,
  type UsageTotals,
  type TokenUsage,
} from "@gram/contracts";
import { decodeStored } from "../persistence/stored.ts";
import { DAY_MS } from "../zone-time.ts";

export interface UsageRecord {
  readonly id?: string;
  readonly thread_id: string;
  readonly started_at: number;
  readonly ended_at: number | null;
  readonly reason: string | null;
  readonly usage: string | null;
  readonly agent: string | null;
  readonly model: string | null;
  readonly source_session?: string | null;
  readonly native_ids?: string | null;
  /** Internal projected evidence, never a public usage field. */
  readonly model_conflict?: number | null;
  readonly model_witness?: string | null;
  /** Server-only virtual history evidence; never a stored or RPC field. */
  readonly cache_incomplete?: boolean;
}
export const emptyTotals = (): UsageTotals => ({
  totalTokens: 0,
  uncachedInputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  unclassifiedInputTokens: 0,
  outputTokens: 0,
});
export const addTotals = (a: UsageTotals, b: UsageTotals): UsageTotals =>
  Object.fromEntries(
    Object.keys(a).map((key) => [key, a[key as keyof UsageTotals] + b[key as keyof UsageTotals]]),
  ) as unknown as UsageTotals;

export const validUsageTokens = (provider: string | null, u: TokenUsage): boolean =>
  Object.values(u).every((n) => Number.isSafeInteger(n) && n >= 0) &&
  (provider !== "codex" || (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0) <= u.inputTokens);

/**
 * One persisted final snapshot per turn; no message, context-meter, cost or subagent sums.
 * `onCounted` sees each record exactly as it is added to the totals, for a breakdown that sums to
 * them.
 */
export function aggregateUsage(
  records: readonly UsageRecord[],
  query: UsageOverviewQuery,
  to: number,
  onCounted?: (record: UsageRecord, provider: UsageProvider, totals: UsageTotals) => void,
): UsageOverview {
  let totals = emptyTotals();
  let recordedTurns = 0,
    missingUsageTurns = 0,
    invalidUsageTurns = 0,
    unattributedTurns = 0,
    unknownModelTurns = 0,
    incompleteCacheTurns = 0,
    interruptedTurns = 0,
    openTurns = 0;
  let partialUsageTurns = 0;
  const conversations = new Set<string>();
  const rows = new Map<string, UsageOverviewRow>();
  const from = to - query.days * DAY_MS;
  for (const record of records) {
    if (record.started_at < from || record.started_at >= to) continue;
    const provider =
      record.agent === "claude" || record.agent === "codex" ? record.agent : undefined;
    if (provider === undefined) {
      unattributedTurns++;
      continue;
    }
    if (query.provider !== undefined && provider !== query.provider) continue;
    if (record.ended_at === null) {
      openTurns++;
      continue;
    }
    if (record.usage === null) {
      missingUsageTurns++;
      continue;
    }
    const decoded = decodeStored(UsageSummary, record.usage);
    if (!decoded.ok) {
      invalidUsageTurns++;
      continue;
    }
    const u = decoded.value.tokens;
    if (!validUsageTokens(provider, u)) {
      invalidUsageTurns++;
      continue;
    }
    const completeCache =
      u.cacheReadTokens !== undefined &&
      u.cacheWriteTokens !== undefined &&
      (provider !== "codex" || record.cache_incomplete !== true);
    if (!completeCache) incompleteCacheTurns++;
    const read = u.cacheReadTokens ?? 0,
      write = u.cacheWriteTokens ?? 0;
    // Claude input excludes caches; Codex input includes them. Unknown Codex cache detail
    // leaves the remaining input unsplit; it must not be presented as uncached.
    const rest = provider === "codex" ? u.inputTokens - read - write : u.inputTokens;
    const t: UsageTotals = {
      totalTokens: u.inputTokens + u.outputTokens + (provider === "claude" ? read + write : 0),
      uncachedInputTokens: provider === "claude" || completeCache ? rest : 0,
      unclassifiedInputTokens: provider === "codex" && !completeCache ? rest : 0,
      cacheReadTokens: read,
      cacheWriteTokens: write,
      outputTokens: u.outputTokens,
    };
    totals = addTotals(totals, t);
    onCounted?.(record, provider, t);
    recordedTurns++;
    if (decoded.value.partial === true) partialUsageTurns++;
    conversations.add(record.thread_id);
    if (record.reason !== "completed") interruptedTurns++;
    if (record.model === null) unknownModelTurns++;
    const day = new Date(record.started_at).toISOString().slice(0, 10);
    const key = JSON.stringify([day, provider, record.model]);
    const previous = rows.get(key);
    rows.set(key, {
      day,
      provider,
      model: record.model,
      turns: (previous?.turns ?? 0) + 1,
      missingCacheRead: previous?.missingCacheRead === true || u.cacheReadTokens === undefined,
      missingCacheWrite: previous?.missingCacheWrite === true || u.cacheWriteTokens === undefined,
      totals: addTotals(previous?.totals ?? emptyTotals(), t),
    });
  }
  return {
    from,
    to,
    timezone: "UTC",
    provider: query.provider ?? null,
    totals,
    recordedTurns,
    recordedConversations: conversations.size,
    missingUsageTurns,
    invalidUsageTurns,
    unattributedTurns,
    unknownModelTurns,
    incompleteCacheTurns,
    interruptedTurns,
    openTurns,
    ...(partialUsageTurns === 0 ? {} : { partialUsageTurns }),
    rows: [...rows.values()].toSorted(
      (a, b) =>
        b.day.localeCompare(a.day) ||
        a.provider.localeCompare(b.provider) ||
        (a.model ?? "").localeCompare(b.model ?? ""),
    ),
  };
}
