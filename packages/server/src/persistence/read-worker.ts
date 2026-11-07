/**
 * Long read-only queries on a second, read-only connection on a worker thread, so a global search
 * or a usage overview never holds the event loop while SQLite works. `node:sqlite` is synchronous:
 * on the main connection, a search over a large history took 200–300 ms, and every socket, stream
 * and timer of the server waited for it.
 *
 * Only reads that can tolerate a snapshot go here: WAL gives the worker every transaction committed
 * before its statement starts, never one in progress, so a read sees what an ordinary read on the
 * main connection between two commits would. Nothing here writes: the connection is opened
 * read-only and `query_only`.
 *
 * The server's own database file only (`ThreadStore.layerSqlite` with `checkpointOffLoop`). Without
 * the layer (tests, `:memory:`), or once the worker fails, {@link readOffLoop} runs the statement on
 * the main connection, as before this module.
 *
 * The worker is plain JavaScript in a string, so a bundler has nothing to resolve or rewrite in it.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Worker } from "node:worker_threads";
import { UnknownError } from "effect/sql/SqlError";
import { SqlClient, SqlError } from "../platform/unstable.ts";

/** How long the worker's statement waits on a lock (a checkpoint's) before it fails. */
const BUSY_TIMEOUT_MS = 1_000;

/** How many prepared statements the worker keeps; the callers' SQL texts are a handful. */
const STATEMENT_CACHE = 32;

/** How long shutdown waits for the worker to close its connection before terminating it. */
const STOP_TIMEOUT_MS = 2_000;

const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const message = (e) => (e instanceof Error ? e.message : String(e));
let db;
try {
  db = new DatabaseSync(workerData.filename, { readOnly: true });
  db.exec("PRAGMA busy_timeout = " + workerData.busyTimeoutMs);
  db.exec("PRAGMA query_only = 1");
  parentPort.postMessage({ kind: "ready" });
} catch (e) {
  parentPort.postMessage({ kind: "failed", message: message(e) });
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
  try {
    const rows = prepared(m.sql).all(...m.params);
    parentPort.postMessage({ kind: "rows", id: m.id, rows });
  } catch (e) {
    parentPort.postMessage({ kind: "error", id: m.id, message: message(e) });
  }
});
`;

type Reply =
  | { readonly kind: "ready" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "rows"; readonly id: number; readonly rows: ReadonlyArray<unknown> }
  | { readonly kind: "error"; readonly id: number; readonly message: string };

interface ReadWorkerShape {
  /** The rows of `sql` with `params`, read on the worker; undefined when the worker can't. */
  readonly all: (
    sql: string,
    params: ReadonlyArray<unknown>,
  ) => Effect.Effect<Option.Option<ReadonlyArray<unknown>>, SqlError>;
}

export class ReadWorker extends Context.Service<ReadWorker, ReadWorkerShape>()(
  "@gram/server/ReadWorker",
) {}

/** A read worker over `filename`, stopped with its scope. */
export const layer = (filename: string): Layer.Layer<ReadWorker> =>
  Layer.effect(
    ReadWorker,
    Effect.gen(function* () {
      let usable = true;
      let sequence = 0;
      const pending = new Map<
        number,
        (reply: Exclude<Reply, { readonly kind: "ready" | "failed" }> | undefined) => void
      >();
      const settleAll = () => {
        usable = false;
        for (const resolve of pending.values()) resolve(undefined);
        pending.clear();
      };
      const worker = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const spawned = new Worker(WORKER_SOURCE, {
            eval: true,
            workerData: {
              filename,
              busyTimeoutMs: BUSY_TIMEOUT_MS,
              statementCache: STATEMENT_CACHE,
            },
          });
          // A read worker never keeps the server alive.
          spawned.unref();
          return spawned;
        }),
        (spawned) =>
          Effect.promise(async () => {
            settleAll();
            const exited = new Promise<void>((done) => spawned.once("exit", () => done()));
            // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node worker_threads has no origin argument.
            spawned.postMessage("stop");
            const timer = setTimeout(() => void spawned.terminate(), STOP_TIMEOUT_MS);
            await exited;
            clearTimeout(timer);
          }),
      );
      worker.on("message", (reply: Reply) => {
        if (reply.kind === "failed") return settleAll();
        if (reply.kind === "ready") return;
        const resolve = pending.get(reply.id);
        pending.delete(reply.id);
        resolve?.(reply);
      });
      worker.on("error", settleAll);
      worker.on("exit", settleAll);
      return ReadWorker.of({
        all: (sql, params) =>
          Effect.callback<Option.Option<ReadonlyArray<unknown>>, SqlError>((resume) => {
            if (!usable) return resume(Effect.succeed(Option.none()));
            const id = sequence++;
            pending.set(id, (reply) => {
              if (reply === undefined) resume(Effect.succeed(Option.none()));
              else if (reply.kind === "rows") resume(Effect.succeed(Option.some(reply.rows)));
              else
                resume(
                  Effect.fail(
                    new SqlError({
                      reason: new UnknownError({
                        cause: undefined,
                        message: reply.message,
                        operation: "read worker",
                      }),
                    }),
                  ),
                );
            });
            // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node worker_threads has no origin argument.
            worker.postMessage({ id, sql, params });
            // An interrupted read lets its answer go; the worker finishes the statement anyway.
            return Effect.sync(() => {
              pending.delete(id);
            });
          }),
      });
    }),
  );

/**
 * `sql` with `params`, read on the worker when there is one and it is working, else on the main
 * connection. For read-only statements only.
 */
export const readOffLoop = <A extends object>(
  sql: string,
  params: ReadonlyArray<unknown>,
): Effect.Effect<ReadonlyArray<A>, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const worker = yield* Effect.serviceOption(ReadWorker);
    if (Option.isSome(worker)) {
      const rows = yield* worker.value.all(sql, params);
      if (Option.isSome(rows)) return rows.value as ReadonlyArray<A>;
    }
    const client = yield* SqlClient.SqlClient;
    return yield* client.unsafe<A>(sql, params as Array<never>);
  });

/** The read worker in the context building a service, to hand to the reads it runs later. */
export const captureReadWorker = Effect.serviceOption(ReadWorker);

/** `effect` with `worker`, when there is one, for its {@link readOffLoop} reads. */
export const withReadWorker =
  (worker: Option.Option<ReadWorkerShape>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, Exclude<R, ReadWorker>> =>
    Option.isSome(worker)
      ? Effect.provideService(effect, ReadWorker, worker.value)
      : (effect as Effect.Effect<A, E, Exclude<R, ReadWorker>>);
