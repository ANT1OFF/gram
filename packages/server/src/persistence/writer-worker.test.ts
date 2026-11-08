import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "../platform/unstable.ts";
import { durableCommit, durableSqliteLayer } from "./durable-commit.ts";
import * as WriterWorker from "./writer-worker.ts";

const tempFile = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "gram-writer-worker-"))),
  (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
).pipe(Effect.map((dir) => join(dir, "gram.db")));

const open = (file: string) =>
  Layer.build(durableSqliteLayer({ filename: file, offLoop: true })).pipe(
    Effect.map((context) => Context.get(context, SqlClient.SqlClient)),
  );

describe("writer worker", () => {
  it.live("runs statements, transactions and savepoints on its thread", () =>
    Effect.gen(function* () {
      const sql = yield* open(yield* tempFile);
      yield* sql`CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT UNIQUE, n INTEGER)`;
      yield* sql`INSERT INTO notes (body, n) VALUES ('one', 1), ('two', 2)`;
      expect(yield* sql`SELECT body FROM notes ORDER BY id`).toEqual([
        { body: "one" },
        { body: "two" },
      ]);
      expect(yield* sql`SELECT body, n FROM notes ORDER BY id`.values).toEqual([
        ["one", 1],
        ["two", 2],
      ]);
      expect(yield* sql`UPDATE notes SET n = n + 1`.raw).toEqual({
        changes: 2,
        lastInsertRowid: 2,
      });
      // Big integers survive the trip both ways when asked for.
      const big = 2n ** 60n;
      yield* sql`INSERT INTO notes (body, n) VALUES ('big', ${big})`;
      expect(
        yield* sql`SELECT n FROM notes WHERE body = 'big'`.pipe(
          Effect.provideService(SqlClient.SafeIntegers, true),
        ),
      ).toEqual([{ n: big }]);

      // A failed transaction rolls back, a nested one is a savepoint, and the connection stays usable.
      const failed = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO notes (body) VALUES ('three')`;
            return yield* Effect.fail("stop" as const);
          }),
        )
        .pipe(Effect.flip);
      expect(failed).toBe("stop");
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO notes (body) VALUES ('four')`;
          yield* sql
            .withTransaction(
              sql`INSERT INTO notes (body) VALUES ('five')`.pipe(
                Effect.andThen(Effect.fail("inner")),
              ),
            )
            .pipe(Effect.ignore);
        }),
      );
      expect(
        (yield* sql<{ body: string }>`SELECT body FROM notes ORDER BY id`).map((r) => r.body),
      ).toEqual(["one", "two", "big", "four"]);

      // SQLite's own errors keep their kind across the thread.
      const duplicate = yield* sql`INSERT INTO notes (body) VALUES ('one')`.pipe(Effect.flip);
      expect(duplicate.reason._tag).toBe("UniqueViolation");
      const syntax = yield* sql.unsafe("SELEC 1").pipe(Effect.flip);
      expect(syntax._tag).toBe("SqlError");

      // A durable commit's FULL sync is restored to NORMAL after it.
      yield* durableCommit(sql, sql`INSERT INTO notes (body) VALUES ('durable')`);
      expect(yield* sql`PRAGMA synchronous`).toEqual([{ synchronous: 1 }]);
    }).pipe(Effect.scoped),
  );

  it.live("keeps the event loop running while a statement works", () =>
    Effect.gen(function* () {
      const sql = yield* open(yield* tempFile);
      let ticks = 0;
      const timer = setInterval(() => ticks++, 5);
      yield* Effect.addFinalizer(() => Effect.sync(() => clearInterval(timer)));
      // Long enough that a statement on the loop would starve the timer.
      yield* sql.unsafe(`WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 1000000)
        SELECT count(*) AS n FROM c`);
      expect(ticks).toBeGreaterThan(3);
    }).pipe(Effect.scoped),
  );

  it.live("finishes a statement whose fiber was interrupted before lending the connection on", () =>
    Effect.gen(function* () {
      const sql = yield* open(yield* tempFile);
      yield* sql`CREATE TABLE notes (body TEXT)`;
      const fiber = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO notes (body) VALUES ('kept out')`;
            yield* sql.unsafe(`WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 500000)
              SELECT count(*) FROM c`);
          }),
        )
        .pipe(Effect.forkScoped);
      yield* Effect.sleep("5 millis");
      yield* Fiber.interrupt(fiber);
      // The interrupted transaction rolled back; the next one starts cleanly.
      yield* sql.withTransaction(sql`INSERT INTO notes (body) VALUES ('next')`);
      expect(yield* sql`SELECT body FROM notes`).toEqual([{ body: "next" }]);
    }).pipe(Effect.scoped),
  );

  it.live("replaces a worker that stopped, and checkpoints the WAL on close", () =>
    Effect.gen(function* () {
      const file = yield* tempFile;
      yield* Effect.gen(function* () {
        const sql = yield* open(file);
        yield* sql`CREATE TABLE notes (body TEXT)`;
        yield* sql`INSERT INTO notes (body) VALUES ('before')`;
        // The worker ends under a reservation, as a crash would.
        yield* Effect.scoped(
          Effect.flatMap(sql.reserve, (connection) =>
            Effect.promise(() =>
              (connection as unknown as Record<symbol, () => Promise<void>>)[
                WriterWorker.crashWriter
              ]!(),
            ),
          ),
        );
        // The next statement gets a new worker on the same file.
        yield* sql`INSERT INTO notes (body) VALUES ('after')`;
        expect(yield* sql`SELECT body FROM notes`).toEqual([{ body: "before" }, { body: "after" }]);
      }).pipe(Effect.scoped);
      // The last connection's close checkpointed the WAL and removed it.
      expect(existsSync(`${file}-wal`)).toBe(false);

      // A statement on a stopped worker fails as a lost connection.
      const context = yield* Layer.build(WriterWorker.layer({ filename: file }));
      const client = Context.get(context, SqlClient.SqlClient) as WriterWorker.WriterClient;
      yield* Effect.promise(() => client[WriterWorker.crashWriter]());
      expect(client[WriterWorker.writerStopped]()).toBe(true);
      const error = yield* client`SELECT 1`.pipe(Effect.flip);
      expect(error.reason._tag).toBe("ConnectionError");
    }).pipe(Effect.scoped),
  );
});
