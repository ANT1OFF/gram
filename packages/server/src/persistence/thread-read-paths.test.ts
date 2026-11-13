import { describe, expect, it } from "@effect/vitest";
import type { Thread, ThreadId, TurnId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { SqlClient } from "../platform/unstable.ts";
import { sqliteProbe } from "../perf/sqlite-probe.ts";
import { findUserMessages, ThreadStore } from "./thread-store.ts";

const withStore = <A, E>(effect: Effect.Effect<A, E, ThreadStore | SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(ThreadStore.layerSqlite(":memory:").pipe(Layer.orDie)));

const addThread = (id: string, title: string) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const project = yield* store.ensureProject({ root: "/work/repo", name: "repo" });
    yield* store.insertThread({
      id,
      projectId: project.id,
      title,
      userNamed: false,
      model: { agent: "claude", model: "opus" },
      mode: "default",
      checkout: { kind: "main", path: "/work/repo" },
      labels: [],
      pinned: false,
      parked: false,
      unread: false,
      createdAt: 1,
      lastActivityAt: 1,
    } as unknown as Thread);
    return id as ThreadId;
  });

const titles = (threads: ReadonlyArray<Thread>) => threads.map((t) => t.title);

describe("messagesSince", () => {
  it.effect("seeks the small changed set before ordering a long thread's resume", () =>
    withStore(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const sql = yield* SqlClient.SqlClient;
          const id = yield* addThread("resume", "long history");
          yield* sql`WITH RECURSIVE n(x) AS (
        SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 1000
      ) INSERT INTO messages (thread_id, id, seq, role, message, rev)
        SELECT ${id}, 'm-' || x, x, 'user',
          json_object('id', 'm-' || x, 'role', 'user', 'parts', json('[]')), x FROM n`;
          // Changed revisions need not be in transcript order: old messages can be updated.
          yield* sql`UPDATE messages SET rev = 1002 WHERE thread_id = ${id} AND seq = 995`;
          yield* sql`ANALYZE`;
          const probe = yield* Effect.acquireRelease(Effect.sync(sqliteProbe), (p) =>
            Effect.sync(p.restore),
          );
          probe.start();
          const resumed = yield* store.messagesSince(id, 990, 10);
          const { calls } = probe.stop();
          expect(resumed?.map((message) => message.id)).toEqual(
            Array.from({ length: 10 }, (_, i) => `m-${991 + i}`),
          );
          const body = calls.find(
            (call) => call.sql.includes("SELECT id, message") && call.sql.includes("rev >"),
          );
          expect(body).toBeDefined();
          const plan = yield* sql.unsafe<{ detail: string }>(
            `EXPLAIN QUERY PLAN ${body!.sql}`,
            body!.bindings,
          );
          expect(plan.map((row) => row.detail)).toEqual([
            "SEARCH messages USING INDEX messages_thread_rev (thread_id=? AND rev>?)",
            "USE TEMP B-TREE FOR ORDER BY",
          ]);
          expect((yield* store.messagesSince(id, 990, 10, "m-998"))?.map((m) => m.id)).toEqual([
            "m-998",
            "m-999",
            "m-1000",
          ]);
          expect(yield* store.messagesSince(id, 990, 9)).toBeUndefined();
          expect(yield* store.messagesSince(id, 990, 10, "missing")).toBeUndefined();
        }),
      ),
    ),
  );
});

// 1,000 user messages (every tenth the user's own) among 1,000 replies, one turn per pair.
const seed = (id: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`WITH RECURSIVE n(x) AS (
        SELECT 0 UNION ALL SELECT x + 1 FROM n WHERE x < 1999
      ) INSERT INTO messages (thread_id, id, seq, role, turn_id, message, rev)
      SELECT ${id}, 'm-' || x, x + 1, CASE WHEN x % 2 = 0 THEN 'user' ELSE 'assistant' END,
        't-' || (x / 2),
        json_object('id', 'm-' || x, 'role', CASE WHEN x % 2 = 0 THEN 'user' ELSE 'assistant' END,
          'parts', json_array(json_object('type', 'text', 'text', 'text ' || x)),
          'metadata', json_object('turnId', 't-' || (x / 2),
            'author', CASE WHEN x % 20 = 0 THEN 'user' ELSE 'server' END)), x + 1 FROM n`;
    yield* sql`ANALYZE`;
  });
const ids = (messages: ReadonlyArray<{ readonly id: string }>) => messages.map((m) => m.id);
const own = (m: { readonly metadata?: { readonly author?: string } }) =>
  m.metadata?.author === "user";

