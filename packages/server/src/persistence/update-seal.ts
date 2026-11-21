import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import { statSync } from "node:fs";
import { SqlClient } from "../platform/unstable.ts";

/** How long the seal waits for the writer before it; past it, the database essential fails. */
export const SEAL_TIMEOUT_MS = 1_000;
const SEAL_BUSY_TIMEOUT_MS = 250;
const CLIENT_BUSY_TIMEOUT_MS = 5_000;

interface Tracked {
  readonly filename: string;
  sql: SqlClient.SqlClient | undefined;
  closed: boolean;
  sealed: boolean;
}

let tracked: Tracked | undefined;

const readers = new Map<string, Set<Effect.Effect<void>>>();

/**
 * Registers `stop` to run before `filename` is sealed: a connection of its own (the read worker)
 * that a reader's snapshot would otherwise keep the seal's checkpoint from finishing. Returns the
 * unregistration.
 */
export const beforeSeal = (filename: string, stop: Effect.Effect<void>): (() => void) => {
  const set = readers.get(filename) ?? new Set();
  readers.set(filename, set);
  set.add(stop);
  return () => {
    set.delete(stop);
    if (set.size === 0 && readers.get(filename) === set) readers.delete(filename);
  };
};

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

const walEmpty = (filename: string): boolean => {
  try {
    return statSync(`${filename}-wal`).size === 0;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
};

const seal = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const reserved = yield* sql.reserve.pipe(Effect.timeoutOption(SEAL_TIMEOUT_MS));
    if (Option.isNone(reserved)) return false;
    const conn = reserved.value;
    const run = (statement: string) => conn.executeUnprepared(statement, [], undefined);
    yield* run(`PRAGMA busy_timeout = ${SEAL_BUSY_TIMEOUT_MS}`);
    const durable = yield* Effect.gen(function* () {
      yield* run("BEGIN IMMEDIATE");
      yield* run("ROLLBACK");
      const [row] = (yield* run("PRAGMA wal_checkpoint(TRUNCATE)")) as ReadonlyArray<{
        readonly busy?: unknown;
        readonly log?: unknown;
        readonly checkpointed?: unknown;
      }>;
      return row !== undefined && row.busy === 0 && row.log === row.checkpointed;
    }).pipe(Effect.orElseSucceed(() => false));
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
    yield* Effect.forEach([...(readers.get(entry.filename) ?? [])], (stop) => stop, {
      discard: true,
    });
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
