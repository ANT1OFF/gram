import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { describe, expect, it } from "@effect/vitest";
import { ThreadNotFound, type Thread, type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MigrationsLayer } from "../persistence/migrations.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { SqlClient } from "../platform/unstable.ts";
import { CATCH_UP_BATCH, catchUpSearch } from "./catch-up.ts";
import { searchHandlers } from "./handler.ts";
import { parseSnippet, searchThreads, toMatchQuery } from "./search.ts";

const tempDb = Effect.gen(function* () {
  const dir = mkdtempSync(join(tmpdir(), "gram-search-"));
  yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(dir, { recursive: true })));
  return join(dir, "gram.db");
});

/** Opens the database at `file`, migrating it, for the length of `effect`. */
const openDb = <A, E>(
  file: string,
  effect: Effect.Effect<A, E, ThreadStore | SqlClient.SqlClient>,
) => effect.pipe(Effect.provide(ThreadStore.layerSqlite(file).pipe(Layer.orDie)));

/** A migrated database in a temp dir, removed when the test's scope closes. */
const withDb = <A, E>(effect: Effect.Effect<A, E, ThreadStore | SqlClient.SqlClient>) =>
  Effect.flatMap(tempDb, (file) => openDb(file, effect));

/** The store without its startup sweep: what a crash leaves for the next start to find. */
const openWithoutSweep = <A, E>(
  file: string,
  effect: Effect.Effect<A, E, ThreadStore | SqlClient.SqlClient>,
) =>
  effect.pipe(
    Effect.provide(
      ThreadStore.layerNoDeps.pipe(
        Layer.provideMerge(MigrationsLayer),
        Layer.provideMerge(SqliteClient.layer({ filename: file })),
        Layer.orDie,
      ),
    ),
  );

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

const say = (
  threadId: ThreadId,
  id: string,
  role: "user" | "assistant",
  parts: ReadonlyArray<object>,
) =>
  Effect.flatMap(ThreadStore, (store) =>
    store.upsertMessage(threadId, { id, role, parts } as never),
  );

const text = (value: string) => ({ type: "text", text: value });

/** A save of a reply between two index refreshes, as the feed writer makes while it streams. */
const stream = (threadId: ThreadId, id: string, value: string) =>
  Effect.flatMap(ThreadStore, (store) =>
    store.upsertMessage(
      threadId,
      { id, role: "assistant", parts: [text(value)] } as never,
      undefined,
      {
        streaming: true,
      },
    ),
  );

/** The messages the index matches for `query`. */
const indexed = (query: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{ id: string }>`SELECT message_id AS id FROM message_search
      WHERE message_search MATCH ${query} ORDER BY message_id`.pipe(
      Effect.map((rows) => rows.map((r) => r.id)),
    ),
  );

/** The messages whose index row is behind. */
const behind = Effect.flatMap(SqlClient.SqlClient, (sql) =>
  sql<{ id: string }>`SELECT id FROM messages WHERE search_pending IS NOT NULL ORDER BY id`.pipe(
    Effect.map((rows) => rows.map((r) => r.id)),
  ),
);

/** Lets the background sweep run: it yields between batches. */
const letSweepRun = Effect.gen(function* () {
  for (let turn = 0; turn < 100; turn++) yield* Effect.yieldNow;
});

describe("toMatchQuery", () => {
  it("quotes every term and prefix-matches the last", () => {
    expect(toMatchQuery("fix login")).toBe('"fix" "login"*');
    expect(toMatchQuery('he said "hi"')).toBe('"he" "said" """hi"""*');
    expect(toMatchQuery("  NEAR( AND/OR stuff:  ")).toBe('"NEAR(" "AND/OR" "stuff:"*');
    expect(toMatchQuery("* - ( )")).toBeUndefined();
    expect(toMatchQuery("")).toBeUndefined();
  });
});

