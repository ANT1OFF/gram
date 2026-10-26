import { describe, expect, it } from "@effect/vitest";
import type {
  AgentEvent,
  Checkout,
  MessageId,
  GramUIMessage,
  GramUIMessageChunk,
  ThreadId,
  TurnId,
} from "@gram/contracts";
import { FEED_WINDOW_TURNS } from "@gram/contracts";
import { longTranscript } from "@gram/contracts/testing";
import { Proc, ProcLive } from "@gram/git";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { AppToolRegistry } from "../app-tools/registry.ts";
import { ServerConfig } from "../config.ts";
import { EventHub } from "../events/event-hub.ts";
import { gitPlatformTest } from "../git/platform.ts";
import { GitTurnHooksLive } from "../git/turn-hooks.ts";
import { LaunchToken, serverPort, ServerLayer } from "../http/server.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { HttpServer, SqlClient } from "../platform/unstable.ts";
import { FakeAgentAdapter, FakeAgentControl } from "../runtime/fake-agent.ts";
import { CheckoutService, TurnHooks } from "../runtime/hooks.ts";
import { TEST_CONFIG, waitFor } from "../runtime/test-harness.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";

// Long threads on the server: storage, FTS indexing, replay to a late subscriber and
// memory, over a file database and the fake agent, with no model. Opt in with GRAM_PERF_TRANSCRIPTS=1;
// `GRAM_PERF_OUT` names the results file.
const PERF = process.env["GRAM_PERF_TRANSCRIPTS"] === "1";
const OUT_FILE = process.env["GRAM_PERF_OUT"] ?? join(tmpdir(), "gram-perf-transcripts.md");
const TOOL_OUTPUT_BYTES = 8_000;
const MB = 1024 * 1024;

const layerFor = (databaseFile: string) =>
  AppToolRegistry.layer.pipe(
    Layer.provideMerge(ThreadRuntimes.layer),
    Layer.provideMerge(EventHub.layer),
    Layer.provideMerge(ThreadStore.layerSqlite(databaseFile)),
    Layer.provideMerge(FakeAgentAdapter),
    Layer.provideMerge(TurnHooks.layerNoop),
    Layer.provideMerge(CheckoutService.layerNoGit),
    Layer.provideMerge(ServerConfig.layer({ ...TEST_CONFIG, databaseFile })),
    Layer.orDie,
  );

const timed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const start = performance.now();
    const value = yield* effect;
    return { value, ms: performance.now() - start };
  });

const memory = () => {
  globalThis.gc?.();
  const { rss, heapUsed } = process.memoryUsage();
  return { rss: rss / MB, heap: heapUsed / MB };
};

const round = (n: number, digits = 1) => Number(n.toFixed(digits));

/** A thread over `dir`, idle, with `turns` generated turns stored as the runtime stores them. */
const seedThread = (dir: string, turns: number, checkout: Checkout = { kind: "main", path: dir }) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    const store = yield* ThreadStore;
    const thread = yield* runtimes.create({ projectRoot: dir, checkout });
    yield* waitFor("idle", runtimes.status(thread.id).pipe(Effect.map((s) => s === "idle")));
    const messages = longTranscript({
      threadId: thread.id,
      turns,
      toolOutputBytes: TOOL_OUTPUT_BYTES,
    });
    const { ms } = yield* timed(
      Effect.forEach(messages, (message) =>
        store.upsertMessage(thread.id, message, message.metadata?.turnId as TurnId),
      ),
    );
    // The generated messages aren't returned, so the memory numbers count only what the server keeps.
    return { threadId: thread.id, seedMs: ms };
  });

/** What a late `thread.subscribe` gets before it goes live, and how long it took. */
const lateSubscribe = (threadId: ThreadId, afterRev?: number) =>
  Effect.gen(function* () {
    const hub = yield* EventHub;
    const runtimes = yield* ThreadRuntimes;
    const { value: events, ms } = yield* timed(
      hub.threadFeed(threadId, runtimes.replay(threadId, afterRev)).pipe(
        Stream.takeUntil((event) => event.type === "caughtUp"),
        Stream.runCollect,
      ),
    );
    const head = [...events].find((event) => event.type === "messages" || event.type === "resumed");
    const messages = head?.type === "messages" || head?.type === "resumed" ? head.messages : [];
    const caughtUp = [...events].find((event) => event.type === "caughtUp");
    return {
      ms,
      count: messages.length,
      wireBytes: JSON.stringify(head ?? {}).length,
      resumed: head?.type === "resumed",
      rev: caughtUp?.type === "caughtUp" ? caughtUp.rev : 0,
    };
  });

