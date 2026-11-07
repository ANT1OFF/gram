import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Worker } from "node:worker_threads";
import { SqlClient, SqlError, ConnectionError } from "../platform/unstable.ts";
import { durableCommit } from "./durable-commit.ts";
import { ThreadStore } from "./thread-store.ts";

class CheckpointWorker extends EventEmitter {
  unref() {}
  postMessage() {
    queueMicrotask(() => this.emit("exit", 0));
  }
  terminate() {
    this.emit("exit", 0);
    return Promise.resolve(0);
  }
}

const readMode = (sql: SqlClient.SqlClient) =>
  sql<{ wal_autocheckpoint: number }>`PRAGMA wal_autocheckpoint`.pipe(
    Effect.map((rows) => Number(rows[0]!.wal_autocheckpoint)),
  );
const awaitMode = (sql: SqlClient.SqlClient, expected: number) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 5000; attempt++) {
      if ((yield* readMode(sql)) === expected) return;
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(new Error(`checkpoint mode did not become ${expected}`));
  });

const replaceConnection = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const faulty = new Proxy(sql, {
      get(target, key, receiver) {
        if (key !== "reserve") return Reflect.get(target, key, receiver);
        return target.reserve.pipe(
          Effect.map(
            (conn) =>
              new Proxy(conn, {
                get(connection, method, connectionReceiver) {
                  if (method !== "executeUnprepared")
                    return Reflect.get(connection, method, connectionReceiver);
                  const execute: typeof conn.executeUnprepared = (statement, params, transform) =>
                    statement === "PRAGMA synchronous = NORMAL"
                      ? Effect.fail(
                          new SqlError({
                            reason: new ConnectionError({
                              cause: new Error("synthetic restore failure"),
                              operation: "restore",
                            }),
                          }),
                        )
                      : connection.executeUnprepared(statement, params, transform);
                  return execute;
                },
              }),
          ),
        );
      },
    });
    expect((yield* durableCommit(faulty, Effect.void).pipe(Effect.exit))._tag).toBe("Failure");
  });

const withController = (
  run: (sql: SqlClient.SqlClient, worker: CheckpointWorker) => Effect.Effect<void, unknown>,
  starts = true,
) =>
  Effect.gen(function* () {
    const dir = mkdtempSync(join(tmpdir(), "gram-wal-recovery-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
    );
    const worker = new CheckpointWorker();
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* run(sql, worker);
    }).pipe(
      Effect.provide(
        ThreadStore.layerSqlite(join(dir, "recovery.db"), {
          checkpointOffLoop: true,
          checkpointer: {
            staleMs: 60_000,
            spawn: () => {
              if (!starts) throw new Error("synthetic worker startup failure");
              return worker as unknown as Worker;
            },
          },
        }),
      ),
    );
  }).pipe(Effect.scoped);

describe("checkpoint policy after connection replacement", () => {
  it.effect(
    "restores healthy worker mode before the first borrower, without waiting for a report",
    () =>
      withController((sql, worker) =>
        Effect.gen(function* () {
          expect(yield* readMode(sql)).toBe(0);
          yield* replaceConnection(sql);
          expect(yield* readMode(sql)).toBe(0);
          worker.emit("message", { kind: "checkpoint", log: 0, checkpointed: 0, ms: 0 });
          yield* Effect.yieldNow;
          expect(yield* readMode(sql)).toBe(0);
        }),
      ),
  );
  it.effect("replays fallback and resumed worker modes across successive replacements", () =>
    withController((sql, worker) =>
      Effect.gen(function* () {
        worker.emit("message", { kind: "error", message: "synthetic checkpoint failure" });
        yield* awaitMode(sql, 1000);
        yield* replaceConnection(sql);
        expect(yield* readMode(sql)).toBe(1000);
        worker.emit("message", { kind: "checkpoint", log: 0, checkpointed: 0, ms: 0 });
        yield* awaitMode(sql, 0);
        yield* replaceConnection(sql);
        expect(yield* readMode(sql)).toBe(0);
      }),
    ),
  );
  it.effect("keeps permanent fallback after worker death, including stale healthy reports", () =>
    withController((sql, worker) =>
      Effect.gen(function* () {
        worker.emit("exit", 1);
        yield* awaitMode(sql, 1000);
        yield* replaceConnection(sql);
        expect(yield* readMode(sql)).toBe(1000);
        worker.emit("message", { kind: "checkpoint", log: 0, checkpointed: 0, ms: 0 });
        yield* Effect.yieldNow;
        yield* replaceConnection(sql);
        expect(yield* readMode(sql)).toBe(1000);
      }),
    ),
  );
  it.effect("keeps fallback when no checkpoint worker starts", () =>
    withController(
      (sql) =>
        Effect.gen(function* () {
          expect(yield* readMode(sql)).toBe(1000);
          yield* replaceConnection(sql);
          expect(yield* readMode(sql)).toBe(1000);
        }),
      false,
    ),
  );
});
