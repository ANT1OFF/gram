import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { SqlClient } from "../platform/unstable.ts";
import * as WalCheckpointer from "./wal-checkpointer.ts";

const dirs: Array<string> = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const databaseFile = () => {
  const dir = mkdtempSync(join(tmpdir(), "gram-wal-"));
  dirs.push(dir);
  return join(dir, "gram.db");
};

type Seen = WalCheckpointer.CheckpointEvent | { readonly kind: "stale" };

/** The main connection with a checkpointer on `workerFile` (the same file unless a test breaks it). */
const build = (
  file: string,
  options: WalCheckpointer.CheckpointerOptions & { readonly workerFile?: string } = {},
) => {
  const seen: Array<Seen> = [];
  const layer = WalCheckpointer.layer(options.workerFile ?? file, {
    // Without the idle back-off unless a test asks for it: these follow the reports closely.
    intervalMs: 20,
    maxIntervalMs: 20,
    ...options,
    onEvent: (event) => {
      seen.push(event);
      options.onEvent?.(event);
    },
  }).pipe(Layer.provideMerge(SqliteClient.layer({ filename: file })));
  return { seen, layer };
};

const autocheckpoint = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ wal_autocheckpoint: number }>`PRAGMA wal_autocheckpoint`;
  return Number(rows[0]?.wal_autocheckpoint);
});

