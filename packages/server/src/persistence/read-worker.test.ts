import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "../platform/unstable.ts";
import * as ReadWorker from "./read-worker.ts";
import { ThreadStore } from "./thread-store.ts";

const tempFile = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "gram-read-worker-"))),
  (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
).pipe(Effect.map((dir) => join(dir, "gram.db")));

describe("read worker", () => {
  it.live("reads what the main connection committed, off the event loop's connection", () =>
    Effect.gen(function* () {
      const file = yield* tempFile;
      const context = yield* Layer.build(ThreadStore.layerSqlite(file));
      const client = Context.get(context, SqlClient.SqlClient);
      yield* client`CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)`;
      yield* client`INSERT INTO notes (body) VALUES ('one'), ('two')`;
      const worker = yield* Layer.build(ReadWorker.layer(file));
      const read = (text: string, params: ReadonlyArray<unknown> = []) =>
        ReadWorker.readOffLoop<{ id: number; body: string }>(text, params).pipe(
          Effect.provide(worker),
          Effect.provideService(SqlClient.SqlClient, client),
        );
      const direct = Context.get(worker, ReadWorker.ReadWorker);
      expect(
        Option.getOrThrow(yield* direct.all("SELECT body FROM notes ORDER BY id", [])),
      ).toEqual([{ body: "one" }, { body: "two" }]);
      expect(yield* read("SELECT id, body FROM notes WHERE id = ?", [2])).toEqual([
        { id: 2, body: "two" },
      ]);
      // A commit after the worker opened is seen by its next statement.
      yield* client`INSERT INTO notes (body) VALUES ('three')`;
      expect((yield* read("SELECT body FROM notes ORDER BY id")).map((r) => r.body)).toEqual([
        "one",
        "two",
        "three",
      ]);
      // It can't write, and a failed statement fails the read rather than falling back.
      const refused = yield* Effect.flip(read("INSERT INTO notes (body) VALUES ('four')"));
      expect(refused._tag).toBe("SqlError");
      expect((yield* client`SELECT count(*) AS n FROM notes`)[0]).toEqual({ n: 3 });
    }).pipe(Effect.scoped),
  );

  it.live("runs on the main connection without a worker, or once the worker can't open", () =>
    Effect.gen(function* () {
      const file = yield* tempFile;
      const context = yield* Layer.build(ThreadStore.layerSqlite(file));
      const client = Context.get(context, SqlClient.SqlClient);
      yield* client`CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)`;
      yield* client`INSERT INTO notes (body) VALUES ('one')`;
      const read = ReadWorker.readOffLoop<{ body: string }>("SELECT body FROM notes", []).pipe(
        Effect.provideService(SqlClient.SqlClient, client),
      );
      expect(yield* read).toEqual([{ body: "one" }]);
      // A file that isn't there: the worker reports it can't open, and reads go to the client.
      const broken = yield* Layer.build(ReadWorker.layer(join(file, "missing", "gram.db")));
      const direct = Context.get(broken, ReadWorker.ReadWorker);
      let answer = yield* direct.all("SELECT 1", []);
      while (Option.isSome(answer)) {
        yield* Effect.sleep("10 millis");
        answer = yield* direct.all("SELECT 1", []);
      }
      expect(yield* read.pipe(Effect.provide(broken))).toEqual([{ body: "one" }]);
    }).pipe(Effect.scoped),
  );

  it.live("stops with its scope after the worker has already exited", () =>
    Effect.gen(function* () {
      const file = yield* tempFile;
      const scope = yield* Scope.make();
      const broken = yield* Layer.buildWithScope(
        ReadWorker.layer(join(file, "missing", "gram.db")),
        scope,
      );
      const direct = Context.get(broken, ReadWorker.ReadWorker);
      while (Option.isSome(yield* direct.all("SELECT 1", []))) yield* Effect.sleep("10 millis");
      // Well after its exit: the stop must not wait for an exit that already happened.
      yield* Effect.sleep("300 millis");
      const closed = yield* Scope.close(scope, Exit.void).pipe(Effect.timeoutOption(5_000));
      expect(Option.isSome(closed)).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.live("keeps answering in order after a read interrupted while it waits", () =>
    Effect.gen(function* () {
      const file = yield* tempFile;
      const context = yield* Layer.build(ThreadStore.layerSqlite(file));
      const client = Context.get(context, SqlClient.SqlClient);
      yield* client`CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)`;
      yield* client`INSERT INTO notes (body) VALUES ('one')`;
      const worker = Context.get(yield* Layer.build(ReadWorker.layer(file)), ReadWorker.ReadWorker);
      // Queued behind a slow statement, then interrupted: it never reaches the worker, so the
      // next read runs straight after the slow one.
      const slow = yield* Effect.forkScoped(
        worker.all(
          "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 2000000) SELECT count(*) AS n FROM c",
          [],
        ),
      );
      const stale = yield* Effect.forkScoped(
        worker.all("SELECT body, randomblob(1) AS r FROM notes", []),
      );
      yield* Effect.sleep("5 millis");
      yield* Fiber.interrupt(stale);
      expect(Option.getOrThrow(yield* Fiber.join(slow))).toEqual([{ n: 2_000_000 }]);
      expect(Option.getOrThrow(yield* worker.all("SELECT body FROM notes", []))).toEqual([
        { body: "one" },
      ]);
    }).pipe(Effect.scoped),
  );
});
