/**
 * The server's own SQLite connection on a worker thread, so a write (or any statement on that
 * connection) never holds the event loop while SQLite works. `node:sqlite` is synchronous: on the
 * main thread a large write, a lock wait behind a checkpoint, or a long read stopped every socket,
 * stream and timer of the server until it finished (510–780 ms stalls on the 200,000-message perf
 * fixture).
 *
 * This is the same single connection as before, moved: the client still serialises every statement
 * and transaction through one connection (`durableSqliteLayer`'s gate), so ordering, transactions,
 * savepoints and `durableCommit`'s FULL sync all behave as they did. What changes is that each
 * statement is a message to the worker and back, so the event loop runs other fibers while SQLite
 * works; a fiber outside a transaction can now run between two statements of another fiber's
 * non-transactional sequence, as it could already between any two awaited steps.
 *
 * A statement once sent always finishes: its fiber waits for the answer even when interrupted,
 * so the connection is never lent on while the worker still runs a statement, and the client's
 * idea of whether a transaction is open (`isTransaction`) always matches the worker's.
 *
 * The worker is plain JavaScript in a string, so a bundler has nothing to resolve or rewrite in it.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { classifySqliteError, ConnectionError } from "effect/sql/SqlError";
import { Worker } from "node:worker_threads";
import { SqlClient, SqlError, SqlStatement, type SqlConnection } from "../platform/unstable.ts";

/** The client's lock wait, as `SqliteClient`'s default. */
const BUSY_TIMEOUT_MS = 5_000;

/** How many prepared statements the worker keeps, as `SqliteClient`'s default. */
const STATEMENT_CACHE = 200;

/** How long close waits for the worker to close its connection (and checkpoint) before terminating. */
const STOP_TIMEOUT_MS = 10_000;

const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const errorOf = (e) =>
  e instanceof Error
    ? { message: e.message, code: e.code, errcode: e.errcode, errstr: e.errstr, prepare: e.gramPrepare === true }
    : { message: String(e) };
