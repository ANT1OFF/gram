// Entirely generated: never accepts a source database, host auth or provider configuration.
import { DEFAULT_CHARTER, type Thread, type ThreadId, type WorkspaceId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DAY_MS } from "../zone-time.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { SqlClient } from "../platform/unstable.ts";
import { emptyOutbox, emptyWorkerMemo, encodeOutbox } from "../orchestration/outbox.ts";

export const SMOKE = process.env["GRAM_PERF_SQLITE_SMOKE"] === "1";
export const FIXTURE = {
  workspaces: 10,
  threads: 300,
  messages: SMOKE ? 2_000 : 200_000,
  reports: SMOKE ? 100 : 100_000,
};
export const FIXTURE_NOW = Date.parse("2026-11-01T12:00:00Z");
export const threadId = (i: number) => `perf-thread-${i}` as ThreadId;
export const workspaceId = (i: number) => `perf-workspace-${i}` as WorkspaceId;

export const seedSqliteFixture = (dir: string) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const sql = yield* SqlClient.SqlClient;
    const project = yield* store.ensureProject({ root: dir, name: "Synthetic performance" });
    for (let i = 0; i < FIXTURE.threads; i++) {
      const workspace = Math.floor(i / 30);
      const path = join(dir, `checkout-${i}`);
      mkdirSync(path);
      const thread: Thread = {
        id: threadId(i),
        projectId: project.id,
        title: `Synthetic task ${i}`,
        model: { agent: "claude", model: "synthetic" },
        userNamed: false,
        mode: "default",
        checkout: { kind: "main", path },
        labels: [],
        pinned: false,
        parked: false,
        unread: false,
        createdAt: FIXTURE_NOW - DAY_MS,
        lastActivityAt: FIXTURE_NOW,
        workspaceId: workspaceId(workspace),
        ...(i % 30 === 0
          ? { role: "orchestrator" as const }
          : {
              spawnedBy: { threadId: threadId(workspace * 30), feature: `feature-${i % 6}` },
              boundPr: { repo: "synthetic/perf", number: i + 1, monitor: false },
            }),
      };
      yield* store.insertThread(thread);
    }
    for (let i = 0; i < FIXTURE.workspaces; i++) {
      yield* store.putWorkspace({
        workspace: {
          id: workspaceId(i),
          name: `Synthetic ${i}`,
          projectIds: [project.id],
          homeProjectId: project.id,
          orchestratorThreadId: threadId(i * 30),
          createdAt: FIXTURE_NOW,
        },
        charter: DEFAULT_CHARTER,
        // The benchmark requests ledgers directly; no boot digest or autonomous work is owed.
        paused: { reason: "user", at: FIXTURE_NOW },
      });
      const workers = Object.fromEntries(
        Array.from({ length: 29 }, (_, j) => [
          threadId(i * 30 + j + 1),
          emptyWorkerMemo(FIXTURE_NOW),
        ]),
      );
      yield* store.putOutbox(
        workspaceId(i),
        encodeOutbox({
          ...emptyOutbox,
          booted: true,
          workers,
          ackedReportSeq: FIXTURE.reports - 100,
        }),
      );
    }
    // Half the history is on a long-lived orchestrator; the rest spans all 299 other threads.
    // Bulk generation still runs the shipped FTS/usage triggers. Each transaction holds 1,000 rows.
    for (let start = 0; start < FIXTURE.messages; start += 1000) {
      yield* sql.withTransaction(sql`WITH RECURSIVE n(x) AS (
        SELECT CAST(${start} AS INTEGER) UNION ALL SELECT x + 1 FROM n WHERE x < ${start + 999}
      ), mapped AS (SELECT x, CASE WHEN x < ${FIXTURE.messages / 2} THEN 0 ELSE 1 + ((x / 2) % 299) END AS t FROM n)
      INSERT INTO messages (thread_id, id, seq, role, turn_id, message, rev)
      SELECT 'perf-thread-' || t, 'message-' || x, x + 1,
        CASE WHEN x % 2 = 0 THEN 'user' ELSE 'assistant' END, 'turn-' || (x / 2),
        json_object('id', 'message-' || x, 'role', CASE WHEN x % 2 = 0 THEN 'user' ELSE 'assistant' END,
          'parts', json(CASE WHEN x % 2 = 0 THEN ${JSON.stringify([{ type: "text", text: "Synthetic benchmark prompt" }])}
            ELSE ${JSON.stringify([
              { type: "text", text: "Synthetic benchmark response needle" },
              {
                type: "tool-Bash",
                toolCallId: "synthetic-tool",
                state: "output-available",
                input: { command: "synthetic command" },
                output: "x".repeat(1024),
              },
            ])} END),
          'metadata', json_object('agent', 'claude', 'model', 'synthetic')), x + 1 FROM mapped`);
    }
    yield* sql`UPDATE feed_revision SET rev = ${FIXTURE.messages}`;
    yield* sql`UPDATE threads SET feed_rev = ${FIXTURE.messages}`;
    // 30 days of turns. A one-day usage query is below the shipped admission limits.
    yield* sql`INSERT INTO turns (id, thread_id, started_at, ended_at, reason, usage)
      SELECT turn_id, thread_id, ${FIXTURE_NOW} - 1000 - (seq % 30) * ${DAY_MS},
        ${FIXTURE_NOW} - (seq % 30) * ${DAY_MS}, 'completed',
        '{"tokens":{"inputTokens":10,"outputTokens":5},"costUsd":0.001}'
      FROM messages WHERE role = 'assistant'`;
    yield* sql`WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x + 1 FROM n WHERE x < ${FIXTURE.reports - 1})
      INSERT INTO worker_reports (thread_id, workspace_id, at, data)
      SELECT 'perf-thread-' || (1 + x % 29), 'perf-workspace-0', ${FIXTURE_NOW},
        json_object('threadId', 'perf-thread-' || (1 + x % 29), 'state', 'progress',
          'summary', 'Synthetic progress report', 'at', ${FIXTURE_NOW}) FROM n`;
    yield* sql`WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x + 1 FROM n WHERE x < ${FIXTURE.reports - 1})
      INSERT INTO orchestration_events (workspace_id, at, kind, data)
      SELECT 'perf-workspace-' || (x % 10), ${FIXTURE_NOW}, 'report', '{}' FROM n`;
    yield* sql`WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x + 1 FROM n WHERE x < 599)
      INSERT INTO thread_wakes (id, thread_id, at, set_at, note)
      SELECT 'wake-' || x, 'perf-thread-' || (x % 300), ${FIXTURE_NOW + DAY_MS * 3650},
        ${FIXTURE_NOW}, 'Synthetic wake' FROM n`;
    // Fixed statistics and an empty WAL make the five repeats start from the same file.
    yield* sql`ANALYZE`;
    yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
  });
