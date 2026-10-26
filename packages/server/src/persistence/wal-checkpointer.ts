/**
 * Checkpoints the database's WAL on a worker thread, so the fsyncs a checkpoint makes never block
 * the event loop. This module is the only thing that changes the main connection's
 * `wal_autocheckpoint`.
 *
 * `node:sqlite` is synchronous, and SQLite's autocheckpoint runs inside the commit that crosses
 * 1000 pages: on the event loop, syncing the WAL and the database file. On a loaded disk those
 * syncs take seconds: in a cloud VM on 2026-10-07, `pnpm install` and `pnpm check` running beside
 * the server held one `statement.run` for 4.7 s and the UI lost the server. Here the main
 * connection's autocheckpoint is off and a second connection, on a worker, runs a PASSIVE
 * checkpoint every second, which never waits on or blocks the server's reads and writes. While
 * nothing is written the worker backs off, doubling the wait up to {@link MAX_IDLE_INTERVAL_MS}, so
 * an idle server isn't woken every second; the first checkpoint after a write brings it back to 1 s.
 *
 * If the worker dies, stops reporting, fails a checkpoint, or falls behind until the WAL passes
 * {@link WAL_CAP_FRAMES}, the main connection's autocheckpoint comes back on, as it was before this
 * module, and stays on until a checkpoint succeeds with the WAL short again (for good if it died).
 * The WAL is never left to grow unbounded. A worker that can't start leaves it on from the outset.
 *
 * The worker is plain JavaScript in a string, so a bundler has nothing to resolve or rewrite in it.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import { Worker } from "node:worker_threads";
import { SqlClient } from "../platform/unstable.ts";

/** How often the worker checkpoints. An idle WAL's checkpoint copies nothing and syncs nothing. */
const CHECKPOINT_INTERVAL_MS = 1_000;

/**
 * The longest the worker waits while idle: nothing committed since its last checkpoint, which
 * copied the whole WAL. Well inside {@link STALE_MS}, so an idle worker never reads as stale. A
 * write after a long idle waits this long at most for its checkpoint, far short of what fills
 * {@link WAL_CAP_FRAMES}.
 */
const MAX_IDLE_INTERVAL_MS = 8_000;

/** The WAL length, in frames (pages), past which the main connection checkpoints as well: ~40 MB. */
const WAL_CAP_FRAMES = 10_000;

/** How long the worker may go without reporting before the main connection checkpoints as well. */
const STALE_MS = 30_000;

/** How long shutdown waits for the worker's last checkpoint before terminating it. */
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

/** Overrides for tests. */
export interface CheckpointerOptions {
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
          // The scope stops it; an open interval in it must not keep the process up.
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
        // The worker is an optimisation: without one, SQLite's autocheckpoint stays on, as before.
        yield* Effect.logWarning("wal checkpointer didn't start; the server checkpoints itself");
        return;
      }
      yield* Effect.orDie(sql`PRAGMA wal_autocheckpoint = 0`);
      // Whether the main connection is checkpointing too, and whether it is for good.
      let fallback = false;
      let lost = false;
      const fallBack = (why: string, detail: Record<string, unknown>) =>
        fallback
          ? Effect.void
          : Effect.gen(function* () {
              fallback = true;
              // SQLite's own default: the main connection checkpoints as it did before this module.
              yield* sql`PRAGMA wal_autocheckpoint = 1000`;
              yield* Effect.logWarning(
                `wal checkpointer ${why}; the server checkpoints itself`,
              ).pipe(Effect.annotateLogs(detail));
            });
      const resume = (log: number) =>
        !fallback || lost
          ? Effect.void
          : Effect.gen(function* () {
              fallback = false;
              yield* sql`PRAGMA wal_autocheckpoint = 0`;
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
            // Only a successful checkpoint with a short WAL hands checkpointing back to the worker.
            return fallBack("failed to checkpoint", { error: e.message });
          case "exit":
            // Shutdown interrupts this fiber before it stops the worker, so an exit seen here is a
            // death, not a stop.
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
