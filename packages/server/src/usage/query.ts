import { InvalidState, type UsageOverviewQuery } from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { SqlClient } from "../platform/unstable.ts";
import { aggregateUsage, type UsageRecord } from "./aggregate.ts";
import { breakdownCollector, readBreakdownNames } from "./breakdown.ts";
import { historyMetadataBytes, type UsageHistoryInput } from "./history-reader.ts";
import { mergeHistoryUsage } from "./history-merge.ts";
import { DAY_MS } from "../zone-time.ts";

// Materialized admission gates precede JSON evaluation, even if SQLite reorders later joins.
// Bound all linked messages, including nested/user lanes, before filtering metadata.
// Only persisted attribution projections and turn snapshots are read; no transcript or provider.
export const USAGE_TURN_LIMIT = 50_000;
export const USAGE_MESSAGE_LIMIT = 50_000;
export const USAGE_MESSAGE_BYTES = 1_048_576;
export const USAGE_PAYLOAD_BYTES = 33_554_432;
export const USAGE_MODEL_BYTES = 256;
export const USAGE_SNAPSHOT_BYTES = 4_096;
export const readUsageOverview = (query: UsageOverviewQuery, historyInput?: UsageHistoryInput) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const to =
      typeof historyInput === "object" && historyInput.to !== undefined
        ? historyInput.to
        : yield* Clock.currentTimeMillis;
    const from = to - query.days * DAY_MS;
    const records = yield* sql<
      UsageRecord & {
        readonly message_limit_exceeded: number;
        readonly payload_limit_exceeded: number;
        readonly model_limit_exceeded: number;
        readonly selected_bytes: number;
      }
    >`
    WITH period AS MATERIALIZED (
      SELECT id, thread_id, started_at, ended_at, reason,
        CASE WHEN length(CAST(usage AS BLOB)) <= ${USAGE_SNAPSHOT_BYTES} THEN usage END AS usage,
        COALESCE(length(CAST(usage AS BLOB)), 0) AS usage_bytes, 0 AS closed FROM turns
        WHERE started_at >= ${from} AND started_at < ${to}
      UNION ALL
      SELECT id, thread_id, started_at, ended_at, reason,
        CASE WHEN length(CAST(usage AS BLOB)) <= ${USAGE_SNAPSHOT_BYTES} THEN usage END,
        COALESCE(length(CAST(usage AS BLOB)), 0), 1 AS closed FROM closed_turns
        WHERE started_at >= ${from} AND started_at < ${to}
      LIMIT ${USAGE_TURN_LIMIT + 1}
    ), period_budget AS MATERIALIZED (
      SELECT COUNT(*) AS turns, COALESCE(SUM(usage_bytes), 0) AS usage_bytes,
        COALESCE(MAX(usage_bytes), 0) AS max_usage_bytes FROM period
    ), admitted_turns AS MATERIALIZED (
      SELECT * FROM period WHERE (SELECT turns <= ${USAGE_TURN_LIMIT}
        AND max_usage_bytes <= ${USAGE_SNAPSHOT_BYTES}
        AND usage_bytes <= ${USAGE_PAYLOAD_BYTES} FROM period_budget)
    ), linked_messages AS MATERIALIZED (
      SELECT p.id, p.closed, m.rowid AS message_rowid,
        COALESCE(length(CAST(m.usage_metadata AS BLOB)), 0) AS message_bytes
      FROM admitted_turns p CROSS JOIN messages m INDEXED BY messages_turn
        ON p.closed = 0 AND m.thread_id = p.thread_id AND m.turn_id = p.id
      UNION ALL
      SELECT p.id, p.closed, m.rowid, COALESCE(length(CAST(m.usage_metadata AS BLOB)), 0)
      FROM admitted_turns p CROSS JOIN closed_messages m INDEXED BY closed_messages_turn
        ON p.closed = 1 AND m.thread_id = p.thread_id AND m.turn_id = p.id
      LIMIT ${USAGE_MESSAGE_LIMIT + 1}
    ), message_budget AS MATERIALIZED (
      SELECT COUNT(*) AS messages, COALESCE(SUM(message_bytes), 0) AS message_bytes,
        COALESCE(MAX(message_bytes), 0) AS max_message_bytes FROM linked_messages
    ), admission AS MATERIALIZED (
      SELECT usage_bytes + message_bytes AS selected_bytes, messages > ${USAGE_MESSAGE_LIMIT} AS message_limit_exceeded,
        max_usage_bytes > ${USAGE_SNAPSHOT_BYTES}
          OR max_message_bytes > ${USAGE_MESSAGE_BYTES}
          OR usage_bytes + message_bytes > ${USAGE_PAYLOAD_BYTES} AS payload_limit_exceeded
      FROM period_budget CROSS JOIN message_budget
    ), admitted_links AS MATERIALIZED (
      SELECT * FROM linked_messages WHERE (SELECT NOT message_limit_exceeded
        AND NOT payload_limit_exceeded FROM admission)
    ), admitted_messages AS MATERIALIZED (
      SELECT bounded.id, bounded.closed, payload.role, payload.usage_metadata AS message
      FROM admitted_links bounded CROSS JOIN messages payload
        ON bounded.closed = 0 AND payload.rowid = bounded.message_rowid
      UNION ALL
      SELECT bounded.id, bounded.closed, payload.role, payload.usage_metadata AS message
      FROM admitted_links bounded CROSS JOIN closed_messages payload
        ON bounded.closed = 1 AND payload.rowid = bounded.message_rowid
    ), metadata AS MATERIALIZED (
      SELECT bounded.id, bounded.closed,
        json_extract(CASE WHEN json_valid(bounded.message) THEN bounded.message ELSE '{}' END, '$.metadata.agent') AS agent,
        CASE WHEN json_type(CASE WHEN json_valid(bounded.message) THEN bounded.message ELSE '{}' END, '$.metadata.model') = 'text' THEN NULLIF(json_extract(bounded.message, '$.metadata.model'), '') END AS model,
        CASE WHEN json_type(CASE WHEN json_valid(bounded.message) THEN bounded.message ELSE '{}' END, '$.metadata.agentSessionId') = 'text' THEN NULLIF(json_extract(bounded.message, '$.metadata.agentSessionId'), '') END AS source_session,
        CASE WHEN json_type(CASE WHEN json_valid(bounded.message) THEN bounded.message ELSE '{}' END, '$.metadata.agentMessageIds') = 'array' THEN json_extract(bounded.message, '$.metadata.agentMessageIds') END AS native_ids,
        COALESCE(json_extract(CASE WHEN json_valid(bounded.message) THEN bounded.message ELSE '{}' END, '$.metadata.modelConflict'), 0) != 0 AS model_conflict
      FROM admitted_messages bounded
      WHERE bounded.role = 'assistant'
        AND json_extract(CASE WHEN json_valid(bounded.message) THEN bounded.message ELSE '{}' END, '$.metadata.parentToolUseId') IS NULL
    ), model_budget AS MATERIALIZED (
      SELECT COALESCE(MAX(length(CAST(model AS BLOB))), 0) > ${USAGE_MODEL_BYTES}
        AS model_limit_exceeded FROM metadata
    ), attribution AS (
      SELECT id, closed,
        CASE WHEN COUNT(DISTINCT agent) = 1 AND COUNT(agent) = COUNT(*) THEN MAX(agent) END AS agent,
        CASE WHEN COUNT(DISTINCT model) = 1 AND COUNT(model) = COUNT(*) THEN MAX(model) END AS model,
        CASE WHEN COUNT(DISTINCT model) = 1 THEN MAX(model) END AS model_witness,
        CASE WHEN COUNT(DISTINCT source_session) = 1 AND COUNT(source_session) = COUNT(*) THEN MAX(source_session) END AS source_session,
        CASE WHEN COUNT(native_ids) = COUNT(*) THEN group_concat(native_ids, char(10)) END AS native_ids,
        COUNT(DISTINCT model) > 1 OR MAX(model_conflict) != 0 AS model_conflict
      FROM metadata WHERE NOT (SELECT model_limit_exceeded FROM model_budget)
      GROUP BY id, closed
    )
    SELECT p.id, p.thread_id, p.started_at, p.ended_at, p.reason,
      CASE WHEN NOT message_limit_exceeded AND NOT payload_limit_exceeded
        AND NOT model_limit_exceeded THEN p.usage END AS usage, a.agent, a.model, a.source_session, a.native_ids, a.model_conflict, a.model_witness,
      message_limit_exceeded, payload_limit_exceeded, model_limit_exceeded, selected_bytes
    FROM period p CROSS JOIN admission CROSS JOIN model_budget
      LEFT JOIN attribution a ON a.id = p.id AND a.closed = p.closed`;
    if (records.length > USAGE_TURN_LIMIT)
      return yield* new InvalidState({
        message: "This period has more than 50,000 stored turns. Select a shorter period.",
      });
    if (records.some((record) => record.message_limit_exceeded !== 0))
      return yield* new InvalidState({
        message: "This period has more than 50,000 linked messages. Select a shorter period.",
      });
    if (records.some((record) => record.payload_limit_exceeded !== 0))
      return yield* new InvalidState({
        message:
          "This period exceeds the recorded usage payload budget (1 MiB per attribution projection, 4 KiB per turn snapshot, 32 MiB total). Select a shorter period.",
      });
    if (records.some((record) => record.model_limit_exceeded !== 0))
      return yield* new InvalidState({
        message:
          "This period contains model metadata longer than 256 bytes. Recorded usage cannot be safely grouped.",
      });
    const history =
      typeof historyInput === "function" ? yield* historyInput({ from, to }) : historyInput;
    if (
      history !== undefined &&
      (records[0]?.selected_bytes ?? 0) + historyMetadataBytes(history) > USAGE_PAYLOAD_BYTES
    )
      return yield* new InvalidState({
        message:
          "Combined recorded and CLI usage exceeds the 32 MiB accounting budget. Select a shorter period.",
      });
    const merged = history === undefined ? undefined : mergeHistoryUsage(records, history);
    if (merged !== undefined && merged.records.length > USAGE_TURN_LIMIT)
      return yield* new InvalidState({
        message:
          "This period has more than 50,000 combined usage records. Select a shorter period.",
      });
    const collector = breakdownCollector();
    const aggregated = aggregateUsage(merged?.records ?? records, query, to, collector.onCounted);
    const names = yield* readBreakdownNames(collector.threadIds());
    const overview = {
      ...aggregated,
      breakdown: collector.build(names.threads, names.workspaces),
      ...(merged === undefined ? {} : { history: merged.coverage }),
      ...(history?.localLimitHistory === undefined || query.provider === "claude"
        ? {}
        : { localLimitHistory: history.localLimitHistory }),
    };
    if (Object.values(overview.totals).some((n) => !Number.isSafeInteger(n)))
      return yield* new InvalidState({
        message: "Recorded token totals exceed the supported integer range.",
      });
    if (overview.rows.length > 2_000)
      return yield* new InvalidState({
        message:
          "This breakdown has more than 2,000 model/day groups. Select a shorter period or one provider.",
      });
    return overview;
  });