describe("findUserMessages", () => {
  it.effect("reads from either end only as far as the messages it keeps", () =>
    withStore(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const sql = yield* SqlClient.SqlClient;
          const id = yield* addThread("long", "long history");
          yield* seed(id);
          const probe = yield* Effect.acquireRelease(Effect.sync(sqliteProbe), (p) =>
            Effect.sync(p.restore),
          );
          probe.start();
          expect(ids(yield* findUserMessages(store, id, { from: "newest", count: 1 }))).toEqual([
            "m-1998",
          ]);
          const newestOnly = probe.stop().calls;
          expect(newestOnly).toHaveLength(1);
          expect(newestOnly[0]!.bindings).toContain(16);
          expect(ids(yield* findUserMessages(store, id, { from: "oldest", count: 2 }))).toEqual([
            "m-0",
            "m-2",
          ]);
          // The user's own, oldest first: 100 of them, ten user rows apart, across growing pages.
          expect(
            ids(yield* findUserMessages(store, id, { from: "newest", count: 3, keep: own })),
          ).toEqual(["m-1940", "m-1960", "m-1980"]);
          expect(
            yield* findUserMessages(store, id, { from: "newest", count: 1000, keep: own }),
          ).toHaveLength(100);
          // `until` leaves the message it stops at and every one past it.
          expect(
            ids(
              yield* findUserMessages(store, id, {
                from: "newest",
                count: Number.POSITIVE_INFINITY,
                until: (m) => m.id === "m-1990",
              }),
            ),
          ).toEqual(["m-1992", "m-1994", "m-1996", "m-1998"]);
          // A page that doesn't decode is passed by, not read again.
          yield* sql`UPDATE messages SET message = 'not json'
            WHERE thread_id = ${id} AND role = 'user' AND seq > 1900`;
          expect(ids(yield* findUserMessages(store, id, { from: "newest", count: 1 }))).toEqual([
            "m-1898",
          ]);
          // Each page walks the partial index of user rows, never the replies or a sort.
          for (const query of [
            `SELECT id, seq, message FROM messages WHERE thread_id = ? AND role = 'user' ORDER BY seq DESC LIMIT 5`,
            `SELECT id, seq, message FROM messages WHERE thread_id = ? AND role = 'user' AND seq < 900 ORDER BY seq DESC LIMIT 5`,
            `SELECT id, seq, message FROM messages WHERE thread_id = ? AND role = 'user' AND seq > 900 ORDER BY seq LIMIT 5`,
          ]) {
            const plan = yield* sql.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, [id]);
            expect(plan.map((row) => row.detail).join(" | ")).toMatch(
              /^SEARCH messages USING INDEX messages_thread_user \(thread_id=\?( AND seq[<>]\?)?\)$/,
            );
          }
        }),
      ),
    ),
  );

  it.effect("finds a text Gram sent among the user rows only", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const id = yield* addThread("sent", "sent");
        yield* seed(id);
        expect((yield* store.messagesWith(id, ["text 1001"], "user")).map((m) => m.id)).toEqual([]);
        expect((yield* store.messagesWith(id, ["text 1001"])).map((m) => m.id)).toEqual(["m-1001"]);
        expect((yield* store.messagesWith(id, ["text 1000"], "user")).map((m) => m.id)).toEqual([
          "m-1000",
        ]);
        // A notice's exact text, its quotes and line breaks matched as stored; a reply quoting it
        // is not a user message.
        const notice = 'The user answered "WQ1":\n> use 410 [key:abc]';
        yield* store.upsertMessage(id, {
          id: "notice",
          role: "user",
          parts: [{ type: "text", text: notice }],
        } as never);
        yield* store.upsertMessage(id, {
          id: "quoted",
          role: "assistant",
          parts: [{ type: "text", text: `Got it: ${notice}` }],
        } as never);
        expect((yield* store.messagesWith(id, [notice], "user")).map((m) => m.id)).toEqual([
          "notice",
        ]);
        expect((yield* store.messagesWith(id, ["[key:abc]"], "user")).map((m) => m.id)).toEqual([
          "notice",
        ]);
      }),
    ),
  );
});

