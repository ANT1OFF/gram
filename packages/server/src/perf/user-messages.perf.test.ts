// Entirely generated: a synthetic long-lived orchestrator and worker, no source database or
// provider state. Run with GRAM_PERF_USER_MESSAGES=1.
import { describe, expect, it } from "@effect/vitest";
import { promptText, type GramUIMessage, type Thread, type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { userMessagesOf } from "../orchestration/user-words.ts";
import { findUserMessages, ThreadStore } from "../persistence/thread-store.ts";
import { SqlClient } from "../platform/unstable.ts";

const PERF = process.env["GRAM_PERF_USER_MESSAGES"] === "1";
/** User-role rows on the orchestrator, each followed by a reply. */
const USER_ROWS = 5_000;
const REPEATS = 9;

const median = (xs: ReadonlyArray<number>) =>
  xs.toSorted((a, b) => a - b)[Math.floor(xs.length / 2)]!;

const time = <A>(name: string, effect: Effect.Effect<A>) =>
  Effect.gen(function* () {
    const samples: Array<number> = [];
    for (let i = 0; i < REPEATS; i++) {
      const start = performance.now();
      yield* effect;
      samples.push(performance.now() - start);
    }
    console.log(`${name}: median ${median(samples).toFixed(2)} ms over ${REPEATS}`);
  });

const own = (message: GramUIMessage) => userMessagesOf([message]).length > 0;

const thread = (id: string, dir: string, projectId: string, role?: "orchestrator") =>
  ({
    id,
    projectId,
    title: id,
    userNamed: false,
    model: { agent: "claude", model: "synthetic" },
    mode: "default",
    checkout: { kind: "main", path: dir },
    labels: [],
    pinned: false,
    parked: false,
    unread: false,
    createdAt: 1,
    lastActivityAt: 1,
    ...(role === undefined ? {} : { role }),
  }) as unknown as Thread;

describe.skipIf(!PERF)("a long orchestrator's user-role history", () => {
  it.live(
    "times each caller's read of the user messages against reading them all",
    () =>
      Effect.gen(function* () {
        const dir = mkdtempSync(join(tmpdir(), "gram-user-messages-"));
        yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(dir, { recursive: true })));
        yield* Effect.gen(function* () {
          const store = yield* ThreadStore;
          const sql = yield* SqlClient.SqlClient;
          const project = yield* store.ensureProject({ root: dir, name: "synthetic" });
          const orchestrator = "orchestrator" as ThreadId;
          const worker = "worker" as ThreadId;
          yield* store.insertThread(thread(orchestrator, dir, project.id, "orchestrator"));
          yield* store.insertThread(thread(worker, dir, project.id));
          // Every 50th user-role row is the user's own; the rest are ~2 KB digests from Gram.
          const digest = "Synthetic digest line about a worker's progress. ".repeat(40);
          const reply = "Synthetic orchestrator reply. ".repeat(70);
          yield* sql.withTransaction(sql`WITH RECURSIVE n(x) AS (
              SELECT 0 UNION ALL SELECT x + 1 FROM n WHERE x < ${USER_ROWS * 2 - 1}
            ) INSERT INTO messages (thread_id, id, seq, role, turn_id, message, rev)
            SELECT ${orchestrator}, 'm-' || x, x + 1,
              CASE WHEN x % 2 = 0 THEN 'user' ELSE 'assistant' END, 'turn-' || (x / 2),
              CASE WHEN x % 2 = 1 THEN json_object('id', 'm-' || x, 'role', 'assistant',
                  'parts', json_array(json_object('type', 'text', 'text', ${reply})),
                  'metadata', json_object('createdAt', 1000 + x, 'turnId', 'turn-' || (x / 2)))
                ELSE json_object('id', 'm-' || x, 'role', 'user',
                  'parts', json_array(json_object('type', 'text', 'text',
                    CASE WHEN x % 100 = 0 THEN 'Please do task ' || x ELSE ${digest} END)),
                  'metadata', json_object('createdAt', 1000 + x, 'turnId', 'turn-' || (x / 2),
                    'author', CASE WHEN x % 100 = 0 THEN 'user' ELSE 'server' END))
              END, x + 1 FROM n`);
          // A worker: a prompt every 250 rows among ~8 KB tool-heavy replies.
          const tool = "x".repeat(8_000);
          yield* sql.withTransaction(sql`WITH RECURSIVE n(x) AS (
              SELECT 0 UNION ALL SELECT x + 1 FROM n WHERE x < 4999
            ) INSERT INTO messages (thread_id, id, seq, role, turn_id, message, rev)
            SELECT ${worker}, 'w-' || x, x + 1,
              CASE WHEN x % 250 = 0 THEN 'user' ELSE 'assistant' END, 'wturn-' || (x / 250),
              json_object('id', 'w-' || x,
                'role', CASE WHEN x % 250 = 0 THEN 'user' ELSE 'assistant' END,
                'parts', json_array(json_object('type', 'text', 'text', 'Step ' || x || ' ' || ${tool})),
                'metadata', json_object('createdAt', 1000 + x, 'turnId', 'wturn-' || (x / 250),
                  'author', 'user')), x + 1 FROM n`);
          yield* sql`ANALYZE`;
          const all = (id: ThreadId) =>
            findUserMessages(store, id, { from: "newest", count: Number.POSITIVE_INFINITY });
          expect(yield* all(orchestrator)).toHaveLength(USER_ROWS);
          for (const id of [orchestrator, worker]) {
            yield* time(`${id}: every user message (the old read)`, all(id));
            yield* time(
              `${id}: the user's latest 5 (attach)`,
              findUserMessages(store, id, { from: "newest", count: 5, keep: own }),
            );
            yield* time(
              `${id}: the latest 1 (send guard)`,
              findUserMessages(store, id, { from: "newest", count: 1 }),
            );
            yield* time(
              `${id}: the latest 5 with text (suggest)`,
              findUserMessages(store, id, {
                from: "newest",
                count: 5,
                keep: (m) => promptText(m) !== "",
              }),
            );
            yield* time(
              `${id}: 50 distinct prompts (prompt history)`,
              Effect.suspend(() => {
                const seen = new Set<string>();
                return findUserMessages(store, id, {
                  from: "newest",
                  count: 50,
                  keep: (m) => {
                    const text = promptText(m);
                    if (text === "" || seen.has(text)) return false;
                    seen.add(text);
                    return true;
                  },
                });
              }),
            );
            yield* time(
              `${id}: a tag Gram sent, absent (holds)`,
              store.messagesWith(id, ["absent-tag"], "user"),
            );
          }
        }).pipe(Effect.provide(ThreadStore.layerSqlite(join(dir, "gram.db"))));
      }).pipe(Effect.scoped),
    300_000,
  );
});
