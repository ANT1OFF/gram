import { describe, expect, it } from "@effect/vitest";
import type { MessageId, ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { copyFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { cpus, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { Orchestration } from "../orchestration/service.ts";
import { digestDiff } from "../orchestration/rules.ts";
import { compactWorkerRow } from "../orchestration/ledger.ts";
import { decodeOutbox } from "../orchestration/outbox.ts";
import { makeWorld, prBadge, serverLayer, waitReal } from "../orchestration/test-harness.ts";
import { findUserMessages, ThreadStore } from "../persistence/thread-store.ts";
import * as ReadWorker from "../persistence/read-worker.ts";
import * as WalCheckpointer from "../persistence/wal-checkpointer.ts";
import { SqlClient } from "../platform/unstable.ts";
import { FakeAgentControl } from "../runtime/fake-agent.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { searchThreads } from "../search/search.ts";
import {
  FIXTURE,
  FIXTURE_NOW,
  seedSqliteFixture,
  SMOKE,
  threadId,
  workspaceId,
} from "./sqlite-fixture.ts";
import { sqliteProbe } from "./sqlite-probe.ts";

const PERF = process.env["GRAM_PERF_SQLITE"] === "1";
const SCOPES = process.env["GRAM_PERF_SQLITE_SCOPES"] === "1";
/** As the server runs: the main connection on its writer worker. `0` measures it on the loop. */
const WRITER_OFF_LOOP = process.env["GRAM_PERF_SQLITE_WRITER"] !== "0";
const OUT = process.env["GRAM_PERF_SQLITE_OUT"] ?? join(tmpdir(), "gram-perf-sqlite.json");
const walBytes = (file: string) => (existsSync(`${file}-wal`) ? statSync(`${file}-wal`).size : 0);

describe.skipIf(!PERF)("synthetic large SQLite workload", () => {
  it.live(
    "five serial repeats with three streaming turns",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const database = join(world.dir, "gram.db");
        const seedStart = performance.now();
        yield* seedSqliteFixture(world.dir).pipe(Effect.provide(ThreadStore.layerSqlite(database)));
        const fixtureMs = performance.now() - seedStart;
        for (let i = 0; i < FIXTURE.threads; i++) {
          if (i % 30 !== 0)
            world.prBadges.set(
              `synthetic/perf#${i + 1}`,
              prBadge({
                number: i + 1,
                url: `https://github.com/synthetic/perf/pull/${i + 1}`,
              }),
            );
        }
        const baseline = join(world.dir, "baseline.db");
        copyFileSync(database, baseline);
        const databaseBytes = statSync(baseline).size;
        const probe = sqliteProbe();
        yield* Effect.addFinalizer(() => Effect.sync(probe.restore));
        const runs: unknown[] = [];
        for (let run = 0; run < 5; run++) {
          // Closing the previous layer has closed every connection, so this is a clean file reset.
          copyFileSync(baseline, database);
          const load = loadavg();
          const bootStart = performance.now();
          yield* Effect.scoped(
            Effect.gen(function* () {
              const context = yield* Layer.build(
                serverLayer(world, {}, undefined, { writerOffLoop: WRITER_OFF_LOOP }),
              );
              yield* Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;
                const store = yield* ThreadStore;
                const runtimes = yield* ThreadRuntimes;
                const control = yield* FakeAgentControl;
                const orchestration = yield* Orchestration;
                const checkpoints: WalCheckpointer.CheckpointEvent[] = [];
                yield* Layer.build(
                  WalCheckpointer.layer(database, {
                    onEvent: (event) => {
                      if (event.kind !== "stale") checkpoints.push(event);
                    },
                  }),
                );
                // The real orchestration fixture's services are ready; HTTP/import/provider startup is excluded.
                const bootMs = performance.now() - bootStart;
                expect((yield* store.listThreads).length).toBe(FIXTURE.threads);
                expect((yield* store.getMessage(threadId(0), "message-1"))?.role).toBe("assistant");
                const streaming: ThreadId[] = [];
                for (let i = 0; i < 3; i++) {
                  const thread = yield* runtimes.create({
                    projectRoot: world.repo,
                    checkout: { kind: "main", path: world.repo },
                  });
                  yield* waitReal(
                    "synthetic idle",
                    runtimes.status(thread.id).pipe(Effect.map((s) => s === "idle")),
                  );
                  yield* runtimes.send(thread.id, { text: "Synthetic performance turn" });
                  streaming.push(thread.id);
                }
                // Let boot and creation settle before recording writes per chunk.
                yield* Effect.sleep("100 millis");
                const loop = monitorEventLoopDelay({ resolution: 1 });
                loop.enable();
                yield* Effect.addFinalizer(() => Effect.sync(() => loop.disable()));
                let emitted = 0;
                const beforeWal = walBytes(database);
                const [beforeChanges] = yield* sql<{ n: number }>`SELECT total_changes() AS n`;
                let peakWal = beforeWal;
                probe.start();
                const streams = yield* Effect.forEach(streaming, (id) =>
                  Effect.gen(function* () {
                    const session = yield* control.latest(id);
                    const messageId = `synthetic-live-${id}` as MessageId;
                    yield* session.emit(
                      { type: "chunk", messageId, chunk: { type: "start", messageId } },
                      { type: "chunk", messageId, chunk: { type: "text-start", id: "text" } },
                    );
                    emitted += 2;
                    for (let tick = 0; tick < 100; tick++) {
                      yield* Effect.sleep("20 millis");
                      yield* session.emit({
                        type: "chunk",
                        messageId,
                        chunk: { type: "text-delta", id: "text", delta: "synthetic stream " },
                      });
                      emitted++;
                    }
                    yield* session.emit(
                      { type: "chunk", messageId, chunk: { type: "text-end", id: "text" } },
                      { type: "chunk", messageId, chunk: { type: "finish" } },
                      { type: "turnEnd", reason: "completed" },
                      { type: "status", status: "idle" },
                    );
                    emitted += 2;
                  }).pipe(Effect.forkScoped),
                );
                const metrics: Record<string, number[]> = {};
                const measure = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>) =>
                  Effect.gen(function* () {
                    const start = performance.now();
                    const value = yield* effect;
                    (metrics[name] ??= []).push(performance.now() - start);
                    peakWal = Math.max(peakWal, walBytes(database));
                    return value;
                  });
                // One pass per run: five independent services/file resets, not five samples from one scope.
                yield* measure(
                  "feedResume",
                  store.messagesSince(threadId(0), FIXTURE.messages / 2 - 10, 100),
                );
                yield* measure("feedWindow", store.recentMessages(threadId(0), 20));
                yield* store.listThreads;
                yield* measure("threadListWarm", store.listThreads);
                yield* store.updateThread(threadId(1), (t) => ({ ...t, unread: !t.unread }));
                yield* measure("threadListInvalidated", store.listThreads);
                const ledger = yield* measure("ledger", orchestration.ledger(workspaceId(0)));
                expect(ledger.features.flatMap((f) => f.workers)).toHaveLength(29);
                yield* measure(
                  "listWorkersFormat",
                  Effect.sync(() =>
                    JSON.stringify(
                      ledger.features.map((f) => ({
                        ...f,
                        workers: f.workers.map(compactWorkerRow),
                      })),
                    ),
                  ),
                );
                // Digest's production input reads and diff; excludes memory I/O, claim and delivery.
                yield* measure(
                  "digestInputsAndDiff",
                  Effect.gen(function* () {
                    const current = yield* orchestration.ledger(workspaceId(0));
                    const outbox = decodeOutbox(yield* store.getOutbox(workspaceId(0)));
                    const reports = yield* store.listWorkerReports(
                      workspaceId(0),
                      outbox.ackedReportSeq,
                    );
                    return JSON.stringify(
                      digestDiff({
                        ledger: current,
                        snapshot: outbox.snapshot,
                        reports: reports.map((r) => r.report),
                        now: FIXTURE_NOW,
                      }),
                    );
                  }),
                );
                yield* measure("searchCommon", searchThreads({ query: "synthetic", limit: 50 }));
                yield* measure(
                  "searchScoped",
                  searchThreads({ query: "needle", threadId: threadId(0), limit: 50 }),
                );
                // The same searches on the read worker, with how long the event loop stood still
                // during each call against the same call on the main connection.
                const stalled = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>) =>
                  Effect.gen(function* () {
                    const lag = monitorEventLoopDelay({ resolution: 1 });
                    lag.enable();
                    // Its timer starts on the loop's next turn; a block before that goes unseen.
                    yield* Effect.sleep("5 millis");
                    const value = yield* measure(name, effect);
                    // The histogram records a delay once the loop runs again after it.
                    yield* Effect.sleep("20 millis");
                    lag.disable();
                    (metrics[`${name}LoopMax`] ??= []).push(lag.max / 1e6);
                    return value;
                  });
                const readWorker = yield* Layer.build(ReadWorker.layer(database));
                const common = { query: "synthetic", limit: 50 };
                const onLoop = yield* stalled("searchCommonOnLoop", searchThreads(common));
                const offLoop = yield* stalled(
                  "searchCommonOffLoop",
                  searchThreads(common).pipe(Effect.provide(readWorker)),
                );
                expect(offLoop).toEqual(onLoop);
                if (SCOPES) {
                  yield* measure(
                    "searchWorkerScoped",
                    searchThreads({ query: "needle", threadId: threadId(1), limit: 50 }),
                  );
                }
                yield* measure(
                  "usageOneDay",
                  store.usageOverview(
                    { days: 1 },
                    { records: [], sources: [], ambiguous: 0, to: FIXTURE_NOW },
                  ),
                );
                yield* measure("orchestratorFullHistory", store.listMessages(threadId(0)));
                // What an attachment read, an orchestrator's send check and `get_thread` read of it.
                yield* measure(
                  "orchestratorAttachmentParts",
                  store.messagesWithParts(threadId(0), ["file", "data-tool-image"]),
                );
                // What an attachment of the user's latest message and the send guard read of it.
                yield* measure(
                  "orchestratorUserMessages",
                  findUserMessages(store, threadId(0), { from: "newest", count: 5 }),
                );
                yield* measure("orchestratorLastTen", store.lastMessages(threadId(0), 10));
                // What the title watcher reads of a thread on each of its turn's status moments.
                yield* measure("titleOpening", store.firstMessages(threadId(0), 64));
                for (const stream of streams) yield* Fiber.join(stream);
                yield* waitReal(
                  "all synthetic turns idle",
                  Effect.forEach(streaming, (id) => runtimes.status(id)).pipe(
                    Effect.map((states) => states.every((state) => state === "idle")),
                  ),
                );
                yield* Effect.sleep("50 millis");
                const trace = probe.stop();
                expect(trace.summary.messageUpserts).toBeGreaterThan(0);
                loop.disable();
                const plans: Record<string, unknown> = {};
                const diagnostic = new DatabaseSync(database, { readOnly: true });
                try {
                  for (const { sql: query, bindings } of trace.calls.filter((call) =>
                    /^\s*(SELECT|WITH)/i.test(call.sql),
                  )) {
                    if (plans[query] === undefined)
                      plans[query] = diagnostic
                        .prepare(`EXPLAIN QUERY PLAN ${query}`)
                        .all(...bindings);
                  }
                } finally {
                  diagnostic.close();
                }
                const [changes] = yield* sql<{ n: number }>`SELECT total_changes() AS n`;
                const result = {
                  run: run + 1,
                  load,
                  bootMs,
                  metrics,
                  emittedChunks: emitted,
                  lagMs: {
                    p50: loop.percentile(50) / 1e6,
                    p99: loop.percentile(99) / 1e6,
                    max: loop.max / 1e6,
                  },
                  wal: {
                    beforeBytes: beforeWal,
                    peakSampledBytes: peakWal,
                    afterBytes: walBytes(database),
                    checkpoints,
                  },
                  changedRowsIncludingTriggers:
                    Number(changes?.n ?? 0) - Number(beforeChanges?.n ?? 0),
                  messageUpsertsPerChunk: trace.summary.messageUpserts / emitted,
                  trace: trace.summary,
                  plans,
                };
                runs.push(result);
                console.log(
                  `SQLite repeat ${run + 1}: ${JSON.stringify({ bootMs, metrics, lagMs: result.lagMs })}`,
                );
              }).pipe(Effect.provide(context));
            }),
          );
        }
        writeFileSync(
          OUT,
          `${JSON.stringify(
            {
              fixture: FIXTURE,
              writerOffLoop: WRITER_OFF_LOOP,
              smoke: SMOKE,
              scopeProbe: SCOPES,
              fixtureMs,
              databaseBytes,
              node: process.version,
              cpus: cpus().length,
              runs,
            },
            null,
            2,
          )}\n`,
        );
        console.log(`Synthetic SQLite results: ${OUT}`);
      }),
    600_000,
  );
});