const storedBytes = (threadId?: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows =
      threadId === undefined
        ? yield* sql<{ bytes: number }>`SELECT SUM(LENGTH(message)) AS bytes FROM messages`
        : yield* sql<{
            bytes: number;
          }>`SELECT SUM(LENGTH(message)) AS bytes FROM messages WHERE thread_id = ${threadId}`;
    return (rows[0]?.bytes ?? 0) / MB;
  }).pipe(Effect.orDie);

/** One streamed reply of `parts` steps, persisted after each step as the accumulator does. */
const streamedWrites = (threadId: ThreadId, parts: number) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const [template] = longTranscript({ threadId: `${threadId}-live`, turns: 1 }).slice(1);
    const message = template!;
    const { ms } = yield* timed(
      Effect.forEach(
        Array.from({ length: parts }, (_, i) => i + 1),
        (count) =>
          store.upsertMessage(threadId, {
            ...message,
            parts: Array.from(
              { length: count },
              (_, i) => message.parts[i % message.parts.length]!,
            ),
          } satisfies GramUIMessage),
      ),
    );
    return ms / parts;
  });

const results: Array<[string, string]> = [];
const record = (metric: string, value: string) => {
  results.push([metric, value]);
  console.log(`${metric}: ${value}`);
};

describe.skipIf(!PERF)("long transcripts", () => {
  const dirs: string[] = [];
  const tempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "gram-perf-transcripts-"));
    dirs.push(dir);
    return dir;
  };

  it.live(
    "one thread with 1,000 turns: storage, FTS, replay, memory",
    () =>
      Effect.gen(function* () {
        const dir = tempDir();
        const database = join(dir, "gram.db");
        const before = memory();
        yield* Effect.gen(function* () {
          const { threadId, seedMs } = yield* seedThread(dir, 1_000);
          record("1,000 turns: store 2,000 messages (with FTS)", `${round(seedMs)} ms`);
          record("1,000 turns: stored message JSON", `${round(yield* storedBytes(threadId))} MB`);
          const afterSeed = memory();
          const first = yield* lateSubscribe(threadId);
          expect(first.count).toBe(2 * FEED_WINDOW_TURNS);
          const again = yield* lateSubscribe(threadId);
          const full = yield* timed((yield* ThreadStore).listMessages(threadId));
          record(
            "1,000 turns: reading the whole history, as a subscribe did before the window",
            `${round(full.ms)} ms, ${full.value.length} messages`,
          );
          record(
            "1,000 turns: late subscriber replay (cold / warm)",
            `${round(first.ms)} ms / ${round(again.ms)} ms`,
          );
          record("1,000 turns: replay payload", `${round(first.wireBytes / MB)} MB`);
          // A reconnect after one more turn, resuming from the revision the last replay ended at.
          const store = yield* ThreadStore;
          for (const message of longTranscript({ threadId, turns: 1 })) {
            yield* store.upsertMessage(threadId, { ...message, id: `${message.id}-next` });
          }
          const resumed = yield* lateSubscribe(threadId, again.rev);
          expect(resumed).toMatchObject({ resumed: true, count: 2 });
          record(
            "1,000 turns: resume after one more turn (time / payload)",
            `${round(resumed.ms)} ms / ${round(resumed.wireBytes / 1024)} KB`,
          );
          const afterReplay = memory();
          record(
            "1,000 turns: server RSS / heap (start → seeded → after 2 replays)",
            `${round(before.rss)} → ${round(afterSeed.rss)} → ${round(afterReplay.rss)} MB / ${round(before.heap)} → ${round(afterSeed.heap)} → ${round(afterReplay.heap)} MB`,
          );
          record(
            "1,000 turns: persist one streamed step (30-step reply)",
            `${round(yield* streamedWrites(threadId, 30), 2)} ms`,
          );
        }).pipe(Effect.provide(layerFor(database)));

        // The same seeding with the FTS insert trigger dropped: the difference is indexing time.
        const noFts = tempDir();
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql.unsafe("DROP TRIGGER messages_search_insert").pipe(Effect.orDie);
          const { seedMs } = yield* seedThread(noFts, 1_000);
          record(
            "1,000 turns: store 2,000 messages (FTS insert trigger dropped)",
            `${round(seedMs)} ms`,
          );
        }).pipe(Effect.provide(layerFor(join(noFts, "gram.db"))));
        record("1,000 turns: database file", `${round(statSync(database).size / MB)} MB`);
      }),
    600_000,
  );

  it.live(
    "20 threads with 300 turns each: storage, replay, memory",
    () =>
      Effect.gen(function* () {
        const dir = tempDir();
        const database = join(dir, "gram.db");
        const before = memory();
        yield* Effect.gen(function* () {
          const seeded = yield* Effect.forEach(Array.from({ length: 20 }), () =>
            seedThread(dir, 300),
          );
          record(
            "20 × 300 turns: store 12,000 messages",
            `${round(seeded.reduce((sum, s) => sum + s.seedMs, 0))} ms`,
          );
          record("20 × 300 turns: stored message JSON", `${round(yield* storedBytes())} MB`);
          const replays = yield* Effect.forEach(seeded, (s) => lateSubscribe(s.threadId));
          const times = replays.map((r) => r.ms).toSorted((a, b) => a - b);
          record(
            "20 × 300 turns: late subscriber replay per thread (median / max)",
            `${round(times[10]!)} ms / ${round(times.at(-1)!)} ms`,
          );
          const after = memory();
          record(
            "20 × 300 turns: server RSS / heap (start → after seeding and 20 replays)",
            `${round(before.rss)} → ${round(after.rss)} MB / ${round(before.heap)} → ${round(after.heap)} MB`,
          );
        }).pipe(Effect.provide(layerFor(database)));
        record("20 × 300 turns: database file", `${round(statSync(database).size / MB)} MB`);

        writeFileSync(
          OUT_FILE,
          `| Metric | Value |\n|---|---|\n${results.map(([m, v]) => `| ${m} | ${v} |`).join("\n")}\n`,
        );
        console.log(`perf results written to ${OUT_FILE}`);
        for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
      }),
    600_000,
  );
});

