import { describe, expect, it } from "@effect/vitest";
import {
  InvalidState,
  type Thread,
  type ThreadId,
  type TurnId,
  type TokenUsage,
  type MessageMetadata,
  type UsageOverviewQuery,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { ThreadStore } from "../persistence/thread-store.ts";
import { SqlClient } from "../platform/unstable.ts";
import { usageHandlers } from "./handler.ts";
import {
  USAGE_MESSAGE_LIMIT,
  USAGE_TURN_LIMIT,
  USAGE_MESSAGE_BYTES,
  USAGE_MODEL_BYTES,
  USAGE_SNAPSHOT_BYTES,
  USAGE_PAYLOAD_BYTES,
} from "./query.ts";

const NOW = Date.parse("2026-10-12T12:00:00Z"),
  DAY = 86_400_000;
const messageParts = (text: string) => JSON.stringify([{ type: "text", text }]);
const withStore = <A, E>(effect: Effect.Effect<A, E, ThreadStore | SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(ThreadStore.layerSqlite(":memory:").pipe(Layer.orDie)));
const setup = Effect.gen(function* () {
  yield* TestClock.setTime(NOW);
  const store = yield* ThreadStore;
  const project = yield* store.ensureProject({ root: "/invented/repo", name: "Invented" });
  const t = (id: string): Thread => ({
    id: id as ThreadId,
    projectId: project.id,
    title: "Synthetic usage",
    model: { agent: "codex", model: "current-selection-is-not-history" },
    userNamed: false,
    mode: "default",
    checkout: { kind: "main", path: "/invented/repo" },
    labels: [],
    pinned: false,
    parked: false,
    unread: false,
    createdAt: 1,
    lastActivityAt: 1,
  });
  yield* store.insertThread(t("source"));
  yield* store.insertThread(t("fork"));
  let seq = 0;
  const turn = (
    id: string,
    at: number,
    tokens: TokenUsage | null,
    metadata: MessageMetadata = { agent: "claude", model: "actual-old" },
    reason: "completed" | "interrupted" | "error" | null = "completed",
  ) =>
    Effect.gen(function* () {
      const tid = id as TurnId;
      yield* store.startTurn("source" as ThreadId, tid, at);
      const messageId = `reply-${++seq}`;
      yield* store.upsertMessage(
        "source" as ThreadId,
        {
          id: messageId,
          role: "assistant",
          parts: [
            { type: "text", text: "Invented private content must never appear in the aggregate" },
          ],
          metadata,
        },
        tid,
      );
      if (reason !== null)
        yield* store.endTurn(tid, {
          endedAt: at + 1000,
          reason,
          ...(tokens === null ? {} : { usage: { tokens, contextTokens: 999_999, costUsd: 19 } }),
        });
      return { tid, messageId };
    });
  const query = (q: UsageOverviewQuery = { days: 7 }) => store.usageOverview(q);
  return { store, turn, query };
});

describe("recorded Usage overview actual SQLite path", () => {
  it.effect(
    "admits long active history with large irrelevant bodies through the production handler",
    () =>
      withStore(
        Effect.gen(function* () {
          const { store, turn } = yield* setup;
          const tokens = {
            inputTokens: 100,
            outputTokens: 20,
            cacheReadTokens: 50,
            cacheWriteTokens: 10,
          };
          for (let i = 0; i < 40; i++) {
            yield* turn(`active-${i}`, NOW - 1000 - i, tokens, {
              agent: i % 2 === 0 ? "claude" : "codex",
            });
          }
          // Query admission must ignore bodies even when their total exceeds its byte budget.
          // Keep all 40 turns / 120 large rows, but derive their size from that boundary rather
          // than serializing 150 MB through 120 separate fixture transactions under load.
          const sql = yield* SqlClient.SqlClient;
          const reply = "Synthetic reply ";
          const input = "Synthetic input ";
          const child = "Synthetic tool output ";
          const repeats = Math.ceil(
            (USAGE_PAYLOAD_BYTES + 1) / (40 * (reply.length + input.length + child.length)),
          );
          yield* sql`UPDATE messages SET message = json_set(message, '$.parts',
            json(${messageParts(reply.repeat(repeats))})) WHERE thread_id = 'source'`;
          yield* sql`INSERT INTO messages (thread_id, id, seq, role, turn_id, message)
            SELECT thread_id, 'user-' || id, 1000 + rowid * 2, 'user', id,
              json_set(${JSON.stringify({ role: "user", parts: [{ type: "text", text: input.repeat(repeats) }] })},
                '$.id', 'user-' || id)
            FROM turns WHERE thread_id = 'source'`;
          yield* sql`INSERT INTO messages (thread_id, id, seq, role, turn_id, message)
            SELECT thread_id, 'child-' || id, 1001 + rowid * 2, 'assistant', id,
              json_set(${JSON.stringify({
                role: "assistant",
                metadata: {
                  agent: "codex",
                  model: "excluded-child",
                  parentToolUseId: "synthetic-child",
                },
                parts: [{ type: "text", text: child.repeat(repeats) }],
              })}, '$.id', 'child-' || id)
            FROM turns WHERE thread_id = 'source'`;
          // Also keep each body kind over the per-attribution limit, independently of the
          // aggregate boundary. User/child bodies must never enter either accounting budget.
          for (const [id, text] of [
            ["reply-1", reply],
            ["user-active-0", input],
            ["child-active-0", child],
          ] as const) {
            const body = text.repeat(Math.ceil((USAGE_MESSAGE_BYTES + 1) / text.length));
            yield* sql`UPDATE messages SET message = json_set(message, '$.parts',
              json(${messageParts(body)})) WHERE thread_id = 'source' AND id = ${id}`;
          }
          const [fixture] = yield* sql<{ rows: number; bytes: number; oversized: number }>`SELECT
            COUNT(*) AS rows, SUM(length(CAST(message AS BLOB))) AS bytes,
            SUM(length(CAST(json_extract(message, '$.parts[0].text') AS BLOB)) > ${USAGE_MESSAGE_BYTES}) AS oversized
            FROM messages WHERE thread_id = 'source'`;
          expect(fixture!.rows).toBe(120);
          expect(fixture!.bytes).toBeGreaterThan(USAGE_PAYLOAD_BYTES);
          expect(fixture!.oversized).toBe(3);
          const handler = yield* usageHandlers;
          const data = yield* handler["app.usageOverview"]({ days: 1 });
          expect(data).toMatchObject({
            recordedTurns: 40,
            unknownModelTurns: 40,
            totals: { totalTokens: 6000 },
          });
          expect(data.rows).toHaveLength(2);
          expect(JSON.stringify(data)).not.toMatch(
            /Synthetic reply|Synthetic input|Synthetic tool|excluded-child/,
          );
          yield* store.closeThread("source" as ThreadId, NOW);
          expect(yield* handler["app.usageOverview"]({ days: 1 })).toEqual(data);
        }),
      ),
  );

  it.effect(
    "admits exact UTF-8 and selected accounting byte boundaries, refusing one byte over",
    () =>
      withStore(
        Effect.gen(function* () {
          const { turn } = yield* setup;
          const { messageId } = yield* turn(
            "boundary",
            NOW - 1000,
            { inputTokens: 1, outputTokens: 2 },
            { agent: "claude", model: "é".repeat(USAGE_MODEL_BYTES / 2) },
          );
          const handler = yield* usageHandlers;
          const read = () => handler["app.usageOverview"]({ days: 1 });
          expect((yield* read()).rows[0]!.model).toBe("é".repeat(128));
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE messages SET message = ${JSON.stringify({ metadata: { agent: "claude", model: "é".repeat(128) + "a" } })} WHERE id = ${messageId}`;
          expect((yield* Effect.flip(read())).message).toContain("256 bytes");
          yield* sql`DELETE FROM messages`;
          yield* sql`DELETE FROM turns`;
          const projection = JSON.stringify({ metadata: { agent: "claude", model: null } });
          // 8192 selected rows each spend exactly 4096 bytes across snapshot + projection.
          const snapshot = '{"tokens":{"inputTokens":1,"outputTokens":2}}'.padEnd(
            USAGE_PAYLOAD_BYTES / 8192 - Buffer.byteLength(projection),
            " ",
          );
          expect(Buffer.byteLength(snapshot)).toBeLessThanOrEqual(USAGE_SNAPSHOT_BYTES);
          yield* sql`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 8192)
        INSERT INTO turns (id, thread_id, started_at, ended_at, reason, usage)
        SELECT 'budget-' || x, 'source', ${NOW - 1000}, ${NOW - 500}, 'completed', ${snapshot} FROM n`;
          yield* sql`INSERT INTO messages (thread_id, id, seq, role, turn_id, message)
        SELECT 'source', id, rowid, 'assistant', id, '{"metadata":{"agent":"claude"}}' FROM turns`;
          expect(yield* read()).toMatchObject({
            recordedTurns: 8192,
            unknownModelTurns: 8192,
            totals: { totalTokens: 24576 },
          });
          yield* sql`UPDATE messages SET usage_metadata = usage_metadata || ' ' WHERE id = 'budget-1'`;
          expect((yield* Effect.flip(read())).message).toContain("payload budget");
          yield* sql`UPDATE turns SET usage = ${"é".repeat(USAGE_SNAPSHOT_BYTES / 2) + "a"} WHERE id = 'budget-1'`;
          expect((yield* Effect.flip(read())).message).toContain("4 KiB");
          // Store-only fixture has no provider/auth/CLI layer and never discovers host credentials.
        }),
      ),
  );
  it.effect("refuses payload and model byte overflow through the actual handler", () =>
    withStore(
      Effect.gen(function* () {
        const { turn, query } = yield* setup;
        const { messageId } = yield* turn("large", NOW - 1000, { inputTokens: 1, outputTokens: 2 });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE messages SET usage_metadata = ${"x".repeat(USAGE_MESSAGE_BYTES + 1)} WHERE id = ${messageId}`;
        expect((yield* Effect.flip(query())).message).toContain("payload budget");
        yield* sql`UPDATE messages SET message = ${JSON.stringify({ metadata: { agent: "claude", model: "m".repeat(USAGE_MODEL_BYTES + 1) } })} WHERE id = ${messageId}`;
        expect((yield* Effect.flip(query())).message).toContain("256 bytes");
      }),
    ),
  );
  it.effect("refuses oversized linked-message histories through the actual store", () =>
    withStore(
      Effect.gen(function* () {
        const { turn, query } = yield* setup;
        const { tid } = yield* turn("fanout", NOW - 1000, { inputTokens: 1, outputTokens: 2 });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < ${USAGE_MESSAGE_LIMIT})
          INSERT INTO messages (thread_id, id, seq, role, turn_id, message)
          SELECT 'source', 'fanout-' || x, 100 + x, 'assistant', ${tid}, '{"metadata":{"agent":"claude","model":"actual-old"}}' FROM n`;
        const refused = yield* Effect.flip(query());
        expect(refused).toBeInstanceOf(InvalidState);
        expect(refused.message).toContain("50,000 linked messages");
      }),
    ),
  );
  it.effect(
    "normalizes cache semantics, excludes nested/fork history, keeps cancelled telemetry and does not infer historical models",
    () =>
      withStore(
        Effect.gen(function* () {
          const { store, turn, query } = yield* setup;
          const { tid, messageId } = yield* turn("claude", NOW - DAY, {
            inputTokens: 100,
            outputTokens: 20,
            cacheReadTokens: 50,
            cacheWriteTokens: 10,
            reasoningTokens: 8,
          });
          yield* store.upsertMessage(
            "source" as ThreadId,
            {
              id: "nested",
              role: "assistant",
              parts: [{ type: "text", text: "Invented child" }],
              metadata: {
                agent: "codex",
                model: "child-model",
                parentToolUseId: "child",
                usage: { tokens: { inputTokens: 1_000_000, outputTokens: 10 } },
              },
            },
            tid,
          );
          yield* store.copyMessages("source" as ThreadId, "fork" as ThreadId, messageId);
          yield* turn(
            "codex",
            NOW - DAY + 1,
            {
              inputTokens: 100,
              outputTokens: 20,
              cacheReadTokens: 50,
              cacheWriteTokens: 10,
              reasoningTokens: 8,
            },
            { agent: "codex" },
            "interrupted",
          );
          yield* turn("zero", NOW - 2 * DAY, {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          });
          const data = yield* query();
          expect(data.totals).toEqual({
            totalTokens: 300,
            uncachedInputTokens: 140,
            cacheReadTokens: 100,
            cacheWriteTokens: 20,
            unclassifiedInputTokens: 0,
            outputTokens: 40,
          });
          expect(data).toMatchObject({
            recordedTurns: 3,
            recordedConversations: 1,
            interruptedTurns: 1,
            unknownModelTurns: 1,
          });
          expect(data.rows.map((r) => r.model)).toEqual(["actual-old", null, "actual-old"]);
          expect(JSON.stringify(data)).not.toContain("Invented private content");
          expect(JSON.stringify(data)).not.toContain("current-selection-is-not-history");
          const codex = yield* query({ days: 7, provider: "codex" });
          expect(codex.totals.totalTokens).toBe(120);
          expect(codex.recordedTurns).toBe(1);
          const beforeClose = yield* query();
          const source = yield* store.getThread("source" as ThreadId);
          yield* store.closeThread("source" as ThreadId, NOW);
          expect(yield* query()).toEqual(beforeClose);
          yield* store.insertThread(source);
          yield* store.restoreClosedHistory(source.id);
          expect(yield* query()).toEqual(beforeClose);
        }),
      ),
  );

  it.effect(
    "distinguishes missing, zero, corrupt, unattributed, unsplit cache and open turns; handles conflicting or absent metadata conservatively",
    () =>
      withStore(
        Effect.gen(function* () {
          const { turn, query, store } = yield* setup;
          yield* turn("missing", NOW - 1000, null);
          yield* turn("unknown", NOW - 1000, { inputTokens: 500, outputTokens: 2 }, {});
          yield* turn(
            "partial",
            NOW - 1000,
            { inputTokens: 100, outputTokens: 10, cacheReadTokens: 30 },
            { agent: "codex" },
          );
          yield* turn("bad", NOW - 1000, { inputTokens: -1, outputTokens: 2 });
          yield* turn(
            "bad-cache",
            NOW - 1000,
            { inputTokens: 10, outputTokens: 2, cacheReadTokens: 11 },
            { agent: "codex" },
          );
          yield* turn("open", NOW - 1000, null, { agent: "codex" }, null);
          const conflict = yield* turn("multi-model", NOW - 1000, {
            inputTokens: 1,
            outputTokens: 2,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          });
          yield* store.upsertMessage(
            "source" as ThreadId,
            {
              id: "other-model",
              role: "assistant",
              parts: [],
              metadata: { agent: "claude", model: "actual-new" },
            },
            conflict.tid,
          );
          const corrupted = yield* turn("corrupt", NOW - 1000, { inputTokens: 1, outputTokens: 2 });
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE turns SET usage = 'not-json' WHERE id = ${corrupted.tid}`;
          const badMessage = yield* turn("bad-message", NOW - 1000, {
            inputTokens: 10,
            outputTokens: 2,
          });
          yield* sql`UPDATE messages SET message = 'not-json' WHERE id = ${badMessage.messageId}`;
          const data = yield* query();
          expect(data).toMatchObject({
            recordedTurns: 2,
            missingUsageTurns: 1,
            invalidUsageTurns: 3,
            unattributedTurns: 2,
            incompleteCacheTurns: 1,
            unknownModelTurns: 2,
            openTurns: 1,
          });
          expect(data.totals).toMatchObject({
            totalTokens: 113,
            unclassifiedInputTokens: 70,
            cacheReadTokens: 30,
          });
          expect((yield* query({ days: 7, provider: "claude" })).unattributedTurns).toBe(2);
        }),
      ),
  );

  it.effect(
    "uses inclusive rolling start, exclusive end, UTC start-day buckets and ignores current provider selection",
    () =>
      withStore(
        Effect.gen(function* () {
          const { turn, query } = yield* setup;
          const tokens = {
            inputTokens: 1,
            outputTokens: 2,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          };
          yield* turn("before", NOW - DAY - 1, tokens);
          yield* turn("start", NOW - DAY, tokens);
          yield* turn("midnight-before", Date.parse("2026-10-11T23:59:59Z"), tokens);
          yield* turn("midnight-after", Date.parse("2026-10-12T00:00:00Z"), tokens);
          yield* turn("end", NOW, tokens);
          yield* turn("old-model", NOW - 29 * DAY, tokens, { agent: "claude", model: "older" });
          expect((yield* query({ days: 1 })).rows.map((r) => [r.day, r.turns])).toEqual([
            ["2026-10-12", 1],
            ["2026-10-11", 2],
          ]);
          expect((yield* query({ days: 7 })).recordedTurns).toBe(4);
          expect((yield* query({ days: 30 })).recordedTurns).toBe(5);
          expect((yield* query({ days: 90, provider: "codex" })).recordedTurns).toBe(0);
        }),
      ),
  );

  it.effect(
    "queries read-only through the real handler, groups moderate counts and refuses oversized periods without truncating",
    () =>
      withStore(
        Effect.gen(function* () {
          const { query } = yield* setup;
          const sql = yield* SqlClient.SqlClient;
          yield* sql`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 2000)
      INSERT INTO turns (id, thread_id, started_at, ended_at, reason, usage)
      SELECT 'bulk-' || x, 'source', ${NOW - 1000}, ${NOW - 500}, 'completed', '{"tokens":{"inputTokens":1,"outputTokens":2}}' FROM n`;
          yield* sql`INSERT INTO messages (thread_id, id, seq, role, turn_id, message)
      SELECT thread_id, id, rowid, 'assistant', id, '{"metadata":{"agent":"codex"}}' FROM turns`;
          const before = yield* sql`SELECT * FROM turns ORDER BY id`;
          const handler = yield* usageHandlers;
          const data = yield* handler["app.usageOverview"]({ days: 7 });
          expect(data.recordedTurns).toBe(2000);
          expect(data.rows).toHaveLength(1);
          expect(data.totals.totalTokens).toBe(6000);
          expect(yield* sql`SELECT * FROM turns ORDER BY id`).toEqual(before);
          const plans = yield* sql<{
            detail: string;
          }>`EXPLAIN QUERY PLAN SELECT * FROM turns WHERE started_at >= ${NOW - DAY} AND started_at < ${NOW}`;
          expect(plans.some((p) => p.detail.includes("turns_started"))).toBe(true);
          yield* sql`WITH RECURSIVE n(x) AS (SELECT 2001 UNION ALL SELECT x + 1 FROM n WHERE x < ${USAGE_TURN_LIMIT + 1})
      INSERT INTO turns (id, thread_id, started_at) SELECT 'bulk-' || x, 'source', ${NOW - 1000} FROM n`;
          const refused = yield* Effect.flip(query());
          expect(refused).toBeInstanceOf(InvalidState);
          expect(refused.message).toContain("50,000");
        }),
      ),
  );
});
