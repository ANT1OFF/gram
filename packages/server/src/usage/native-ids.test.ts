import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadStore } from "../persistence/thread-store.ts";
import { SqlClient } from "../platform/unstable.ts";
const NOW = Date.parse("2026-10-12T12:00:00Z");
const offlineFile = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "gram-native-ids-"))),
  (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
);
const cli = {
  provider: "codex" as const,
  session: "original-session",
  id: "native-turn",
  nativeIds: ["native-turn"],
  model: "actual-history",
  at: NOW - 1000,
  tokens: { inputTokens: 100, outputTokens: 10 },
  trusted: true,
  complete: true,
  partial: false,
  parent: null,
};

it.effect("projects original MAIN IDs on live and closed rows without inventing scopes", () =>
  Effect.gen(function* () {
    const file = join(yield* offlineFile, "invented.sqlite");
    yield* TestClock.setTime(NOW);
    const oldUsage = '{"tokens":{"inputTokens":1000100,"outputTokens":10010}}';
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO projects (id, root, name) VALUES ('p', '/invented', 'Invented')`;
      yield* sql`INSERT INTO threads (id, project_id, created_at, last_activity_at, agent_session_id, data) VALUES ('t', 'p', 1, 1, 'current-alias', '{}')`;
      yield* sql`INSERT INTO closed_threads (thread_id, closed_at, data) VALUES ('closed', ${NOW}, '{}')`;
      const main = JSON.stringify({
        metadata: {
          agent: "codex",
          agentSessionId: "original-session",
          agentMessageIds: ["native-turn"],
          model: "recorded-old",
          telemetryVersion: "codex-request-delta-v1",
        },
        parts: [{ text: "Invented ignored body ".repeat(150000) }],
      });
      yield* sql`INSERT INTO turns (id, thread_id, started_at, ended_at, reason, usage) VALUES ('live', 't', ${NOW - 1000}, ${NOW - 500}, 'completed', ${oldUsage})`;
      yield* sql`INSERT INTO messages (thread_id, id, seq, role, turn_id, message) VALUES ('t', 'main', 1, 'assistant', 'live', ${main}), ('t', 'user', 2, 'user', 'live', ${main}), ('t', 'nested', 3, 'assistant', 'live', '{"metadata":{"agent":"claude","agentSessionId":"child","agentMessageIds":["child-id"],"parentToolUseId":"child"}}')`;
      yield* sql`INSERT INTO closed_turns (id, thread_id, started_at, ended_at, reason, usage) VALUES ('closed-turn', 'closed', ${NOW - 1000}, ${NOW - 500}, 'completed', ${oldUsage})`;
      yield* sql`INSERT INTO closed_messages (thread_id, id, seq, role, turn_id, message) VALUES ('closed', 'old', 1, 'assistant', 'closed-turn', '{"metadata":{"agent":"codex","agentMessageIds":["native-turn"]}}'), ('closed', 'corrupt', 2, 'assistant', 'closed-turn', 'not-json')`;
    }).pipe(Effect.provide(ThreadStore.layerSqlite(file)));
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient,
        store = yield* ThreadStore;
      const projected = yield* sql<{
        id: string;
        usage_metadata: string | null;
      }>`SELECT id, usage_metadata FROM messages ORDER BY seq`;
      expect(JSON.parse(projected[0]!.usage_metadata!)).toEqual({
        metadata: {
          agent: "codex",
          model: "recorded-old",
          agentSessionId: "original-session",
          agentMessageIds: ["native-turn"],
        },
      });
      expect(projected[0]!.usage_metadata!.length).toBeLessThan(200);
      expect(projected[0]!.usage_metadata).not.toContain("telemetryVersion");
      expect(projected[1]!.usage_metadata).toBeNull();
      expect(projected[2]!.usage_metadata).toBe('{"metadata":{"parentToolUseId":1}}');
      const query = () =>
        store.usageOverview({ days: 1 }, { records: [cli], sources: [], ambiguous: 0 });
      expect(yield* query()).toMatchObject({
        recordedTurns: 1,
        totals: { totalTokens: 110 },
        unattributedTurns: 1,
        history: { matchedTurns: 1, untrustedGramTurns: 0, importedRecords: 0 },
      });
      yield* sql`DELETE FROM closed_messages WHERE id = 'corrupt'`;
      expect(yield* query()).toMatchObject({
        history: { matchedTurns: 1, untrustedGramTurns: 1, importedRecords: 0 },
      });
      expect(yield* sql`SELECT usage FROM turns`).toEqual([{ usage: oldUsage }]);
      expect(yield* sql`SELECT usage FROM closed_turns`).toEqual([{ usage: oldUsage }]);
      // One MAIN row without native IDs invalidates completeness; group_concat must not hide its NULL.
      yield* sql`INSERT INTO messages (thread_id, id, seq, role, turn_id, message) VALUES ('t', 'missing-id', 4, 'assistant', 'live', '{"metadata":{"agent":"codex","agentSessionId":"original-session"}}')`;
      expect(yield* query()).toMatchObject({
        totals: { totalTokens: 110 },
        history: { matchedTurns: 0, untrustedGramTurns: 2, importedRecords: 1 },
      });
      // A writer naming only the message columns refreshes the projection, with no current alias.
      yield* sql`UPDATE messages SET message = '{"metadata":{"agent":"codex","agentSessionId":"original-session","agentMessageIds":["native-turn"],"model":"conflicting","modelConflict":true}}' WHERE id = 'main'`;
      expect(
        JSON.parse(
          (yield* sql<{
            usage_metadata: string;
          }>`SELECT usage_metadata FROM messages WHERE id = 'main'`)[0]!.usage_metadata,
        ).metadata.model,
      ).toBeNull();
      for (const modelConflict of [true, null, "invalid", 1]) {
        yield* sql`UPDATE messages SET message = ${JSON.stringify({ metadata: { agent: "codex", model: "must-not-recover", modelConflict } })} WHERE id = 'main'`;
        const projection = JSON.parse(
          (yield* sql<{
            usage_metadata: string;
          }>`SELECT usage_metadata FROM messages WHERE id = 'main'`)[0]!.usage_metadata,
        );
        expect(projection.metadata).toMatchObject({ model: null, modelConflict: 1 });
      }
      yield* sql`UPDATE messages SET role = 'user' WHERE id = 'main'`;
      expect(yield* sql`SELECT usage_metadata FROM messages WHERE id = 'main'`).toEqual([
        { usage_metadata: null },
      ]);
    }).pipe(Effect.provide(ThreadStore.layerSqlite(file)));
  }),
);