// A loaded server: what a client switching threads waits for while other threads
// stream, turns start and end, and the git sweep runs, over the real WebSocket with JSON
// serialization. The client runs in a worker thread, so its own parsing can't pass for a server
// stall; the server's loop is this thread's. Opt in with GRAM_PERF_LOAD=1; `GRAM_PERF_LOAD_OUT` names
// the results file, `GRAM_PERF_LOAD_SECONDS` how long the client switches. `GRAM_PERF_DB` names a
// database to copy and serve beside the generated threads: sizes and timings of it are printed,
// never its content, and its threads are detached from their checkouts first.
const LOAD = process.env["GRAM_PERF_LOAD"] === "1";
const LOAD_OUT_FILE = process.env["GRAM_PERF_LOAD_OUT"] ?? join(tmpdir(), "gram-perf-load.md");
const LOAD_DB = process.env["GRAM_PERF_DB"] || undefined;
const LOAD_SECONDS = Number(process.env["GRAM_PERF_LOAD_SECONDS"] ?? 40);
/** Tracked files in the generated repo every worktree thread works in. */
const REPO_FILES = Number(process.env["GRAM_PERF_LOAD_REPO_FILES"] ?? 2_400);
/** Stored turns of the two long threads; the rest are `WORKTREE_THREADS` short ones in worktrees. */
const LONG_THREADS = [1_000, 1_000];
const WORKTREE_THREADS = 22;
const STREAMING = 5;
/** Worktree threads the client sends to, to open them as their turn starts and as it ends. */
const TURN_THREADS = 4;
/** How long after a send the fake agent ends the turn, and the client subscribes again. */
const TURN_MS = 400;
/** Tool calls a streaming reply already holds before the run, as deep into a long real turn. */
const STREAM_BACKLOG_TOOLS = Number(process.env["GRAM_PERF_LOAD_BACKLOG"] ?? 250);

/**
 * The switching client, as a CommonJS worker. One socket carries the feeds and a small RPC every
 * `probeMs` (what the app's one socket does); a second socket carries the same small RPC alone, so
 * the difference is what queueing behind a replay costs. After `seconds` of switching it sends to
 * each of `turnThreadIds` and opens the thread at once, then again `turnMs` later as the turn ends.
 */
