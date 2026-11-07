import {
  coarsenCreditPoints,
  coarsenLimitPoints,
  creditBalanceNumber,
  isSubscriptionLimitWindow,
  LIMIT_HISTORY_BUCKET_MS,
  LIMIT_HISTORY_RETENTION_MS,
  limitHistoryBucket,
  limitHistoryStep,
  type AgentKind,
  type CreditHistorySeries,
  type LimitHistoryDays,
  type LimitHistoryPoint,
  type LimitHistorySeries,
  type LimitRecord,
  type UsageLimitHistory,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import type { SqlClient, SqlError } from "../platform/unstable.ts";
import { DAY_MS as DAY } from "../zone-time.ts";

/** How often, at most, a write also prunes what has aged past `LIMIT_HISTORY_RETENTION_MS`. */
export const LIMIT_HISTORY_PRUNE_EVERY_MS = 60 * 60_000;

/** A broken database is a defect, as in `ThreadStore`. */
const run = <A>(effect: Effect.Effect<A, SqlError>) =>
  effect.pipe(Effect.catch((error) => Effect.die(error)));

interface WindowRow {
  readonly agent: string;
  readonly limit_window: string;
  readonly bucket: number;
  readonly utilization: number;
  readonly peak: number;
  readonly resets_at: number | null;
}
interface CreditRow {
  readonly agent: string;
  readonly bucket: number;
  readonly balance: number;
}

export interface LimitHistoryStore {
  /**
   * Takes a reading read at `at` into its quarter-hour bucket: the window's share (last and
   * highest) and reset, and the account's credit balance when it names one. Only the CLI's own
   * login and the windows the meter shows; a gateway profile's reading is not kept. Writes only
   * when the bucket changes, and prunes at most once an hour.
   */
  readonly sample: (record: LimitRecord, at: number) => Effect.Effect<void>;
  /** Drops every bucket older than the retention, or ahead of `now` from a clock set back. */
  readonly prune: (now: number) => Effect.Effect<void>;
  /** The period's series at its step (`limitHistoryStep`), oldest first. */
  readonly read: (days: LimitHistoryDays, now: number) => Effect.Effect<UsageLimitHistory>;
}

/**
 * The downsampled limit history in `usage_limit_history` and `usage_credit_history`
 * (`0003_usage_limit_history`): one row per agent, window and quarter hour, at most
 * `LIMIT_HISTORY_RETENTION_MS / LIMIT_HISTORY_BUCKET_MS` per series, the oldest pruned as they age.
 * It holds the shares, resets and balances the meter already shows, nothing else.
 */
export function makeLimitHistory(sql: SqlClient.SqlClient) {
  /** What was last written per series, so a reading that changes nothing is no write. */
  const lastWindow = new Map<string, LimitHistoryPoint>();
  const lastCredit = new Map<string, { readonly at: number; readonly balance: number }>();
  let prunedAt = -Infinity;

  const prune: LimitHistoryStore["prune"] = (now) =>
    Effect.gen(function* () {
      prunedAt = now;
      const oldest = now - LIMIT_HISTORY_RETENTION_MS;
      // A bucket more than a day ahead came from a clock that was wrong; it would never age out.
      const newest = now + DAY;
      yield* run(
        sql`DELETE FROM usage_limit_history WHERE bucket < ${oldest} OR bucket > ${newest}`,
      );
      yield* run(
        sql`DELETE FROM usage_credit_history WHERE bucket < ${oldest} OR bucket > ${newest}`,
      );
      lastWindow.clear();
      lastCredit.clear();
    });

  const sample: LimitHistoryStore["sample"] = (record, at) =>
    Effect.gen(function* () {
      if (record.profileId !== undefined || !isSubscriptionLimitWindow(record.window)) return;
      if (at - prunedAt >= LIMIT_HISTORY_PRUNE_EVERY_MS) yield* prune(at);
      const bucket = limitHistoryBucket(at);
      const key = `${record.agent}/${record.window}`;
      const before = lastWindow.get(key);
      const utilization = Math.min(1, Math.max(0, record.utilization));
      const peak = before?.at === bucket ? Math.max(before.peak, utilization) : utilization;
      const point: LimitHistoryPoint = {
        at: bucket,
        utilization,
        peak,
        ...(record.resetsAt === undefined ? {} : { resetsAt: record.resetsAt }),
      };
      if (
        before === undefined ||
        before.at !== point.at ||
        before.utilization !== point.utilization ||
        before.peak !== point.peak ||
        before.resetsAt !== point.resetsAt
      ) {
        lastWindow.set(key, point);
        // `MAX` keeps a peak read before a restart, which the map above has forgotten.
        yield* run(sql`INSERT INTO usage_limit_history
            (agent, limit_window, bucket, utilization, peak, resets_at)
          VALUES (${record.agent}, ${record.window}, ${bucket}, ${utilization}, ${peak},
            ${record.resetsAt ?? null})
          ON CONFLICT(agent, limit_window, bucket) DO UPDATE SET
            utilization = excluded.utilization,
            peak = MAX(usage_limit_history.peak, excluded.peak),
            resets_at = excluded.resets_at`);
      }
      const balance = creditBalanceNumber(record.creditsBalance);
      if (balance === undefined) return;
      const credit = lastCredit.get(record.agent);
      if (credit !== undefined && credit.at === bucket && credit.balance === balance) return;
      lastCredit.set(record.agent, { at: bucket, balance });
      yield* run(sql`INSERT INTO usage_credit_history (agent, bucket, balance)
        VALUES (${record.agent}, ${bucket}, ${balance})
        ON CONFLICT(agent, bucket) DO UPDATE SET balance = excluded.balance`);
    });

  const read: LimitHistoryStore["read"] = (days, now) =>
    Effect.gen(function* () {
      const step = limitHistoryStep(days);
      const to = now;
      const from = limitHistoryBucket(now - days * DAY, step);
      const windowRows = yield* run(
        sql<WindowRow>`SELECT agent, limit_window, bucket, utilization, peak, resets_at
          FROM usage_limit_history WHERE bucket >= ${from} AND bucket <= ${to}
          ORDER BY agent, limit_window, bucket`,
      );
      const creditRows = yield* run(
        sql<CreditRow>`SELECT agent, bucket, balance FROM usage_credit_history
          WHERE bucket >= ${from} AND bucket <= ${to} ORDER BY agent, bucket`,
      );
      const oldest = yield* run(
        sql<{ since: number | null }>`SELECT MIN(since) AS since FROM (
          SELECT MIN(bucket) AS since FROM usage_limit_history
          UNION ALL SELECT MIN(bucket) AS since FROM usage_credit_history)`,
      );
      type Series = { agent: AgentKind; window: string; points: LimitHistoryPoint[] };
      const byWindow = new Map<string, Series>();
      for (const row of windowRows) {
        if (!isAgent(row.agent)) continue;
        const key = `${row.agent}/${row.limit_window}`;
        const series: Series = byWindow.get(key) ?? {
          agent: row.agent,
          window: row.limit_window,
          points: [],
        };
        series.points.push({
          at: row.bucket,
          utilization: row.utilization,
          peak: row.peak,
          ...(row.resets_at === null ? {} : { resetsAt: row.resets_at }),
        });
        byWindow.set(key, series);
      }
      const byAgent = new Map<AgentKind, { at: number; balance: number }[]>();
      for (const row of creditRows) {
        if (!isAgent(row.agent)) continue;
        const points = byAgent.get(row.agent) ?? [];
        points.push({ at: row.bucket, balance: row.balance });
        byAgent.set(row.agent, points);
      }
      const windows: LimitHistorySeries[] = [...byWindow.values()].map((series) => ({
        ...series,
        points:
          step === LIMIT_HISTORY_BUCKET_MS
            ? series.points
            : coarsenLimitPoints(series.points, step),
      }));
      const credits: CreditHistorySeries[] = [...byAgent].map(([agent, points]) => ({
        agent,
        points: step === LIMIT_HISTORY_BUCKET_MS ? points : coarsenCreditPoints(points, step),
      }));
      const since = oldest[0]?.since ?? null;
      return {
        from,
        to,
        step,
        ...(since === null ? {} : { since }),
        windows,
        credits,
      } satisfies UsageLimitHistory;
    });

  return { sample, prune, read } satisfies LimitHistoryStore;
}

const isAgent = (agent: string): agent is AgentKind => agent === "claude" || agent === "codex";