describe("recentMessages", () => {
  it.effect("finds a reply-heavy thread's window start on the user rows' index alone", () =>
    withStore(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const sql = yield* SqlClient.SqlClient;
          const id = yield* addThread("worker", "few prompts, many replies");
          // A prompt every 100 rows: the 20-turn window starts 2,000 rows back.
          yield* sql`WITH RECURSIVE n(x) AS (
              SELECT 0 UNION ALL SELECT x + 1 FROM n WHERE x < 2999
            ) INSERT INTO messages (thread_id, id, seq, role, message, rev)
            SELECT ${id}, 'w-' || x, x + 1, CASE WHEN x % 100 = 0 THEN 'user' ELSE 'assistant' END,
              json_object('id', 'w-' || x,
                'role', CASE WHEN x % 100 = 0 THEN 'user' ELSE 'assistant' END,
                'parts', json('[]')), x + 1 FROM n`;
          yield* sql`ANALYZE`;
          const probe = yield* Effect.acquireRelease(Effect.sync(sqliteProbe), (p) =>
            Effect.sync(p.restore),
          );
          probe.start();
          const page = yield* store.recentMessages(id, 20);
          const { calls } = probe.stop();
          expect(page.messages[0]?.id).toBe("w-1000");
          expect(page.earlier).toBe(true);
          const start = calls.find((call) => call.sql.includes("OFFSET"));
          expect(start).toBeDefined();
          const plan = yield* sql.unsafe<{ detail: string }>(
            `EXPLAIN QUERY PLAN ${start!.sql}`,
            start!.bindings,
          );
          // Not `messages_thread_seq`, which fetches every reply's row on the way back to test its role.
          expect(plan.map((row) => row.detail)).toEqual([
            "SEARCH messages USING COVERING INDEX messages_thread_user (thread_id=? AND seq<?)",
          ]);
        }),
      ),
    ),
  );
});

describe("listThreads", () => {
  it.effect("decodes the threads once until one of them is written", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const sql = yield* SqlClient.SqlClient;
        const t1 = yield* addThread("t1", "one");
        const first = yield* store.listThreads;
        // The same decoded list, not a fresh read: nothing was written in between.
        expect(yield* store.listThreads).toBe(first);
        // A message save moves the thread's feed revision, which the list doesn't hold.
        yield* store.upsertMessage(t1, { id: "m1", role: "user", parts: [] } as never);
        expect(yield* store.listThreads).toBe(first);

        yield* addThread("t2", "two");
        const added = yield* store.listThreads;
        expect(titles(added)).toEqual(["one", "two"]);

        yield* store.updateThread(t1, (t) => ({ ...t, title: "renamed" }));
        expect(titles(yield* store.listThreads)).toEqual(["renamed", "two"]);

        // A writer that goes around the store is seen as well.
        yield* sql`UPDATE threads SET data = json_set(data, '$.title', 'raw') WHERE id = 't1'`;
        expect(titles(yield* store.listThreads)).toEqual(["raw", "two"]);

        yield* store.removeThread("t2" as ThreadId);
        expect(titles(yield* store.listThreads)).toEqual(["raw"]);
      }),
    ),
  );

  it.effect("never reuses a list read inside a transaction that rolled back", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const sql = yield* SqlClient.SqlClient;
        yield* addThread("t1", "kept");
        expect(titles(yield* store.listThreads)).toEqual(["kept"]);

        const inside = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`UPDATE threads SET data = json_set(data, '$.title', 'undone')`;
              const seen = titles(yield* store.listThreads);
              return yield* Effect.fail(seen);
            }),
          )
          .pipe(Effect.flip);
        expect(inside).toEqual(["undone"]);
        expect(titles(yield* store.listThreads)).toEqual(["kept"]);
      }),
    ),
  );
});

describe("lastTurnUsage", () => {
  it.effect("reads the thread's latest usage from an index, without sorting", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const sql = yield* SqlClient.SqlClient;
        const id = yield* addThread("t1", "one");
        const usage = { tokens: { inputTokens: 5, outputTokens: 1 } };
        yield* store.startTurn(id, "a" as TurnId, 1);
        yield* store.endTurn("a" as TurnId, { endedAt: 2, reason: "completed", usage });
        expect(yield* store.lastTurnUsage(id)).toEqual(usage);

        const plan = yield* sql<{ detail: string }>`EXPLAIN QUERY PLAN SELECT id, usage FROM turns
          WHERE thread_id = ${id} AND ended_at IS NOT NULL AND usage IS NOT NULL
          ORDER BY ended_at DESC, rowid DESC LIMIT 1`;
        expect(plan.map((row) => row.detail)).toEqual([
          "SEARCH turns USING INDEX turns_thread_usage (thread_id=? AND ended_at>?)",
        ]);
      }),
    ),
  );
});