const CLIENT = `
const { parentPort, workerData } = require("node:worker_threads");
const { performance } = require("node:perf_hooks");
const { url, cookie, threadIds, turnThreadIds, turnMs, probeMs, dwellMs, seconds } = workerData;
const open = () => new Promise((resolve, reject) => {
  const ws = new WebSocket(url, { headers: { cookie } });
  ws.onopen = () => resolve(ws);
  ws.onerror = () => reject(new Error("socket failed"));
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let nextId = 1;
const request = (ws, tag, payload) => {
  const id = String(nextId++);
  ws.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
  return id;
};
const probe = (ws, out) => {
  const pending = new Map();
  const timer = setInterval(() => pending.set(request(ws, "settings.get", null), performance.now()), probeMs);
  return {
    seen: (id) => {
      const at = pending.get(id);
      if (at === undefined) return false;
      pending.delete(id);
      out.push(performance.now() - at);
      return true;
    },
    stop: () => clearInterval(timer),
  };
};
const headOf = (data) => {
  const head = data.slice(0, 200);
  return { tag: /"_tag":"(\\w+)"/.exec(head)?.[1], id: /"requestId":"?(\\d+)/.exec(head)?.[1] };
};
(async () => {
  const shared = await open();
  const alone = await open();
  const sharedRtt = [], aloneRtt = [], switches = [], turnStarts = [], turnEnds = [], history = [];
  const historyAsked = new Map();
  const sharedProbe = probe(shared, sharedRtt);
  const aloneProbe = probe(alone, aloneRtt);
  alone.onmessage = (event) => {
    const { tag, id } = headOf(event.data);
    if (tag === "Exit") aloneProbe.seen(id);
  };
  const feeds = new Map();
  shared.onmessage = (event) => {
    const data = event.data;
    const { tag, id } = headOf(data);
    if (tag === "Exit" && sharedProbe.seen(id)) return;
    if (tag === "Exit" && historyAsked.has(id)) {
      history.push(performance.now() - historyAsked.get(id));
      historyAsked.delete(id);
      return;
    }
    const feed = feeds.get(id);
    if (tag !== "Chunk" || feed === undefined) return;
    const now = performance.now();
    feed.firstMs ??= now - feed.at;
    feed.bytes += data.length;
    feed.frames += 1;
    shared.send(JSON.stringify({ _tag: "Ack", requestId: id }));
    if (feed.caughtUpMs === undefined && data.slice(-400).includes('"type":"caughtUp"')) {
      feed.caughtUpMs = now - feed.at;
      feed.done();
    }
  };
  /** Opens a thread's feed and asks for its prompt history, as the composer does, waits for caughtUp and \`dwellMs\`, closes the feed. */
  const visit = async (threadId) => {
    let feed;
    const id = request(shared, "thread.subscribe", { threadId });
    historyAsked.set(request(shared, "thread.promptHistory", { threadId }), performance.now());
    await new Promise((done) => {
      feed = { threadId, at: performance.now(), bytes: 0, frames: 0, done };
      feeds.set(id, feed);
    });
    await sleep(dwellMs);
    feeds.delete(id);
    shared.send(JSON.stringify({ _tag: "Interrupt", requestId: id, interruptors: [] }));
    const { firstMs, caughtUpMs, bytes, frames } = feed;
    return { threadId, firstMs, caughtUpMs, bytes, frames };
  };
  const deadline = performance.now() + seconds * 1000;
  for (let i = 0; performance.now() < deadline; i++) {
    switches.push(await visit(threadIds[i % threadIds.length]));
  }
  for (const threadId of turnThreadIds) {
    const sentAt = performance.now();
    request(shared, "thread.send", { threadId, input: { text: "go" } });
    turnStarts.push(await visit(threadId));
    await sleep(Math.max(0, turnMs - (performance.now() - sentAt)));
    turnEnds.push(await visit(threadId));
    await sleep(turnMs);
  }
  sharedProbe.stop();
  aloneProbe.stop();
  parentPort.postMessage({ switches, turnStarts, turnEnds, sharedRtt, aloneRtt, history });
  shared.close();
  alone.close();
})().catch((error) => parentPort.postMessage({ error: String(error) }));
`;

interface Visit {
  readonly threadId: string;
  readonly firstMs: number;
  readonly caughtUpMs: number;
  readonly bytes: number;
  readonly frames: number;
}

