import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient, SqlError, ConnectionError } from "../platform/unstable.ts";
import { durableCommit } from "./durable-commit.ts";
import { ThreadStore } from "./thread-store.ts";

const withFile = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.gen(function* () {
    const dir = mkdtempSync(join(tmpdir(), "gram-durable-cleanup-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
    );
    return yield* effect.pipe(Effect.provide(ThreadStore.layerSqlite(join(dir, "cleanup.db"))));
  }).pipe(Effect.scoped);

const schema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`PRAGMA foreign_keys = ON`;
  yield* sql`CREATE TABLE durable_parent (id INTEGER PRIMARY KEY)`;
  yield* sql`CREATE TABLE durable_child (parent_id INTEGER REFERENCES durable_parent(id)
    DEFERRABLE INITIALLY DEFERRED)`;
  yield* sql`INSERT INTO durable_parent(id) VALUES (0)`;
});

describe("durable commit cleanup", () => {
  for (const mode of ["rollback-once", "rollback-always", "restore-normal"] as const) {
    it.effect(`replaces the connection after ${mode} cleanup failure`, () =>
      withFile(
        Effect.gen(function* () {
          yield* schema;
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TEMP TABLE lease_marker (id INTEGER)`;
          const cacheBefore = yield* sql`PRAGMA cache_size`;
          let failures = 0;
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
                        const execute: typeof conn.executeUnprepared = (
                          statement,
                          params,
                          transform,
                        ) => {
                          const rejects =
                            mode === "restore-normal"
                              ? statement === "PRAGMA synchronous = NORMAL" && failures === 0
                              : statement === "ROLLBACK" &&
                                (mode === "rollback-always" || failures === 0);
                          if (rejects) {
                            failures++;
                            return Effect.fail(
                              new SqlError({
                                reason: new ConnectionError({
                                  cause: new Error("synthetic cleanup failure"),
                                  operation: "cleanup",
                                }),
                              }),
                            );
                          }
                          return connection.executeUnprepared(statement, params, transform);
                        };
                        return execute;
                      },
                    }),
                ),
              );
            },
          });
          // The rollback modes genuinely fail COMMIT on a deferred foreign-key violation. Only
          // cleanup is injected. The restoration mode commits first, then fails NORMAL restoration.
          const failed = yield* durableCommit(
            faulty,
            sql`INSERT INTO durable_child(parent_id) VALUES (${mode === "restore-normal" ? 0 : 404})`,
          ).pipe(Effect.exit);
          expect(failed._tag).toBe("Failure");
          expect(failures).toBeGreaterThan(0);
          expect(yield* sql`SELECT parent_id FROM durable_child`).toEqual(
            mode === "restore-normal" ? [{ parent_id: 0 }] : [],
          );
          // TEMP state proves that this is a fresh connection, not the damaged transaction.
          expect(
            yield* sql`SELECT name FROM sqlite_temp_master WHERE name = 'lease_marker'`,
          ).toEqual([]);
          expect(yield* sql`PRAGMA cache_size`).toEqual(cacheBefore);
          const [sync] = yield* sql<{ synchronous: number }>`PRAGMA synchronous`;
          expect(Number(sync!.synchronous)).toBe(1);
          yield* sql.withTransaction(sql`INSERT INTO durable_parent(id) VALUES (1)`);
          yield* durableCommit(sql, sql`INSERT INTO durable_parent(id) VALUES (2)`);
          expect(yield* sql`SELECT id FROM durable_parent ORDER BY id`).toEqual([
            { id: 0 },
            { id: 1 },
            { id: 2 },
          ]);
        }),
      ),
    );
  }

  it.effect("also rolls back an ordinary transaction whose deferred-FK COMMIT fails", () =>
    withFile(
      Effect.gen(function* () {
        yield* schema;
        const sql = yield* SqlClient.SqlClient;
        const failed = yield* sql
          .withTransaction(sql`INSERT INTO durable_child(parent_id) VALUES (404)`)
          .pipe(Effect.exit);
        expect(failed._tag).toBe("Failure");
        expect(yield* sql`SELECT parent_id FROM durable_child`).toEqual([]);
        yield* sql.withTransaction(sql`INSERT INTO durable_parent(id) VALUES (1)`);
        expect(yield* sql`SELECT id FROM durable_parent ORDER BY id`).toEqual([
          { id: 0 },
          { id: 1 },
        ]);
      }),
    ),
  );
  it.effect("does not reopen a connection after the owning layer is closed", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "gram-closed-client-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
      );
      const scope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
      const context = yield* Layer.buildWithScope(
        ThreadStore.layerSqlite(join(dir, "closed.db")),
        scope,
      );
      const sql = Context.get(context, SqlClient.SqlClient);
      expect(yield* sql`SELECT 1 AS n`).toEqual([{ n: 1 }]);
      yield* Scope.close(scope, Exit.void);
      expect((yield* sql`SELECT 1 AS n`.pipe(Effect.exit))._tag).toBe("Failure");
    }).pipe(Effect.scoped),
  );
});