let db;
try {
  db = new DatabaseSync(workerData.filename);
  db.exec("PRAGMA busy_timeout = " + workerData.busyTimeoutMs);
  // Switching to WAL can fail with SQLITE_BUSY without invoking the busy handler: retry it until
  // the busy timeout has passed, as SqliteClient does.
  const deadline = Date.now() + workerData.busyTimeoutMs;
  for (;;) {
    try {
      db.prepare("PRAGMA journal_mode = WAL").get();
      break;
    } catch (e) {
      if (!(e && (e.errcode & 0xff) === 5) || Date.now() >= deadline) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  parentPort.postMessage({ kind: "ready" });
} catch (e) {
  parentPort.postMessage({ kind: "failed", error: errorOf(e) });
  process.exit(1);
}
const statements = new Map();
const prepared = (sql) => {
  let statement = statements.get(sql);
  if (statement !== undefined) {
    statements.delete(sql);
  } else {
    statement = db.prepare(sql);
    if (statements.size >= workerData.statementCache) {
      statements.delete(statements.keys().next().value);
    }
  }
  statements.set(sql, statement);
  return statement;
};
const execute = (m) => {
  let statement;
  try {
    statement = m.prepared ? prepared(m.sql) : db.prepare(m.sql);
  } catch (e) {
    e.gramPrepare = true;
    throw e;
  }
  statement.setReadBigInts(m.safeIntegers);
  if (m.mode === "values") {
    statement.setReturnArrays(true);
    try {
      return statement.all(...m.params);
    } finally {
      statement.setReturnArrays(false);
    }
  }
  if (m.mode === "rows" || statement.columns().length > 0) return statement.all(...m.params);
  const result = statement.run(...m.params);
  return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
};
parentPort.on("message", (m) => {
  if (m === "stop") {
    try {
      db.close();
    } catch {
      // The thread ends either way.
    }
    parentPort.close();
    return;
  }
  const start = performance.now();
  try {
    const result = execute(m);
    parentPort.postMessage({ kind: "ok", id: m.id, result, inTx: db.isTransaction, ms: performance.now() - start });
  } catch (e) {
    parentPort.postMessage({ kind: "error", id: m.id, error: errorOf(e), inTx: db.isTransaction, ms: performance.now() - start });
  }
});
`;

interface WorkerError {
  readonly message: string;
  readonly code?: unknown;
  readonly errcode?: unknown;
  readonly errstr?: unknown;
  /** Failed preparing the statement, not running it. */
  readonly prepare?: boolean;
}

type Reply =
  | { readonly kind: "ready" }
  | { readonly kind: "failed"; readonly error: WorkerError }
  | {
      readonly kind: "ok";
      readonly id: number;
      readonly result: unknown;
      readonly inTx: boolean;
      readonly ms: number;
    }
  | {
      readonly kind: "error";
      readonly id: number;
      readonly error: WorkerError;
      readonly inTx: boolean;
      readonly ms: number;
    };

type Mode = "rows" | "raw" | "values";

/** A statement the worker ran: for the perf probe (`perf/sqlite-probe.ts`) only. */
export interface ObservedStatement {
  readonly sql: string;
  readonly params: ReadonlyArray<unknown>;
  /** SQLite's own time on the worker, without the trip there and back. */
  readonly ms: number;
}

/** Test-process-only instrumentation: told of every statement any writer worker runs. */
export const statementObservers = new Set<(statement: ObservedStatement) => void>();

/** The native error, rebuilt with the fields `classifySqliteError` reads. */
const sqlError = (error: WorkerError, message: string, operation: string) =>
  new SqlError({
    reason: classifySqliteError(
      Object.assign(new Error(error.message), {
        code: error.code,
        errcode: error.errcode,
        errstr: error.errstr,
        ...(typeof error.errcode === "number" ? { errno: error.errcode } : {}),
      }),
      { message, operation },
    ),
  });

const closedError = () =>
  new SqlError({
    reason: new ConnectionError({
      cause: undefined,
      message: "SQLite writer worker has stopped",
      operation: "execute",
    }),
  });

/** Marks a client whose worker has stopped, for `durableSqliteLayer` to replace it. */
export const writerStopped = Symbol("SQLite writer worker stopped");

/** Ends the worker as a crash would: for tests only. */
export const crashWriter = Symbol("crash SQLite writer worker");

export interface WriterClient extends SqlClient.SqlClient {
  readonly [writerStopped]: () => boolean;
  readonly [crashWriter]: () => Promise<void>;
}

/**
 * A SQL client over `filename` whose one connection lives on a worker thread, closed (and so
 * checkpointed) with its scope.
 */
export const layer = (options: {
  readonly filename: string;
}): Layer.Layer<SqlClient.SqlClient, SqlError> =>
  Layer.effect(
    SqlClient.SqlClient,
    Effect.gen(function* () {
      const spawned = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: {
          filename: options.filename,
          busyTimeoutMs: BUSY_TIMEOUT_MS,
          statementCache: STATEMENT_CACHE,
        },
      });
      // The scope stops it; an idle worker must not keep the process up.
      spawned.unref();
      let stopped = false;
      let inTransaction = false;
      let sequence = 0;
      const pending = new Map<number, (reply: Reply | undefined) => void>();
      const exited = Promise.withResolvers<void>();
      const ready = Promise.withResolvers<WorkerError | undefined>();
      const stopAll = () => {
        stopped = true;
        ready.resolve({ message: "SQLite writer worker exited before it was ready" });
        for (const settle of pending.values()) settle(undefined);
        pending.clear();
      };
      spawned.on("message", (reply: Reply) => {
        if (reply.kind === "ready") return ready.resolve(undefined);
        if (reply.kind === "failed") return ready.resolve(reply.error);
        inTransaction = reply.inTx;
        const settle = pending.get(reply.id);
        pending.delete(reply.id);
        settle?.(reply);
      });
      spawned.on("error", stopAll);
      spawned.on("exit", () => {
        stopAll();
        exited.resolve();
      });

      let stopping: Promise<void> | undefined;
      /** Lets the running statement finish, closes the connection and ends the thread, once. */
      const stop = () =>
        (stopping ??= (async () => {
          if (!stopped) {
            // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node worker_threads has no origin argument.
            spawned.postMessage("stop");
          }
          const timer = setTimeout(() => void spawned.terminate(), STOP_TIMEOUT_MS);
          await exited.promise;
          clearTimeout(timer);
        })());
      // Before the wait for ready: a build interrupted while the worker opens still ends it.
      yield* Effect.addFinalizer(() => Effect.promise(stop));
      const failed = yield* Effect.promise(() => ready.promise);
      if (failed !== undefined) {
        void spawned.terminate();
        return yield* Effect.fail(sqlError(failed, "Failed to open database", "connect"));
      }

      /** One message to the worker and its answer, waited for even when interrupted. */
      const send = (
        message: Record<string, unknown>,
        sql: string,
        params: ReadonlyArray<unknown>,
      ) =>
        Effect.uninterruptible(
          Effect.callback<unknown, SqlError>((resume) => {
            if (stopped) return resume(Effect.fail(closedError()));
            const id = sequence++;
            pending.set(id, (reply) => {
              if (reply === undefined) return resume(Effect.fail(closedError()));
              if (reply.kind === "ok" || reply.kind === "error") {
                for (const observe of statementObservers) observe({ sql, params, ms: reply.ms });
              }
              if (reply.kind === "ok") return resume(Effect.succeed(reply.result));
              if (reply.kind === "error")
                return resume(
                  Effect.fail(
                    reply.error.prepare === true
                      ? sqlError(reply.error, "Failed to prepare statement", "prepare")
                      : sqlError(reply.error, "Failed to execute statement", "execute"),
                  ),
                );
            });
            // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node worker_threads has no origin argument.
            spawned.postMessage({ ...message, id });
          }),
        );
      const run = (sql: string, params: ReadonlyArray<unknown>, mode: Mode, prepared: boolean) =>
        Effect.withFiber((fiber) =>
          send(
            {
              sql,
              params,
              mode,
              prepared,
              safeIntegers: Context.get(fiber.context, SqlClient.SafeIntegers),
            },
            sql,
            params,
          ),
        );

      const crash = async () => {
        await spawned.terminate();
        await exited.promise;
      };
      const connection: SqlConnection & {
        readonly isTransaction: () => boolean;
        readonly [crashWriter]: () => Promise<void>;
      } = {
        isTransaction: () => inTransaction,
        [crashWriter]: crash,
        execute: (sql, params, transformRows) =>
          run(sql, params, "rows", true).pipe(
            Effect.map((rows) => {
              const array = rows as ReadonlyArray<object>;
              return transformRows === undefined ? array : transformRows(array);
            }),
          ),
        executeRaw: (sql, params) => run(sql, params, "raw", true),
        executeValues: (sql, params) =>
          run(sql, params, "values", true) as Effect.Effect<
            ReadonlyArray<ReadonlyArray<unknown>>,
            SqlError
          >,
        executeValuesUnprepared: (sql, params) =>
          run(sql, params, "values", false) as Effect.Effect<
            ReadonlyArray<ReadonlyArray<unknown>>,
            SqlError
          >,
        executeUnprepared: (sql, params, transformRows) =>
          run(sql, params ?? [], "rows", false).pipe(
            Effect.map((rows) => {
              const array = rows as ReadonlyArray<object>;
              return transformRows === undefined ? array : transformRows(array);
            }),
          ),
        executeStream: () => Stream.die("executeStream not implemented"),
      };
      const { acquirer, borrower, onCommitFailure, transactionAcquirer } =
        SqlClient.makeSqliteAcquirers({
          connection: Effect.succeed(connection),
          semaphore: yield* Semaphore.make(1),
          isTransaction: (conn) => conn.isTransaction(),
        });
      const client = yield* SqlClient.make({
        // Gram's own client over the writer worker's connection.
        driver: "gram-writer-worker",
        acquirer,
        borrower,
        compiler: SqlStatement.makeCompilerSqlite(),
        transactionAcquirer,
        onCommitFailure,
        releaseSavepoint: (name) => `RELEASE SAVEPOINT ${name}`,
        beginTransaction: "BEGIN IMMEDIATE",
        spanAttributes: [["db.system.name", "sqlite"]],
      });
      return Object.assign(client, {
        [writerStopped]: () => stopped,
        [crashWriter]: crash,
      }) satisfies WriterClient;
    }),
  ).pipe(Layer.provide(Reactivity.layer));