interface ClientReport {
  readonly error?: string;
  readonly switches: ReadonlyArray<Visit>;
  readonly turnStarts: ReadonlyArray<Visit>;
  readonly turnEnds: ReadonlyArray<Visit>;
  readonly sharedRtt: ReadonlyArray<number>;
  readonly aloneRtt: ReadonlyArray<number>;
  /** `thread.promptHistory` round trips, one per visit. */
  readonly history: ReadonlyArray<number>;
}

/** Performs the boot navigation and returns the session cookie. */
const bootCookie = (port: number, token: string) =>
  Effect.promise(
    () =>
      new Promise<string>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port, path: `/?boot=${token}`, agent: false },
          (res) => {
            res.resume();
            resolve((res.headers["set-cookie"]?.[0] ?? "").split(";")[0] ?? "");
          },
        );
        req.on("error", reject);
        req.end();
      }),
  );

/**
 * Points every thread of a copied database at an empty folder, so serving it never runs git in, or
 * watches, the checkouts of whoever the copy came from.
 */
const detachCheckouts = (databaseFile: string, folder: string) => {
  const db = new DatabaseSync(databaseFile);
  db.prepare(
    `UPDATE threads SET data = json_remove(
       json_set(data, '$.checkout', json_object('kind', 'main', 'path', ?)),
       '$.currentCheckout', '$.additionalDirectories', '$.extraCheckouts', '$.boundPr', '$.extraPrs')`,
  ).run(folder);
  db.close();
};

/** Test setup only: the server's own git goes through `runCommand`. */
const setupGit = (cwd: string, ...args: ReadonlyArray<string>) =>
  execFileSync("git", ["-c", "user.name=perf", "-c", "user.email=perf@localhost", ...args], {
    cwd,
    stdio: "ignore",
  });

/** A committed repo of `files` small files under `root`, with `worktrees` linked worktrees. */
const generatedRepo = (root: string, files: number, worktrees: number) => {
  const repo = join(root, "repo");
  for (let i = 0; i < files; i++) {
    const dir = join(repo, `pkg-${i % 40}`, `dir-${i % 7}`);
    if (i < 280) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `file-${i}.ts`), `export const value${i} = ${i};\n`);
  }
  setupGit(repo, "init", "-q", "-b", "main");
  setupGit(repo, "add", "-A");
  setupGit(repo, "commit", "-q", "-m", "perf");
  return Array.from({ length: worktrees }, (_, i): Checkout => {
    const path = join(root, "worktrees", `wt-${i}`);
    setupGit(repo, "worktree", "add", "-q", "-b", `perf-${i}`, path);
    return { kind: "worktree", path, branch: `perf-${i}`, base: "main", repoRoot: repo };
  });
};

