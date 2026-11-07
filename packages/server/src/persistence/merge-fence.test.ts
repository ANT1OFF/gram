import { describe, expect, it } from "@effect/vitest";
import { type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "../platform/unstable.ts";
import { durableCommit } from "./durable-commit.ts";
import { ThreadStore } from "./thread-store.ts";

const pending = {
  key: "example/project\u0000main",
  moved: [],
  pending: {
    pr: { repo: "example/project", number: 5 },
    threadId: "invented-worker" as ThreadId,
    head: "expected-head",
    tip: "checked-tip",
    at: 1,
  },
};

describe("merge fence durability", () => {
  it.effect("acknowledges a fence only after a FULL commit, keeping ordinary writes NORMAL", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "gram-fence-sync-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
      );
      yield* Effect.gen(function* () {
        const store = yield* ThreadStore;
        const sql = yield* SqlClient.SqlClient;
        expect(yield* sql`PRAGMA synchronous`).toEqual([{ synchronous: 1 }]);
        expect(yield* sql`PRAGMA journal_mode`).toEqual([{ journal_mode: "wal" }]);
        // Observe the writer connection's actual setting while it inserts, before its autocommit.
        yield* sql`CREATE TRIGGER require_full_fence BEFORE INSERT ON merge_fences BEGIN
          SELECT CASE WHEN (SELECT synchronous FROM pragma_synchronous) != 2
            THEN RAISE(ABORT, 'fence write was not FULL') END;
        END`;
        yield* store.putMergeFence(pending);
        expect(yield* store.listMergeFences).toEqual([pending]);
        expect(yield* sql`PRAGMA synchronous`).toEqual([{ synchronous: 1 }]);
        yield* store.putMergeFence({ key: pending.key, moved: [pending.pending.tip] });
        expect(yield* sql`PRAGMA synchronous`).toEqual([{ synchronous: 1 }]);
      }).pipe(Effect.provide(ThreadStore.layerSqlite(join(dir, "gram.db"))));
    }).pipe(Effect.scoped),
  );
  it.effect(
    "a failed durable write rolls back and restores NORMAL before releasing the connection",
    () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TRIGGER reject_fence BEFORE INSERT ON merge_fences BEGIN
        SELECT RAISE(ABORT, 'synthetic disk/write refusal'); END`;
        expect((yield* store.putMergeFence(pending).pipe(Effect.exit))._tag).toBe("Failure");
        expect(yield* store.listMergeFences).toEqual([]);
        expect(yield* sql`PRAGMA synchronous`).toEqual([{ synchronous: 1 }]);
        yield* store.ensureProject({
          root: "/invented/after-fence-failure",
          name: "ordinary write",
        });
        yield* sql`DROP TRIGGER reject_fence`;
        yield* store.putMergeFence(pending);
        expect(yield* store.listMergeFences).toEqual([pending]);
      }).pipe(Effect.provide(ThreadStore.layerSqlite(":memory:"))),
  );
  it.effect("a COMMIT refusal rolls back before restoring NORMAL and allowing later writers", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA foreign_keys = ON`;
      yield* sql`CREATE TABLE durable_parent (id INTEGER PRIMARY KEY)`;
      yield* sql`CREATE TABLE durable_child (parent INTEGER REFERENCES durable_parent(id) DEFERRABLE INITIALLY DEFERRED)`;
      const failed = yield* durableCommit(
        sql,
        sql`INSERT INTO durable_child (parent) VALUES (1)`,
      ).pipe(Effect.exit);
      expect(failed._tag).toBe("Failure");
      expect(yield* sql`SELECT * FROM durable_child`).toEqual([]);
      expect(yield* sql`PRAGMA synchronous`).toEqual([{ synchronous: 1 }]);
      yield* durableCommit(sql, sql`INSERT INTO durable_parent (id) VALUES (1)`);
      expect(yield* sql`SELECT * FROM durable_parent`).toEqual([{ id: 1 }]);
    }).pipe(Effect.provide(ThreadStore.layerSqlite(":memory:"))),
  );
});
