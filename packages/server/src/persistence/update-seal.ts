/**
 * The database half of an update's essentials (`runtime/shutdown.ts`). An update may replace the app
 * once the database is durable and nothing can be writing to it, even while other finalizers of the
 * server's teardown still run: main then kills the rest of the server's tree.
 *
 * Either the client's own close already ran, which in WAL mode checkpoints the WAL into the database
 * and removes it, or the seal takes the client's single connection for good: once every writer
 * before it has finished (the client serialises them, a transaction included), it proves that no
 * transaction is open and none is held by another connection, and checkpoints the whole WAL. A
 * statement or transaction after the seal waits on the connection and never starts.
 *
 * Only the server's own database file is tracked (`ThreadStore.layerSqlite`); an in-memory test
 * database never is.
 */
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import { statSync } from "node:fs";
import { SqlClient } from "../platform/unstable.ts";

/** How long the seal waits for the writer before it; past it, the database essential fails. */
export const SEAL_TIMEOUT_MS = 1_000;
/** SQLite's own lock waits during the seal, which block the event loop while they last. */
const SEAL_BUSY_TIMEOUT_MS = 250;
/** The client's busy timeout (`SqliteClient`'s default), restored when a seal fails. */
const CLIENT_BUSY_TIMEOUT_MS = 5_000;

interface Tracked {
  readonly filename: string;
  sql: SqlClient.SqlClient | undefined;
  closed: boolean;
  sealed: boolean;
}

let tracked: Tracked | undefined;

/**
 * Tracks `filename`'s client: `under` goes beneath the client, so its finalizer runs after the
 * client's close; `over` goes above it, to reach the client while it is open.
 */
export const layers = (filename: string) => {
  const entry: Tracked = {
    filename,
    sql: undefined,
    closed: false,
    sealed: false,
  };
  const under = Layer.effectDiscard(
    Effect.gen(function* () {
      tracked = entry;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          entry.closed = true;
        }),
      );
    }),
  );
  const over = Layer.effectDiscard(
    Effect.map(SqlClient.SqlClient, (sql) => {
      entry.sql = sql;
    }),
  );
  return { under, over };
};

/** Whether `filename` has no WAL left beside it: absent, or truncated to nothing. */
const walEmpty = (filename: string): boolean => {
  try {
    return statSync(`${filename}-wal`).size === 0;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
};

/** Whether `sql`'s connection, taken for the life of `Scope`, proves the database durable. */
const seal = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const reserved = yield* sql.reserve.pipe(Effect.timeoutOption(SEAL_TIMEOUT_MS));
    if (Option.isNone(reserved)) return false;
    const conn = reserved.value;
    const run = (statement: string) => conn.executeUnprepared(statement, [], undefined);
    yield* run(`PRAGMA busy_timeout = ${SEAL_BUSY_TIMEOUT_MS}`);
    const durable = yield* Effect.gen(function* () {
      // Fails inside an open transaction, and while another connection holds the write lock.
      yield* run("BEGIN IMMEDIATE");
      yield* run("ROLLBACK");
      const [row] = (yield* run("PRAGMA wal_checkpoint(TRUNCATE)")) as ReadonlyArray<{
        readonly busy?: unknown;
        readonly log?: unknown;
        readonly checkpointed?: unknown;
      }>;
      return row !== undefined && row.busy === 0 && row.log === row.checkpointed;
    }).pipe(Effect.orElseSucceed(() => false));
    // The teardown may still use the connection once a failed seal lets go of it.
    if (!durable) yield* run(`PRAGMA busy_timeout = ${CLIENT_BUSY_TIMEOUT_MS}`).pipe(Effect.ignore);
    return durable;
  }).pipe(
    Effect.orElseSucceed(() => false),
    Effect.catchDefect(() => Effect.succeed(false)),
  );

/**
 * Seals the tracked database for an update; true once it is durable and can't be written again in
 * this process. A failed seal lets go of the connection, so the teardown can still close it.
 */
export const sealForUpdate: Effect.Effect<boolean> = Effect.suspend(() => {
  const entry = tracked;
  if (entry === undefined) return Effect.succeed(false);
  if (entry.sealed) return Effect.succeed(true);
  if (entry.closed) return Effect.sync(() => walEmpty(entry.filename));
  const sql = entry.sql;
  if (sql === undefined) return Effect.succeed(false);
  return Effect.gen(function* () {
    // Never closed once sealed: the connection stays taken until the process ends.
    const scope = yield* Scope.make();
    const sealed = yield* seal(sql).pipe(Scope.provide(scope));
    if (sealed) {
      entry.sealed = true;
      return true;
    }
    yield* Scope.close(scope, Exit.void);
    return false;
  });
});