describe("parseSnippet", () => {
  it("returns highlight ranges as UTF-16 offsets into the unmarked text", () => {
    expect(parseSnippet("Fix the \u0001flaky\u0002 test\nnow")).toEqual({
      snippet: "Fix the flaky test now",
      highlights: [{ start: 8, end: 13 }],
    });
    const emoji = parseSnippet("😀 \u0001wörld\u0002 and \u0001more\u0002");
    expect(emoji.highlights).toEqual([
      { start: 3, end: 8 },
      { start: 13, end: 17 },
    ]);
    expect(emoji.snippet.slice(3, 8)).toBe("wörld");
  });
});

describe("searchThreads", () => {
  it.effect("indexes text, reasoning and tool input on persist, and re-indexes on upsert", () =>
    withDb(
      Effect.gen(function* () {
        const t1 = yield* addThread("t1", "rewrite");
        yield* say(t1, "m1", "user", [text("Fix the flaky login test")]);
        yield* say(t1, "m2", "assistant", [
          { type: "reasoning", text: "checking the retry logic" },
          {
            type: "tool-Bash",
            toolCallId: "c1",
            state: "input-available",
            input: { command: "pnpm vitest login" },
          },
          text("Done"),
        ]);

        expect(yield* searchThreads({ query: "flaky" })).toEqual({
          hits: [
            {
              threadId: "t1",
              messageId: "m1",
              title: "rewrite",
              snippet: "Fix the flaky login test",
              highlights: [{ start: 8, end: 13 }],
            },
          ],
          truncated: false,
        });
        expect((yield* searchThreads({ query: "retry" })).hits.map((h) => h.messageId)).toEqual([
          "m2",
        ]);
        expect((yield* searchThreads({ query: "vitest" })).hits.map((h) => h.messageId)).toEqual([
          "m2",
        ]);

        yield* say(t1, "m1", "user", [text("Fix the broken login test")]);
        expect((yield* searchThreads({ query: "flaky" })).hits).toEqual([]);
        expect((yield* searchThreads({ query: "broken" })).hits.map((h) => h.messageId)).toEqual([
          "m1",
        ]);
      }),
    ),
  );

  it.effect("drops truncated messages from the index on rewind", () =>
    withDb(
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const t1 = yield* addThread("t1", "rewrite");
        yield* say(t1, "m1", "user", [text("alpha")]);
        yield* say(t1, "m2", "assistant", [text("beta")]);
        yield* say(t1, "m3", "user", [text("gamma")]);

        yield* store.truncateMessagesFrom(t1, "m2");
        expect((yield* searchThreads({ query: "beta" })).hits).toEqual([]);
        expect((yield* searchThreads({ query: "gamma" })).hits).toEqual([]);
        expect((yield* searchThreads({ query: "alpha" })).hits.map((h) => h.messageId)).toEqual([
          "m1",
        ]);
      }),
    ),
  );

  it.effect("finds threads by title, following renames and closes", () =>
    withDb(
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const billing = yield* addThread("t-billing", "Refactor billing");
        const other = yield* addThread("t-other", "Billing notes");
        yield* say(other, "m1", "user", [text("the billing export is slow")]);

        expect((yield* searchThreads({ query: "billing" })).hits).toEqual([
          {
            threadId: "t-billing",
            title: "Refactor billing",
            snippet: "Refactor billing",
            highlights: [{ start: 9, end: 16 }],
          },
          expect.objectContaining({ threadId: "t-other", messageId: "m1", title: "Billing notes" }),
        ]);

        yield* store.updateThread(billing, (t) => ({ ...t, title: "Payments cleanup" }));
        expect((yield* searchThreads({ query: "refactor" })).hits).toEqual([]);
        expect((yield* searchThreads({ query: "payments" })).hits.map((h) => h.threadId)).toEqual([
          "t-billing",
        ]);

        yield* store.removeThread(other);
        expect((yield* searchThreads({ query: "billing" })).hits).toEqual([]);
      }),
    ),
  );

  it.effect("prefix-matches only the last word", () =>
    withDb(
      Effect.gen(function* () {
        const t1 = yield* addThread("t1", "rewrite");
        yield* say(t1, "m1", "user", [text("the authentication flow")]);
        expect((yield* searchThreads({ query: "auth" })).hits).toHaveLength(1);
        expect((yield* searchThreads({ query: "authentication fl" })).hits).toHaveLength(1);
        expect((yield* searchThreads({ query: "fl authentication" })).hits).toEqual([]);
      }),
    ),
  );

  it.effect("treats query syntax as literal text", () =>
    withDb(
      Effect.gen(function* () {
        const t1 = yield* addThread("t1", "rewrite");
        yield* say(t1, "m1", "user", [text('use "quotes" AND/OR NEAR(x) stuff: here')]);
        for (const query of ['"quotes"', "AND/OR", "NEAR(x)", "stuff:", "quotes)"]) {
          expect((yield* searchThreads({ query })).hits, query).toHaveLength(1);
        }
        for (const query of ["*", "-", "(", '"', "^"]) {
          expect(yield* searchThreads({ query }), query).toEqual({ hits: [], truncated: false });
        }
      }),
    ),
  );

  it.effect("scopes to a thread and reports truncation past the limit", () =>
    withDb(
      Effect.gen(function* () {
        const t1 = yield* addThread("t1", "one");
        const t2 = yield* addThread("t2", "two");
        yield* say(t1, "m1", "user", [text("deploy to staging")]);
        yield* say(t2, "m2", "user", [text("deploy to prod")]);
        yield* say(t2, "m3", "assistant", [text("deploy finished")]);

        const scoped = yield* searchThreads({ query: "deploy", threadId: t2 });
        expect(scoped.hits.map((h) => h.messageId).toSorted()).toEqual(["m2", "m3"]);
        expect(scoped.truncated).toBe(false);

        const limited = yield* searchThreads({ query: "deploy", limit: 2 });
        expect(limited.hits).toHaveLength(2);
        expect(limited.truncated).toBe(true);
      }),
    ),
  );
});

