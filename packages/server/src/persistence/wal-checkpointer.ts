import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import { Worker } from "node:worker_threads";
import { SqlClient, type SqlError } from "../platform/unstable.ts";

const CHECKPOINT_INTERVAL_MS = 1_000;

const MAX_IDLE_INTERVAL_MS = 8_000;

const WAL_CAP_FRAMES = 10_000;

const STALE_MS = 30_000;

const STOP_TIMEOUT_MS = 5_000;

const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const message = (e) => (e instanceof Error ? e.message : String(e));
let db;
try {
  db = new DatabaseSync(workerData.filename);
  db.exec("PRAGMA busy_timeout = 1000");
} catch (e) {
  parentPort.postMessage({ kind: "failed", message: message(e) });
  process.exit(1);
}
const statement = db.prepare("PRAGMA wal_checkpoint(PASSIVE)");
// Moves when another connection commits; this one's checkpoints don't move it.
const dataVersion = db.prepare("PRAGMA data_version");
const checkpoint = (kind) => {
  const started = performance.now();
  try {
    const row = statement.get();
    const log = Number(row.log);
    const checkpointed = Number(row.checkpointed);
    parentPort.postMessage({ kind, log, checkpointed, ms: performance.now() - started });
    return log === checkpointed;
  } catch (e) {
    parentPort.postMessage({ kind: "error", message: message(e) });
    return false;
  }
};
let delay = workerData.intervalMs;
let version;
let timer;
const tick = () => {
  let seen;
  try {
    seen = Number(dataVersion.get().data_version);
  } catch {
    seen = undefined;
  }
  const done = checkpoint("checkpoint");
  const idle = done && seen !== undefined && seen === version;
  version = seen;
  delay = idle ? Math.min(delay * 2, workerData.maxIntervalMs) : workerData.intervalMs;
  timer = setTimeout(tick, delay);
};
timer = setTimeout(tick, delay);
parentPort.on("message", (m) => {
  if (m !== "stop") return;
  clearTimeout(timer);
  checkpoint("final");
  try {
    db.close();
  } catch {
    // The thread ends either way, and the main connection's close checkpoints after it.
  }
  parentPort.close();
});
`;

const spawn = (filename: string, intervalMs: number, maxIntervalMs: number): Worker =>
  new Worker(WORKER_SOURCE, { eval: true, workerData: { filename, intervalMs, maxIntervalMs } });

/** What the worker reports: a checkpoint (`final` is the one at shutdown), or why it couldn't. */
export type CheckpointEvent =
  | {
      readonly kind: "checkpoint" | "final";
      readonly log: number;
      readonly checkpointed: number;
      readonly ms: number;
    }
  | { readonly kind: "error" | "failed"; readonly message: string }
  | { readonly kind: "exit"; readonly code: number };

/** The controller's mode, replayed before each replacement connection is published. */
export interface ConnectionPolicy {
  apply(sql: SqlClient.SqlClient): Effect.Effect<void, SqlError>;
  update(sql: SqlClient.SqlClient, frames: 0 | 1000): Effect.Effect<void, SqlError>;
}

/** One target per store scope; applying it is serialized with the same borrower gate. */
export const makeConnectionPolicy = (): ConnectionPolicy => {
  let frames: 0 | 1000 = 1000;
  return {
    apply: (sql) =>
      Effect.suspend(() => sql.unsafe(`PRAGMA wal_autocheckpoint = ${frames}`).pipe(Effect.asVoid)),
    update: (sql, next) =>
      Effect.scoped(
        Effect.uninterruptible(
          Effect.gen(function* () {
            frames = next;
            const connection = yield* sql.reserve;
            yield* connection.executeUnprepared(
              `PRAGMA wal_autocheckpoint = ${frames}`,
              [],
              undefined,
            );
          }),
        ),
      ),
  };
};

/** Controller wiring and overrides for tests. */
export interface CheckpointerOptions {
  readonly connectionPolicy?: ConnectionPolicy | undefined;
  readonly intervalMs?: number | undefined;
  /** The longest wait while idle; at or below `intervalMs`, the worker never backs off. */
  readonly maxIntervalMs?: number | undefined;
  readonly capFrames?: number | undefined;
  readonly staleMs?: number | undefined;
  /** Starts the worker in place of `new Worker`. */
  readonly spawn?:
    | ((filename: string, intervalMs: number, maxIntervalMs: number) => Worker)
    | undefined;
  /** Sees each event as the worker sends it, and `stale` once the checkpointer has acted on one. */
  readonly onEvent?: ((event: CheckpointEvent | { readonly kind: "stale" }) => void) | undefined;
}

/**
 * Checkpoints `filename`'s WAL on a worker while the layer's scope is open, with the main
 * connection checkpointing only as the fallback above. Closing the scope runs a last checkpoint
 * and stops the worker, before the main connection closes.
 */
export const layer = (
  filename: string,
  options: CheckpointerOptions = {},
): Layer.Layer<never, never, SqlClient.SqlClient> =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const policy = options.connectionPolicy ?? makeConnectionPolicy();
      const capFrames = options.capFrames ?? WAL_CAP_FRAMES;
      const events = yield* Queue.unbounded<CheckpointEvent>();
      const emit = (event: CheckpointEvent) => {
        Queue.offerUnsafe(events, event);
        options.onEvent?.(event);
      };

      const exited = Promise.withResolvers<void>();
      const started = yield* Effect.acquireRelease(
        Effect.try(() => {
          const intervalMs = options.intervalMs ?? CHECKPOINT_INTERVAL_MS;
          const w = (options.spawn ?? spawn)(
            filename,
            intervalMs,
            Math.max(intervalMs, options.maxIntervalMs ?? MAX_IDLE_INTERVAL_MS),
          );
          w.unref();
          w.on("message", emit);
          w.on("error", (e) =>
            emit({ kind: "error", message: e instanceof Error ? e.message : String(e) }),
          );
          w.on("exit", (code) => {
            emit({ kind: "exit", code });
            exited.resolve();
          });
          return w;
        }).pipe(Effect.option),
        (option) =>
          Effect.gen(function* () {
            if (Option.isNone(option)) return;
            const w = option.value;
            // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a Worker, not a window
            w.postMessage("stop");
            const stopped = yield* Effect.promise(() => exited.promise).pipe(
              Effect.timeoutOption(STOP_TIMEOUT_MS),
            );
            if (Option.isNone(stopped)) {
              yield* Effect.logWarning("wal checkpointer didn't stop; terminating it");
              yield* Effect.promise(() => w.terminate());
            }
          }),
      );

      if (Option.isNone(started)) {
        yield* Effect.orDie(policy.update(sql, 1000));
        yield* Effect.logWarning("wal checkpointer didn't start; the server checkpoints itself");
        return;
      }
      yield* Effect.orDie(policy.update(sql, 0));
      let fallback = false;
      let lost = false;
      const fallBack = (why: string, detail: Record<string, unknown>) =>
        fallback
          ? Effect.void
          : Effect.gen(function* () {
              fallback = true;
              yield* policy.update(sql, 1000);
              yield* Effect.logWarning(
                `wal checkpointer ${why}; the server checkpoints itself`,
              ).pipe(Effect.annotateLogs(detail));
            });
      const resume = (log: number) =>
        !fallback || lost
          ? Effect.void
          : Effect.gen(function* () {
              fallback = false;
              yield* policy.update(sql, 0);
              yield* Effect.logInfo("wal checkpointer caught up").pipe(
                Effect.annotateLogs({ log }),
              );
            });

      const handle = (event: Option.Option<CheckpointEvent>) => {
        if (Option.isNone(event))
          return fallBack("stopped reporting", { staleMs: options.staleMs ?? STALE_MS });
        const e = event.value;
        switch (e.kind) {
          case "checkpoint":
          case "final":
            if (e.log > capFrames) return fallBack("fell behind", { log: e.log, capFrames });
            return e.log <= capFrames / 2 ? resume(e.log) : Effect.void;
          case "error":
          case "failed":
            return fallBack("failed to checkpoint", { error: e.message });
          case "exit":
            lost = true;
            return fallBack("exited", { code: e.code });
        }
      };
      yield* Queue.take(events).pipe(
        Effect.timeoutOption(options.staleMs ?? STALE_MS),
        Effect.tap((event) =>
          handle(event).pipe(
            Effect.ignore,
            Effect.andThen(
              Effect.sync(() => {
                if (Option.isNone(event)) options.onEvent?.({ kind: "stale" });
              }),
            ),
          ),
        ),
        Effect.forever,
        Effect.forkScoped,
      );
    }),
  );
