import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "../platform/unstable.ts";
import { readOffLoop } from "./read-worker.ts";
import { ThreadStore } from "./thread-store.ts";
import { SEAL_TIMEOUT_MS, sealForUpdate } from "./update-seal.ts";

// The server's own database layer on a throwaway file, WAL checkpointer included; nothing else.
const dirs: Array<string> = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const databaseFile = () => {
  const dir = mkdtempSync(join(tmpdir(), "gram-seal-"));
  dirs.push(dir);
  return join(dir, "gram.db");
};
const walBytes = (file: string) => {
  try {
    return statSync(`${file}-wal`).size;
  } catch {
    return 0;
  }
};

/** The database open in a scope the test closes, and its client. */
const open = (file: string) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      ThreadStore.layerSqlite(file, { checkpointOffLoop: true, writerOffLoop: true }),
      scope,
    );
    const sql = yield* SqlClient.SqlClient.pipe(Effect.provideContext(context));
    yield* sql`CREATE TABLE IF NOT EXISTS seal_probe (id INTEGER PRIMARY KEY, data TEXT)`;
    return { scope, sql };
  });

const insert = (sql: SqlClient.SqlClient, n: number) =>
  Effect.forEach(
    Array.from({ length: n }, (_, i) => i),
    (i) => sql`INSERT INTO seal_probe (data) VALUES (${`row ${i} ${"x".repeat(2_000)}`})`,
    { discard: true },
  );

describe("update database seal", () => {
  it.live("checkpoints the whole WAL and keeps every later write from starting", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const file = databaseFile();
        const { scope, sql } = yield* open(file);
        yield* insert(sql, 200);
        expect(walBytes(file)).toBeGreaterThan(0);
        expect(yield* sealForUpdate).toBe(true);
        expect(walBytes(file)).toBe(0);
        // Sealed for good: a write after it waits on the connection and never begins.
        const late = yield* Effect.forkScoped(insert(sql, 1));
        expect(yield* Fiber.await(late).pipe(Effect.timeoutOption(300))).toEqual(Option.none());
        expect(yield* sealForUpdate).toBe(true);
        yield* Fiber.interrupt(late);
        const closed = yield* Scope.close(scope, Exit.void).pipe(Effect.timeoutOption(10_000));
        expect(Option.isSome(closed)).toBe(true);
      }),
    ),
  );

  it.live("stops the read worker, letting its statement finish, before it checkpoints", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const file = databaseFile();
        const scope = yield* Scope.make();
        const context = yield* Layer.buildWithScope(
          ThreadStore.layerSqlite(file, { checkpointOffLoop: true, writerOffLoop: true }),
          scope,
        );
        const sql = yield* SqlClient.SqlClient.pipe(Effect.provideContext(context));
        yield* sql`CREATE TABLE IF NOT EXISTS seal_probe (id INTEGER PRIMARY KEY, data TEXT)`;
        yield* insert(sql, 200);
        const count = readOffLoop<{ n: number }>("SELECT count(*) AS n FROM seal_probe", []).pipe(
          Effect.provideContext(context),
        );
        // The worker holds a snapshot until it is stopped: a read transaction left open on its
        // connection, in place of a statement sized to outlast the seal's lock wait, so no runner's
        // speed decides whether the seal meets a reader.
        yield* readOffLoop("BEGIN", []).pipe(Effect.provideContext(context));
        expect(yield* count).toEqual([{ n: 200 }]);
        // Committed past the worker's snapshot: while it holds it, no checkpoint can empty the WAL.
        yield* insert(sql, 1);
        const [held] = yield* sql<{ busy: number; log: number; checkpointed: number }>`
          PRAGMA wal_checkpoint(PASSIVE)`;
        expect(held !== undefined && held.busy === 0 && held.log === held.checkpointed).toBe(false);
        // Sent to the worker before the seal begins, so it is running when the seal stops it. Inside
        // the snapshot it reads 200; rerun on the writer, it would read 201, or never start once
        // sealed.
        const read = yield* Effect.forkScoped(count, { startImmediately: true });
        expect(yield* sealForUpdate).toBe(true);
        expect(walBytes(file)).toBe(0);
        expect(yield* Fiber.join(read)).toEqual([{ n: 200 }]);
        const closed = yield* Scope.close(scope, Exit.void).pipe(Effect.timeoutOption(10_000));
        expect(Option.isSome(closed)).toBe(true);
      }),
    ),
  );

  it.live("fails while a writer holds a transaction past its bound, and lets go after", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const file = databaseFile();
        const { scope, sql } = yield* open(file);
        const release = yield* Deferred.make<void>();
        const writer = yield* Effect.forkScoped(
          sql.withTransaction(insert(sql, 1).pipe(Effect.andThen(Deferred.await(release)))),
        );
        yield* Effect.sleep(50);
        const started = Date.now();
        expect(yield* sealForUpdate).toBe(false);
        expect(Date.now() - started).toBeGreaterThanOrEqual(SEAL_TIMEOUT_MS - 50);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(writer);
        // The failed seal let go of the connection: the teardown can still use and close it.
        yield* insert(sql, 1);
        const rows = yield* sql<{ n: number }>`SELECT count(*) AS n FROM seal_probe`;
        expect(Number(rows[0]?.n)).toBe(2);
        yield* Scope.close(scope, Exit.void);
      }),
    ),
  );

  it.live("accepts a database its own close already checkpointed and closed", () =>
    Effect.gen(function* () {
      const file = databaseFile();
      const { scope, sql } = yield* open(file);
      yield* insert(sql, 50);
      yield* Scope.close(scope, Exit.void);
      expect(walBytes(file)).toBe(0);
      expect(yield* sealForUpdate).toBe(true);
    }),
  );
});
