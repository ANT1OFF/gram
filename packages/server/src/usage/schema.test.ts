import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadStore } from "../persistence/thread-store.ts";
import { SqlClient } from "../platform/unstable.ts";
import { usageHandlers } from "./handler.ts";

const NOW = Date.parse("2026-10-12T12:00:00Z");
const dir = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "gram-usage-projection-"))),
  (path) => Effect.sync(() => rmSync(path, { recursive: true, force: true })),
);

it.effect("projects live and closed attribution for every writer, whatever columns it names", () =>
  Effect.gen(function* () {
    const file = join(yield* dir, "synthetic.sqlite");
    yield* TestClock.setTime(NOW);
    // No provider layers, CLI execution or auth discovery; only a new synthetic SQLite file.
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO projects (id, root, name) VALUES ('p', '/synthetic', 'Synthetic')`;
      yield* sql`INSERT INTO threads (id, project_id, created_at, last_activity_at, data)
        VALUES ('t', 'p', 1, 1, '{}')`;
      const large = JSON.stringify({
        metadata: {
          agent: "claude",
          model: "é".repeat(128),
          unrelated: "Synthetic irrelevant metadata ".repeat(50_000),
        },
        parts: [{ type: "text", text: "Synthetic body ".repeat(100_000) }],
      });
      yield* sql`INSERT INTO turns (id, thread_id, started_at, ended_at, reason, usage)
        VALUES ('live', 't', ${NOW - 1000}, ${NOW - 500}, 'completed', '{"tokens":{"inputTokens":10,"outputTokens":2}}')`;
      yield* sql`INSERT INTO messages (thread_id, id, seq, role, turn_id, message)
        VALUES ('t', 'main', 1, 'assistant', 'live', ${large}),
          ('t', 'corrupt', 2, 'assistant', 'live', 'not-json')`;
      yield* sql`INSERT INTO closed_threads (thread_id, closed_at, data) VALUES ('closed-t', ${NOW}, '{}')`;
      yield* sql`INSERT INTO closed_turns (id, thread_id, started_at, ended_at, reason, usage)
        VALUES ('closed', 'closed-t', ${NOW - 1000}, ${NOW - 500}, 'completed', '{"tokens":{"inputTokens":20,"outputTokens":3}}')`;
      yield* sql`INSERT INTO closed_messages (thread_id, id, seq, role, turn_id, message)
        VALUES ('closed-t', 'main', 1, 'assistant', 'closed', '{"metadata":{"agent":"codex"}}')`;
    }).pipe(Effect.provide(ThreadStore.layerSqlite(file)));
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const handler = yield* usageHandlers;
      const read = () => handler["app.usageOverview"]({ days: 1 });
      expect(yield* read()).toMatchObject({
        recordedTurns: 1,
        unattributedTurns: 1,
        unknownModelTurns: 1,
        totals: { totalTokens: 23 },
      });
      const projected = yield* sql<{
        usage_metadata: string;
      }>`SELECT usage_metadata FROM messages WHERE id = 'main'`;
      expect(JSON.parse(projected[0]!.usage_metadata)).toEqual({
        metadata: { agent: "claude", model: "é".repeat(128) },
      });
      expect(projected[0]!.usage_metadata).not.toContain("Synthetic");
      yield* sql`DELETE FROM messages WHERE id = 'corrupt'`;
      expect(yield* read()).toMatchObject({
        recordedTurns: 2,
        unknownModelTurns: 1,
        totals: { totalTokens: 35 },
      });
      // A writer that names only the message columns; the triggers keep attribution in step.
      yield* sql`UPDATE messages SET message = '{"metadata":{"agent":"codex"}}' WHERE id = 'main'`;
      expect(yield* read()).toMatchObject({
        recordedTurns: 2,
        unknownModelTurns: 2,
        totals: { totalTokens: 35 },
      });
      yield* sql`INSERT INTO messages (thread_id, id, seq, role, turn_id, message)
        VALUES ('t', 'child', 3, 'assistant', 'live', ${JSON.stringify({ metadata: { agent: "claude", model: "x".repeat(2_000_000), parentToolUseId: "x".repeat(2_000_000) } })})`;
      expect(yield* sql`SELECT usage_metadata FROM messages WHERE id = 'child'`).toEqual([
        { usage_metadata: '{"metadata":{"parentToolUseId":1}}' },
      ]);
      expect(yield* read()).toMatchObject({ recordedTurns: 2, totals: { totalTokens: 35 } });
      yield* sql`UPDATE closed_messages SET message = '{"metadata":{"agent":"claude","model":"closed-new"}}' WHERE id = 'main'`;
      expect((yield* read()).rows.some((r) => r.model === "closed-new")).toBe(true);
      // Previous history is substantial but outside the selected indexed period.
      yield* sql`INSERT INTO turns (id, thread_id, started_at) VALUES ('old', 't', ${NOW - 86_400_001})`;
      yield* sql`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 30000)
        INSERT INTO messages (thread_id, id, seq, role, turn_id, message)
        SELECT 't', 'old-' || x, 100 + x, 'assistant', 'old', '{"metadata":{"agent":"claude"}}' FROM n`;
      const before = yield* sql`SELECT COUNT(*) AS n FROM messages`;
      expect(yield* read()).toMatchObject({ recordedTurns: 2, totals: { totalTokens: 35 } });
      expect(yield* sql`SELECT COUNT(*) AS n FROM messages`).toEqual(before);
    }).pipe(Effect.provide(ThreadStore.layerSqlite(file)));
  }),
);

const reply = (text: string, model: string) =>
  ({
    id: "reply",
    role: "assistant",
    metadata: { agent: "claude", model },
    parts: [{ type: "text", text }],
  }) as never;

it.effect("rewrites a saved message's attribution only when its agent or model changes", () =>
  Effect.gen(function* () {
    const file = join(yield* dir, "synthetic.sqlite");
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* ThreadStore;
      yield* sql`INSERT INTO projects (id, root, name) VALUES ('p', '/synthetic', 'Synthetic')`;
      yield* sql`INSERT INTO threads (id, project_id, created_at, last_activity_at, data)
        VALUES ('t', 'p', 1, 1, '{}')`;
      // Counts the writes of the projection, each of which rewrites the whole row.
      yield* sql`CREATE TABLE projection_writes (n INTEGER NOT NULL)`;
      yield* sql`INSERT INTO projection_writes VALUES (0)`;
      yield* sql.unsafe(`CREATE TRIGGER count_projection AFTER UPDATE OF usage_metadata ON messages
        BEGIN UPDATE projection_writes SET n = n + 1; END`);
      const writes = () =>
        sql<{ n: number }>`SELECT n FROM projection_writes`.pipe(Effect.map(([row]) => row!.n));

      yield* store.upsertMessage("t" as never, reply("Synthetic", "model-a"));
      expect(yield* writes()).toBe(1);
      // A reply streaming: the same message saved again and again as it grows.
      for (let i = 1; i <= 20; i++) {
        yield* store.upsertMessage("t" as never, reply("Synthetic ".repeat(i * 1_000), "model-a"));
      }
      expect(yield* writes()).toBe(1);
      yield* store.upsertMessage("t" as never, reply("Synthetic", "model-b"));
      expect(yield* writes()).toBe(2);
      expect(yield* sql`SELECT usage_metadata FROM messages WHERE id = 'reply'`).toEqual([
        { usage_metadata: '{"metadata":{"agent":"claude","model":"model-b"}}' },
      ]);
    }).pipe(Effect.provide(ThreadStore.layerSqlite(file)));
  }),
);