describe("a reply saved between index refreshes", () => {
  it.effect("keeps its last indexed text until the next refresh or settle", () =>
    withDb(
      Effect.gen(function* () {
        const t1 = yield* addThread("t1", "rewrite");
        yield* say(t1, "r1", "assistant", [text("looking at the scheduler")]);
        yield* stream(t1, "r1", "looking at the scheduler and the retry queue");
        expect((yield* searchThreads({ query: "scheduler" })).hits).toHaveLength(1);
        expect((yield* searchThreads({ query: "retry" })).hits).toEqual([]);
        expect(yield* behind).toEqual(["r1"]);

        yield* say(t1, "r1", "assistant", [text("looking at the scheduler and the retry queue")]);
        expect((yield* searchThreads({ query: "retry" })).hits.map((h) => h.messageId)).toEqual([
          "r1",
        ]);
        expect(yield* behind).toEqual([]);
      }),
    ),
  );

  it.effect("is indexed with its newest text by the next start after a crash", () =>
    Effect.gen(function* () {
      const file = yield* tempDb;
      yield* openWithoutSweep(
        file,
        Effect.gen(function* () {
          const t1 = yield* addThread("t1", "rewrite");
          yield* say(t1, "r1", "assistant", [text("bisecting the regression")]);
          yield* stream(t1, "r1", "bisecting the regression to the tokenizer change");
        }),
      );
      yield* openDb(
        file,
        Effect.gen(function* () {
          yield* letSweepRun;
          expect(yield* behind).toEqual([]);
          expect(
            (yield* searchThreads({ query: "tokenizer" })).hits.map((h) => h.messageId),
          ).toEqual(["r1"]);
        }),
      );
    }),
  );

  it.effect("is indexed by a write that leaves the mark as it was", () =>
    Effect.gen(function* () {
      const file = yield* tempDb;
      yield* openWithoutSweep(
        file,
        Effect.gen(function* () {
          const t1 = yield* addThread("t1", "rewrite");
          yield* say(t1, "r1", "assistant", [text("a reply")]);
          yield* stream(t1, "r1", "a reply cut off");
        }),
      );
      // An upsert that names no `search_pending` leaves the mark as it was.
      yield* openWithoutSweep(
        file,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const message = JSON.stringify({
            id: "r1",
            role: "assistant",
            parts: [text("a reply another writer finished")],
          });
          yield* sql`INSERT INTO messages (thread_id, id, seq, role, turn_id, message, rev)
            VALUES ('t1', 'r1', 1, 'assistant', NULL, ${message}, 99)
            ON CONFLICT (thread_id, id) DO UPDATE SET
              message = excluded.message,
              turn_id = COALESCE(excluded.turn_id, messages.turn_id),
              rev = excluded.rev`;
          expect(yield* indexed("finished")).toEqual(["r1"]);
        }),
      );
    }),
  );

  it.effect("is swept in bounded batches", () =>
    withDb(
      Effect.gen(function* () {
        const t1 = yield* addThread("t1", "rewrite");
        for (let i = 0; i < 2 * CATCH_UP_BATCH + 1; i++) {
          yield* say(t1, `r${i}`, "assistant", [text("part")]);
          yield* stream(t1, `r${i}`, `part ${i} continued`);
        }
        expect(yield* behind).toHaveLength(2 * CATCH_UP_BATCH + 1);
        expect(yield* catchUpSearch()).toBe(3);
        expect(yield* behind).toEqual([]);
        expect(yield* indexed("continued")).toHaveLength(2 * CATCH_UP_BATCH + 1);
      }),
    ),
  );

  it.live("keeps sweeping through a write lock held past the busy timeout", () =>
    Effect.gen(function* () {
      const file = yield* tempDb;
      yield* openWithoutSweep(
        file,
        Effect.gen(function* () {
          const t1 = yield* addThread("t1", "rewrite");
          yield* say(t1, "r1", "assistant", [text("a reply")]);
          yield* stream(t1, "r1", "a reply held behind a lock");
        }),
      );
      const other = new DatabaseSync(file);
      try {
        // Another process holds the write lock, and the sweep's busy timeout is short.
        other.exec("BEGIN IMMEDIATE");
        yield* Effect.gen(function* () {
          const sweep = yield* Effect.forkScoped(catchUpSearch(Schedule.spaced("20 millis")));
          yield* Effect.sleep("200 millis");
          expect(yield* behind).toEqual(["r1"]);
          other.exec("ROLLBACK");
          expect(yield* Fiber.join(sweep)).toBe(1);
          expect(yield* behind).toEqual([]);
          expect(yield* indexed("lock")).toEqual(["r1"]);
        }).pipe(Effect.provide(SqliteClient.layer({ filename: file, busyTimeout: "10 millis" })));
      } finally {
        if (other.isTransaction) other.exec("ROLLBACK");
        other.close();
      }
    }),
  );

  it.effect("drops from the index with a rewind while behind", () =>
    withDb(
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const t1 = yield* addThread("t1", "rewrite");
        yield* say(t1, "u1", "user", [text("start")]);
        yield* say(t1, "r1", "assistant", [text("halfway")]);
        yield* stream(t1, "r1", "halfway through the migration");
        yield* store.truncateMessagesFrom(t1, "r1");
        expect((yield* searchThreads({ query: "halfway" })).hits).toEqual([]);
      }),
    ),
  );
});

describe("thread.search handler", () => {
  it.effect("fails with ThreadNotFound for an unknown scope", () =>
    withDb(
      Effect.gen(function* () {
        const handlers = yield* searchHandlers;
        const error = yield* handlers["thread.search"]({
          query: "x",
          threadId: "missing" as ThreadId,
        }).pipe(Effect.flip);
        expect(error).toBeInstanceOf(ThreadNotFound);
      }),
    ),
  );
});