const write = (rows: number, bytes: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, data TEXT)`;
    for (let i = 0; i < rows; i++) yield* sql`INSERT INTO t (data) VALUES (${"x".repeat(bytes)})`;
  });

/** Polls on real time, since the worker is a real thread. */
const until = <E = never, R = never>(
  label: string,
  check: () => boolean | Effect.Effect<boolean, E, R>,
): Effect.Effect<void, E, R> =>
  Effect.gen(function* () {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const result = check();
      if (typeof result === "boolean" ? result : yield* result) return;
      if (Date.now() > deadline)
        return yield* Effect.die(new Error(`timed out waiting for ${label}`));
      yield* Effect.sleep(10);
    }
  });

// A worker that reports nothing but failures, often enough never to go stale.
const failing = () =>
  new Worker(
    `const { parentPort } = require("node:worker_threads");
    const timer = setInterval(() => parentPort.postMessage({ kind: "error", message: "disk I/O error" }), 10);
    parentPort.on("message", () => { clearInterval(timer); parentPort.close(); });`,
    { eval: true },
  );

const caughtUp = (seen: ReadonlyArray<Seen>) =>
  seen.some((e) => e.kind === "checkpoint" && e.log > 0 && e.checkpointed === e.log);

type Phase = "bulk write" | "fallback" | "full checkpoint" | "short WAL" | "worker alone";

const diagnosticTail = <A>(items: Array<A>, item: A) => {
  items.push(item);
  if (items.length > 8) items.shift();
};

/** Parent delivery/check times only; observes existing reports without SQL or new waits. */
const walFailureDiagnostic = () => {
  const started = Date.now();
  let eventCount = 0;
  const elapsed = () => Date.now() - started;
  const state = {
    phase: "bulk write" as Phase,
    bulkCompleted: false,
    bulkCompletedAtMs: null as number | null,
    eventsAtBulkCompletion: null as number | null,
    recoveryWrites: 0,
    recoveryWritePending: false,
    eventsBeforeRecovery: null as number | null,
    fullPredicateAcceptedAtMs: null as number | null,
  };
  const counts = { checkpoint: 0, final: 0, error: 0, failed: 0, exit: 0, stale: 0 };
  const recoveryReports = {
    count: 0,
    minLog: null as number | null,
    maxLog: null as number | null,
    lastCheckpointed: null as number | null,
  };
  const stamp = () => ({ atMs: elapsed(), phase: state.phase, bulkCompleted: state.bulkCompleted });
  const eventSample = (event: Seen) => ({
    ...stamp(),
    index: eventCount,
    ...("message" in event ? { ...event, message: event.message.slice(0, 160) } : event),
  });
  type EventSample = ReturnType<typeof eventSample>;
  const eventTail: Array<EventSample> = [];
  const checks: Array<ReturnType<typeof stamp> & { result: boolean; autocheckpoint?: number }> = [];
  const phases: Array<ReturnType<typeof stamp>> = [stamp()];
  let firstFullCheckpoint: EventSample | null = null;
  let lastCheckpoint: EventSample | null = null;
  let lastWorkerStatus: EventSample | null = null;
  let lastAutocheckpoint: (ReturnType<typeof stamp> & { value: number }) | null = null;
  let checkCount = 0;
  return {
    state,
    phase: (phase: Phase) => {
      state.phase = phase;
      diagnosticTail(phases, stamp());
    },
    bulkCompleted: (events: number) => {
      state.bulkCompleted = true;
      state.bulkCompletedAtMs = elapsed();
      state.eventsAtBulkCompletion = events;
    },
    onEvent: (event: Seen) => {
      eventCount++;
      counts[event.kind]++;
      const sample = eventSample(event);
      diagnosticTail(eventTail, sample);
      if (event.kind === "checkpoint") {
        lastCheckpoint = sample;
        if (firstFullCheckpoint === null && event.log > 0 && event.checkpointed === event.log)
          firstFullCheckpoint = sample;
        if (state.phase === "short WAL") {
          recoveryReports.count++;
          recoveryReports.minLog = Math.min(recoveryReports.minLog ?? event.log, event.log);
          recoveryReports.maxLog = Math.max(recoveryReports.maxLog ?? event.log, event.log);
          recoveryReports.lastCheckpointed = event.checkpointed;
        }
      } else {
        lastWorkerStatus = sample;
      }
    },
    check: (result: boolean, auto?: number) => {
      checkCount++;
      const sample = stamp();
      diagnosticTail(checks, {
        ...sample,
        result,
        ...(auto === undefined ? {} : { autocheckpoint: auto }),
      });
      if (auto !== undefined) lastAutocheckpoint = { ...sample, value: auto };
      if (state.phase === "full checkpoint" && result && state.fullPredicateAcceptedAtMs === null)
        state.fullPredicateAcceptedAtMs = sample.atMs;
      return result;
    },
    render: () =>
      JSON.stringify({
        ...state,
        atMs: elapsed(),
        counts,
        checkCount,
        phases,
        firstFullCheckpoint,
        lastCheckpoint,
        lastWorkerStatus,
        // This is the last existing PRAGMA observation, not a query at failure time.
        lastAutocheckpoint,
        recoveryReports,
        eventTail,
        checkTail: checks,
      }),
  };
};

const reportWalFailure = (diagnostic: ReturnType<typeof walFailureDiagnostic>) =>
  Effect.onExit((exit) =>
    Exit.isFailure(exit)
      ? Effect.sync(() => console.error("WAL cap test failure diagnostic:", diagnostic.render()))
      : Effect.void,
  );

describe("WAL checkpointer", () => {
  it.live(
    "checkpoints the WAL on its own connection, with the main one's autocheckpoint off",
    () => {
      const { seen, layer } = build(databaseFile());
      return Effect.gen(function* () {
        expect(yield* autocheckpoint).toBe(0);
        yield* write(20, 4000);
        yield* until("a full checkpoint", () => caughtUp(seen));
        expect(yield* autocheckpoint).toBe(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("checkpoints on the main connection past the cap, and stops once it is caught up", () => {
    const diagnostic = walFailureDiagnostic();
    const { seen, layer } = build(databaseFile(), { capFrames: 40, onEvent: diagnostic.onEvent });
    return Effect.gen(function* () {
      yield* write(100, 4000);
      diagnostic.bulkCompleted(seen.length);
      diagnostic.phase("fallback");
      yield* until("the fallback", () =>
        autocheckpoint.pipe(Effect.map((n) => diagnostic.check(n === 1000, n))),
      );
      expect(seen.some((e) => e.kind === "checkpoint" && e.log > 40)).toBe(true);
      diagnostic.phase("full checkpoint");
      yield* until("a full checkpoint", () => diagnostic.check(caughtUp(seen)));
      // A full report describes the checkpoint's snapshot: writes during its sync can already
      // have extended the WAL. Writing on every poll can keep that race going indefinitely.
      // Between attempts, leave writes idle until two new full reports agree on the length.
      const before = seen.length;
      let afterWrite: number | undefined;
      let discardQueuedReports = false;
      diagnostic.state.eventsBeforeRecovery = before;
      diagnostic.phase("short WAL");
      yield* until("a short WAL", () => {
        // At the next existing poll, discard reports queued while the synchronous commit ran.
        if (discardQueuedReports) {
          afterWrite = seen.length;
          discardQueuedReports = false;
        }
        if (afterWrite !== undefined) {
          const previous = seen.at(-2);
          const latest = seen.at(-1);
          if (
            seen.length < afterWrite + 2 ||
            previous?.kind !== "checkpoint" ||
            latest?.kind !== "checkpoint" ||
            latest.log <= 0 ||
            latest.checkpointed !== latest.log ||
            previous.log !== latest.log ||
            previous.checkpointed !== latest.log
          )
            return diagnostic.check(
              seen.slice(before).some((e) => e.kind === "checkpoint" && e.log <= 20),
            );
        }
        afterWrite = seen.length;
        discardQueuedReports = true;
        diagnostic.state.recoveryWritePending = true;
        return write(1, 10).pipe(
          Effect.map(() => {
            diagnostic.state.recoveryWritePending = false;
            diagnostic.state.recoveryWrites++;
            return diagnostic.check(
              seen.slice(before).some((e) => e.kind === "checkpoint" && e.log <= 20),
            );
          }),
        );
      });
      diagnostic.phase("worker alone");
      yield* until("the worker alone", () =>
        autocheckpoint.pipe(Effect.map((n) => diagnostic.check(n === 0, n))),
      );
    }).pipe(reportWalFailure(diagnostic), Effect.provide(layer));
  });

  it.live("prints bounded checkpoint observations only on failure, preserving the failure", () =>
    Effect.gen(function* () {
      const diagnostic = walFailureDiagnostic();
      // A completed report during bulk writes can satisfy the later historical predicate.
      diagnostic.onEvent({ kind: "checkpoint", log: 43, checkpointed: 43, ms: 1 });
      diagnostic.bulkCompleted(1);
      diagnostic.phase("fallback");
      diagnostic.check(true, 1000);
      diagnostic.phase("full checkpoint");
      diagnostic.check(true);
      diagnostic.state.eventsBeforeRecovery = 1;
      diagnostic.phase("short WAL");
      for (let i = 0; i < 1000; i++) {
        diagnostic.onEvent({ kind: "checkpoint", log: 300 + i, checkpointed: 43, ms: 2 });
        diagnostic.state.recoveryWrites++;
        diagnostic.check(false);
      }
      diagnostic.onEvent({ kind: "error", message: "ordinary fixture error ".repeat(100) });
      const output = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        yield* Effect.void.pipe(reportWalFailure(diagnostic));
        expect(output).not.toHaveBeenCalled();
        const failure = new Error("timed out waiting for a short WAL");
        const exit = yield* Effect.die(failure).pipe(reportWalFailure(diagnostic), Effect.exit);
        expect(exit).toEqual(Exit.die(failure));
        expect(output).toHaveBeenCalledTimes(1);
        const rendered = output.mock.calls[0]?.[1] as string;
        expect(rendered.length).toBeLessThan(6000);
        const report = JSON.parse(rendered);
        expect(report.phase).toBe("short WAL");
        expect(report.bulkCompleted).toBe(true);
        expect(report.firstFullCheckpoint).toMatchObject({
          index: 1,
          bulkCompleted: false,
          log: 43,
        });
        expect(report.fullPredicateAcceptedAtMs).not.toBeNull();
        expect(report.eventsAtBulkCompletion).toBe(1);
        expect(report.recoveryWrites).toBe(1000);
        expect(report.recoveryWritePending).toBe(false);
        expect(report.recoveryReports).toEqual({
          count: 1000,
          minLog: 300,
          maxLog: 1299,
          lastCheckpointed: 43,
        });
        expect(report.lastCheckpoint).toMatchObject({ log: 1299, checkpointed: 43 });
        expect(report.lastWorkerStatus.kind).toBe("error");
        expect(report.lastWorkerStatus.message.length).toBe(160);
        expect(report.lastAutocheckpoint).toMatchObject({ phase: "fallback", value: 1000 });
        expect(report.counts).toMatchObject({ checkpoint: 1001, error: 1 });
        expect(report.eventTail).toHaveLength(8);
        expect(report.checkTail).toHaveLength(8);
      } finally {
        output.mockRestore();
      }
    }),
  );

  it.live("backs off while nothing is written, and checkpoints a write after it", () => {
    const { seen, layer } = build(databaseFile(), { intervalMs: 20, maxIntervalMs: 160 });
    const reports = () => seen.filter((e) => e.kind === "checkpoint").length;
    return Effect.gen(function* () {
      yield* write(1, 10);
      yield* until("the write's checkpoint", () => caughtUp(seen));
      // Idle for 1.2 s: 60 reports at 20 ms, ~11 doubling from 20 ms to 160 ms (fewer if loaded).
      const before = reports();
      yield* Effect.sleep(1_200);
      expect(reports() - before).toBeLessThanOrEqual(15);
      expect(seen.some((e) => e.kind === "stale" || e.kind === "error")).toBe(false);

      const at = seen.length;
      yield* write(5, 4000);
      yield* until("a checkpoint of the new write", () =>
        seen
          .slice(at)
          .some((e) => e.kind === "checkpoint" && e.log > 0 && e.checkpointed === e.log),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("checkpoints on the main connection when the worker stops reporting", () => {
    const { seen, layer } = build(databaseFile(), { intervalMs: 60_000, staleMs: 50 });
    return Effect.gen(function* () {
      yield* until("a stale report", () => seen.some((e) => e.kind === "stale"));
      expect(yield* autocheckpoint).toBe(1000);
      expect(seen.some((e) => e.kind === "checkpoint")).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("leaves checkpointing to the main connection for good when the worker dies", () => {
    const file = databaseFile();
    const { seen, layer } = build(file, { workerFile: join(file, "missing", "x.db") });
    return Effect.gen(function* () {
      // A failed report enables the fallback before the worker's final event, exit, arrives.
      yield* until("the worker's exit", () => seen.some((e) => e.kind === "exit"));
      yield* until("the fallback", () => autocheckpoint.pipe(Effect.map((n) => n === 1000)));
      expect(seen.map((e) => e.kind)).toEqual(["failed", "exit"]);
      // A short WAL doesn't bring the worker back: it is gone.
      yield* write(1, 10);
      expect(yield* autocheckpoint).toBe(1000);
    }).pipe(Effect.provide(layer));
  });

  it.live("preserves Error and non-Error worker failures before falling back", () =>
    Effect.gen(function* () {
      for (const thrown of [
        "new Error('checkpoint worker failed')",
        "'checkpoint worker failed'",
      ]) {
        const { seen, layer } = build(databaseFile(), {
          spawn: () => new Worker(`throw ${thrown};`, { eval: true }),
        });
        yield* Effect.gen(function* () {
          yield* until("the worker's exit", () => seen.some((e) => e.kind === "exit"));
          yield* until("the fallback", () => autocheckpoint.pipe(Effect.map((n) => n === 1000)));
          expect(seen).toContainEqual({ kind: "error", message: "checkpoint worker failed" });
          yield* write(1, 10);
        }).pipe(Effect.provide(layer));
      }
    }),
  );

  it.live("checkpoints on the main connection while the worker's checkpoints fail", () => {
    const { seen, layer } = build(databaseFile(), { staleMs: 60_000, spawn: failing });
    return Effect.gen(function* () {
      yield* until("the fallback", () => autocheckpoint.pipe(Effect.map((n) => n === 1000)));
      expect(seen.some((e) => e.kind === "error")).toBe(true);
      expect(seen.some((e) => e.kind === "stale")).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("leaves SQLite's autocheckpoint on and the database usable when no worker starts", () => {
    const { seen, layer } = build(databaseFile(), {
      spawn: () => {
        throw new Error("ERR_WORKER_INIT_FAILED");
      },
    });
    return Effect.gen(function* () {
      expect(yield* autocheckpoint).toBe(1000);
      yield* write(5, 100);
      expect(seen).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.live("runs a last checkpoint and stops the worker before the main connection closes", () =>
    Effect.gen(function* () {
      const file = databaseFile();
      const { seen, layer } = build(file, { intervalMs: 60_000 });
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(layer, scope);
      yield* write(20, 4000).pipe(Effect.provide(context));
      expect(existsSync(`${file}-wal`)).toBe(true);
      yield* Scope.close(scope, Exit.void);
      const final = seen.find((e) => e.kind === "final");
      expect(
        final !== undefined && final.kind === "final" && final.checkpointed === final.log,
      ).toBe(true);
      expect(seen.at(-1)).toEqual({ kind: "exit", code: 0 });
      // SQLite removes the WAL only when its last connection closes, so the worker's was first.
      expect(existsSync(`${file}-wal`)).toBe(false);
    }),
  );
});
