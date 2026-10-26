import { describe, expect, it } from "@effect/vitest";
import type { Thread, ThreadId, TurnId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { SqlClient } from "../platform/unstable.ts";
import { ThreadStore } from "./thread-store.ts";

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