const quantiles = (values: ReadonlyArray<number>) => {
  const sorted = values.toSorted((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return `p50 ${round(at(0.5))} / p99 ${round(at(0.99))} / max ${round(sorted.at(-1) ?? 0)} ms (n=${sorted.length})`;
};

/** Chunks of one tool call with `bytes` of output, as the Claude adapter streams a Bash run. */
const toolCall = (messageId: MessageId, bytes: number): ReadonlyArray<AgentEvent> => {
  const toolCallId = `toolu_${randomUUID()}`;
  const chunk = (value: GramUIMessageChunk): AgentEvent => ({
    type: "chunk",
    messageId,
    chunk: value,
  });
  return [
    chunk({ type: "tool-input-start", toolCallId, toolName: "Bash", providerExecuted: true }),
    chunk({
      type: "tool-input-available",
      toolCallId,
      toolName: "Bash",
      input: { command: "pnpm test", description: "Run the tests" },
      providerExecuted: true,
    }),
    chunk({
      type: "tool-output-available",
      toolCallId,
      output: "x".repeat(bytes),
      providerExecuted: true,
    }),
  ];
};

describe.skipIf(!LOAD)("a loaded server", () => {
  it.live(
    "switching threads while others stream, turns start and end, and the sweep runs",
    () =>
      Effect.gen(function* () {
        const dataDir = mkdtempSync(join(tmpdir(), "gram-perf-load-"));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => rmSync(dataDir, { recursive: true, force: true })),
        );
        const databaseFile = join(dataDir, "gram.db");
        if (LOAD_DB !== undefined) {
          for (const suffix of ["", "-wal", "-shm"]) {
            if (existsSync(`${LOAD_DB}${suffix}`)) {
              copyFileSync(`${LOAD_DB}${suffix}`, `${databaseFile}${suffix}`);
            }
          }
          detachCheckouts(databaseFile, mkdtempSync(join(dataDir, "detached-")));
        }
        const worktrees = generatedRepo(dataDir, REPO_FILES, WORKTREE_THREADS);
        // Every git process the server starts, by subcommand, counted from when the client starts.
        const started = new Map<string, number>();
        let counting = false;
        const countingProc = Layer.effect(
          Proc,
          Effect.map(Effect.service(Proc), (proc) =>
            Proc.of({
              run: (bin, args, options) =>
                Effect.suspend(() => {
                  if (counting) {
                    const kind = `${bin.split("/").at(-1)} ${args.find((a) => !a.startsWith("-") && !a.includes("=")) ?? ""}`;
                    started.set(kind, (started.get(kind) ?? 0) + 1);
                  }
                  return proc.run(bin, args, options);
                }),
            }),
          ),
        ).pipe(Layer.provide(ProcLive));
        const server = ServerLayer.pipe(
          Layer.provideMerge(FakeAgentAdapter),
          Layer.provide(GitTurnHooksLive),
          // The production sweep cadence, with no `gh` and no remote behind it.
          Layer.provide(
            gitPlatformTest({
              config: { sweepInterval: Duration.seconds(15) },
              proc: countingProc,
            }),
          ),
          Layer.provide(ServerConfig.layer({ ...TEST_CONFIG, dataDir, databaseFile })),
          Layer.orDie,
        );
        yield* Effect.gen(function* () {
          const runtimes = yield* ThreadRuntimes;
          const store = yield* ThreadStore;
          const control = yield* FakeAgentControl;
          const existing = (yield* store.listThreads).map((t) => t.id);

          const long: Array<ThreadId> = [];
          for (const turns of LONG_THREADS) {
            long.push((yield* seedThread(mkdtempSync(join(dataDir, "t-")), turns)).threadId);
          }
          const inWorktrees: Array<ThreadId> = [];
          for (const checkout of worktrees) {
            inWorktrees.push((yield* seedThread(checkout.repoRoot!, 60, checkout)).threadId);
          }
          const streaming = inWorktrees.slice(0, STREAMING);
          const turnThreads = inWorktrees.slice(STREAMING, STREAMING + TURN_THREADS);
          const replies = new Map<ThreadId, MessageId>();
          for (const threadId of streaming) {
            yield* runtimes.send(threadId, { text: "go" });
            const session = yield* control.latest(threadId);
            const messageId = `reply-${randomUUID()}` as MessageId;
            replies.set(threadId, messageId);
            yield* session.emit(
              { type: "chunk", messageId, chunk: { type: "start", messageId } },
              { type: "chunk", messageId, chunk: { type: "text-start", id: "t0" } },
            );
            for (let i = 0; i < STREAM_BACKLOG_TOOLS; i++) {
              yield* session.emit(...toolCall(messageId, 4_000));
            }
          }
          // The backlog is stored before anything is timed, or the run measures its own setup.
          for (const [threadId, messageId] of replies) {
            yield* Effect.gen(function* () {
              for (;;) {
                const stored = yield* store.getMessage(threadId, messageId);
                if ((stored?.parts.length ?? 0) > STREAM_BACKLOG_TOOLS) return;
                yield* Effect.sleep("50 millis");
              }
            });
          }
          // Text every 40 ms and a tool call every second on each streaming thread.
          yield* Effect.forEach(
            streaming,
            (threadId) =>
              Effect.gen(function* () {
                const session = yield* control.latest(threadId);
                const messageId = replies.get(threadId)!;
                for (let tick = 1; ; tick++) {
                  yield* Effect.sleep("40 millis");
                  yield* session.emit({
                    type: "chunk",
                    messageId,
                    chunk: { type: "text-delta", id: "t0", delta: "streamed words " },
                  });
                  if (tick % 25 === 0) yield* session.emit(...toolCall(messageId, 4_000));
                }
              }).pipe(Effect.forkScoped),
            { discard: true },
          );
          // Each send the client makes to a turn thread is answered `TURN_MS` later.
          yield* Effect.forEach(
            turnThreads,
            (threadId) =>
              Effect.gen(function* () {
                const session = yield* control.latest(threadId);
                for (let answered = 0; ;) {
                  if (session.sent.length === answered) {
                    yield* Effect.sleep("5 millis");
                    continue;
                  }
                  answered = session.sent.length;
                  yield* Effect.sleep(Duration.millis(TURN_MS));
                  yield* session.completeTurn("done");
                }
              }).pipe(Effect.forkScoped),
            { discard: true },
          );

          const http = yield* HttpServer.HttpServer;
          const { token } = yield* LaunchToken;
          const port = serverPort(http);
          const cookie = yield* bootCookie(port, token);
          const threadIds = [...existing, ...long, ...inWorktrees.slice(STREAMING + TURN_THREADS)];
          // Every fourth visit is to a streaming thread.
          const order = threadIds.flatMap((id, i) =>
            i % 3 === 2 ? [id, streaming[i % STREAMING]!] : [id],
          );
          const loop = monitorEventLoopDelay({ resolution: 5 });
          loop.enable();
          counting = true;
          const report = yield* Effect.promise(
            () =>
              new Promise<ClientReport>((resolve, reject) => {
                const worker = new Worker(CLIENT, {
                  eval: true,
                  workerData: {
                    url: `ws://127.0.0.1:${port}/ws`,
                    cookie,
                    threadIds: order,
                    turnThreadIds: [...turnThreads, ...turnThreads],
                    turnMs: TURN_MS,
                    probeMs: 25,
                    dwellMs: 150,
                    seconds: LOAD_SECONDS,
                  },
                });
                worker.once("message", resolve);
                worker.once("error", reject);
              }),
          );
          loop.disable();
          counting = false;
          if (report.error !== undefined) return yield* Effect.die(new Error(report.error));

          const lines: Array<string> = [];
          const note = (metric: string, value: string) => {
            lines.push(`| ${metric} | ${value} |`);
            console.log(`${metric}: ${value}`);
          };
          const caughtUp = (visits: ReadonlyArray<Visit>) =>
            quantiles(visits.map((v) => v.caughtUpMs));
          const live = new Set<string>(streaming);
          note(
            "load",
            `${existing.length + LONG_THREADS.length + WORKTREE_THREADS} threads (${existing.length} from GRAM_PERF_DB, ${LONG_THREADS.length} of 1,000 turns, ${WORKTREE_THREADS} in worktrees of a ${REPO_FILES}-file repo), ${STREAMING} streaming with ${STREAM_BACKLOG_TOOLS} tool calls in flight, sweep every 15 s, ${report.switches.length} switches in ${LOAD_SECONDS} s`,
          );
          note(
            "server event-loop delay",
            `p50 ${round(loop.percentile(50) / 1e6)} / p99 ${round(loop.percentile(99) / 1e6)} / max ${round(loop.max / 1e6)} ms`,
          );
          const processes = [...started].toSorted((a, b) => b[1] - a[1]);
          note(
            "git processes started",
            `${processes.reduce((sum, [, n]) => sum + n, 0)}: ${processes
              .slice(0, 6)
              .map(([kind, n]) => `${n} ${kind}`)
              .join(", ")}`,
          );
          note("small RPC round trip, own socket", quantiles(report.aloneRtt));
          note("small RPC round trip, the feeds' socket", quantiles(report.sharedRtt));
          note("thread.promptHistory round trip", quantiles(report.history));
          note("subscribe → first byte", quantiles(report.switches.map((v) => v.firstMs)));
          note("subscribe → caughtUp", caughtUp(report.switches));
          note(
            "subscribe → caughtUp, streaming threads",
            caughtUp(report.switches.filter((v) => live.has(v.threadId))),
          );
          note("subscribe → caughtUp, as the thread's turn starts", caughtUp(report.turnStarts));
          note("subscribe → caughtUp, as the thread's turn ends", caughtUp(report.turnEnds));
          note(
            "largest replays (MB → ms to caughtUp)",
            report.switches
              .toSorted((a, b) => b.bytes - a.bytes)
              .filter((v, i, all) => all.findIndex((o) => o.threadId === v.threadId) === i)
              .slice(0, 8)
              .map((v) => `${round(v.bytes / MB, 2)} → ${round(v.caughtUpMs)}`)
              .join(", "),
          );
          writeFileSync(LOAD_OUT_FILE, `| Metric | Value |\n|---|---|\n${lines.join("\n")}\n`);
          console.log(`perf results written to ${LOAD_OUT_FILE}`);
        }).pipe(Effect.provide(server), Effect.scoped);
      }),
    900_000,
  );
});
