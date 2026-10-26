import { describe, expect, it } from "@effect/vitest";
import { GramRpcs, type ServerEvent, type ThreadFeedEvent, type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { RpcClient, RpcSerialization, Socket } from "../platform/unstable.ts";

// Memory of warm Claude sessions against the bundled server with real `claude`.
// Sessions open without a prompt (the init handshake only). The one prompt is a single Haiku turn on
// an evicted thread, to check the cold start. Opt in with GRAM_PERF_SESSIONS=1 after
// `pnpm --filter @gram/desktop build`; macOS / Linux (`ps`).
const PERF = process.env["GRAM_PERF_SESSIONS"] === "1";
const SERVER_JS = fileURLToPath(
  new URL("../../../../apps/desktop/out/server/server.js", import.meta.url),
);
/** Where the results table is written; `GRAM_PERF_OUT` overrides it. */
const OUT_FILE = process.env["GRAM_PERF_OUT"] ?? join(tmpdir(), "gram-perf-sessions.md");
const STEPS = [1, 5, 10, 20];
const EVICT_MINUTES = 0.5;
const MB = 1024;

interface Proc {
  readonly pid: number;
  readonly ppid: number;
  readonly rssKb: number;
  readonly command: string;
}

const processTable = (): ReadonlyArray<Proc> =>
  execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss=,command="], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      return match
        ? [{ pid: +match[1]!, ppid: +match[2]!, rssKb: +match[3]!, command: match[4]! }]
        : [];
    });

const descendants = (table: ReadonlyArray<Proc>, root: number): ReadonlyArray<Proc> => {
  const out: Array<Proc> = [];
  const queue = [root];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const proc of table) {
      if (proc.ppid === parent) {
        out.push(proc);
        queue.push(proc.pid);
      }
    }
  }
  return out;
};

/** The agent CLI itself: the SDK always runs it with `--output-format stream-json`. */
const isClaude = (proc: Proc) => proc.command.includes("stream-json");

/** A short name for the summary: the executable's last path segment. */
const commandName = (proc: Proc) => proc.command.split(" ")[0]?.split("/").at(-1) ?? proc.command;

interface Row {
  readonly label: string;
  readonly sessions: number;
  readonly serverMb: number;
  readonly claudeProcesses: number;
  readonly claudeMb: number;
  readonly treeProcesses: number;
  readonly treeMb: number;
  /** Process count per executable name in the child tree. */
  readonly names: Readonly<Record<string, number>>;
}

/** Every process the server has started, by pid and command, so cleanup never touches others. */
const started = new Map<number, string>();

const kb = (procs: ReadonlyArray<Proc>) => procs.reduce((sum, p) => sum + p.rssKb, 0);

const measure = (server: ChildProcess, label: string, sessions: number): Row => {
  const table = processTable();
  const tree = descendants(table, server.pid!);
  for (const proc of tree) started.set(proc.pid, proc.command);
  const claude = tree.filter(isClaude);
  return {
    label,
    sessions,
    serverMb: Math.round((table.find((p) => p.pid === server.pid)?.rssKb ?? 0) / MB),
    claudeProcesses: claude.length,
    claudeMb: Math.round(kb(claude) / MB),
    treeProcesses: tree.length,
    treeMb: Math.round(kb(tree) / MB),
    names: tree.reduce<Record<string, number>>((counts, proc) => {
      const name = isClaude(proc) ? "claude" : commandName(proc);
      counts[name] = (counts[name] ?? 0) + 1;
      return counts;
    }, {}),
  };
};

/** Stops the server, then kills whatever it started that is still alive with the same command. */
const cleanUp = (server: ChildProcess) =>
  Effect.gen(function* () {
    for (const proc of descendants(processTable(), server.pid!)) {
      started.set(proc.pid, proc.command);
    }
    if (server.exitCode === null) {
      server.kill("SIGTERM");
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 10_000);
            server.once("exit", () => {
              clearTimeout(timer);
              resolve();
            });
          }),
      );
    }
    const survivors = () =>
      processTable().filter((p) => started.get(p.pid) === p.command || p.pid === server.pid);
    for (const proc of survivors()) {
      try {
        process.kill(proc.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    yield* Effect.sleep("1 second");
    const left = survivors();
    console.log(`cleanup: ${started.size} started processes, ${left.length} left`);
    expect(left).toEqual([]);
  });

const bootFrom = (server: ChildProcess) =>
  Effect.promise(
    () =>
      new Promise<{ port: number; token: string }>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("the server didn't boot within 60 s")),
          60_000,
        );
        createInterface({ input: server.stdout! }).on("line", (line) => {
          const match = /^boot http:\/\/127\.0\.0\.1:(\d+)\/\?boot=(\S+)$/.exec(line);
          if (!match) return;
          clearTimeout(timer);
          resolve({ port: Number(match[1]), token: match[2]! });
        });
        server.once("exit", (code) => reject(new Error(`the server exited with ${code}`)));
      }),
  );

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

const until = (
  label: string,
  check: () => boolean,
  timeoutMs: number,
  context: () => unknown = () => undefined,
) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (check()) return;
      yield* Effect.sleep("500 millis");
    }
    return yield* Effect.die(
      new Error(`timed out waiting for ${label}: ${JSON.stringify(context())}`),
    );
  });

const tempRepo = () => {
  const dir = mkdtempSync(join(tmpdir(), "gram-perf-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "perf\n");
  return dir;
};

describe.skipIf(!PERF)("warm Claude session memory", () => {
  it.live(
    "measures 1, 5, 10 and 20 warm sessions, idle eviction and one cold start",
    () =>
      Effect.gen(function* () {
        expect(existsSync(SERVER_JS), `build the server bundle first: ${SERVER_JS}`).toBe(true);
        const dataDir = mkdtempSync(join(tmpdir(), "gram-perf-data-"));
        const repos: Array<string> = [];
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            for (const dir of [dataDir, ...repos]) rmSync(dir, { recursive: true, force: true });
          }),
        );

        const env = { ...process.env };
        delete env["GRAM_FAKE_AGENT"];
        const server = spawn(process.execPath, [SERVER_JS], {
          env: {
            ...env,
            GRAM_DATA_DIR: dataDir,
            GRAM_PORT: "0",
            GRAM_IDLE_EVICT_MINUTES: String(EVICT_MINUTES),
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        yield* Effect.addFinalizer(() => cleanUp(server).pipe(Effect.orDie));
        server.stderr?.resume();

        const { port, token } = yield* bootFrom(server);
        const cookie = yield* bootCookie(port, token);
        const protocol = yield* Layer.build(
          RpcClient.layerProtocolSocket().pipe(
            Layer.provide(Socket.layerWebSocket(`ws://127.0.0.1:${port}/ws`)),
            Layer.provide(
              Layer.succeed(Socket.WebSocketConstructor)(
                (url) =>
                  new (globalThis.WebSocket as unknown as new (
                    url: string,
                    init: { headers: Record<string, string> },
                  ) => globalThis.WebSocket)(url, { headers: { cookie } }),
              ),
            ),
            Layer.provide(RpcSerialization.layerJson),
          ),
        );
        const client = yield* RpcClient.make(GramRpcs).pipe(Effect.provideContext(protocol));
        const status = new Map<string, string>();
        const history = new Map<string, Array<string>>();
        yield* Effect.forkScoped(
          Stream.runForEach(client["events.subscribe"](), (e: ServerEvent) =>
            Effect.sync(() => {
              if (e.type !== "thread.status") return;
              status.set(e.threadId, e.status);
              history.set(e.threadId, [...(history.get(e.threadId) ?? []), e.status]);
            }),
          ),
        );

        yield* Effect.sleep("3 seconds");
        const rows: Array<Row> = [measure(server, "server only", 0)];
        const threads: Array<ThreadId> = [];
        for (const target of STEPS) {
          while (threads.length < target) {
            const repo = tempRepo();
            repos.push(repo);
            // No `input`: a warm draft opens the session without sending anything.
            const thread = yield* client["thread.create"]({
              projectRoot: repo,
              checkout: { kind: "current" },
              model: { agent: "claude", model: "haiku" },
              mode: "default",
            });
            // Pinned threads aren't evicted while the next steps open.
            yield* client["thread.pin"]({ threadId: thread.id, pinned: true });
            threads.push(thread.id);
          }
          yield* until(
            `${target} sessions to go idle`,
            () => threads.every((id) => status.get(id) === "idle"),
            240_000,
          );
          yield* Effect.sleep("5 seconds");
          rows.push(measure(server, `${target} warm`, target));
        }

        for (const threadId of threads) yield* client["thread.pin"]({ threadId, pinned: false });
        yield* until(
          "idle eviction",
          () =>
            measure(server, "", 0).treeProcesses === 0 &&
            threads.every((id) => status.get(id) === "cold"),
          EVICT_MINUTES * 60_000 + 120_000,
          () => threads.map((id) => status.get(id)),
        );
        yield* Effect.sleep("5 seconds");
        rows.push(measure(server, "after eviction", 0));
        const cold = threads.filter((id) => status.get(id) === "cold").length;

        // The script's only prompt: an evicted thread has to reopen for one real turn.
        const coldThread = threads[0]!;
        const from = history.get(coldThread)?.length ?? 0;
        const coldPath = () => (history.get(coldThread) ?? []).slice(from);
        yield* client["thread.send"]({
          threadId: coldThread,
          input: { text: "Reply with the single word OK." },
        });
        yield* until(
          "the cold thread's turn to finish",
          () => {
            const statuses = coldPath();
            const running = statuses.indexOf("running");
            return (
              statuses.includes("starting") &&
              running !== -1 &&
              statuses.slice(running + 1).includes("idle")
            );
          },
          240_000,
          () => ({ path: coldPath(), status: status.get(coldThread) }),
        );
        const feed = yield* client["thread.subscribe"]({ threadId: coldThread }).pipe(
          Stream.takeUntil((e: ThreadFeedEvent) => e.type === "caughtUp"),
          Stream.runCollect,
        );
        const reply = feed
          .flatMap((e) => (e.type === "messages" ? e.messages : []))
          .filter((m) => m.role === "assistant")
          .flatMap((m) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])))
          .join("")
          .trim();
        yield* Effect.sleep("5 seconds");
        rows.push(measure(server, "1 cold start + 1 turn", 1));

        const baseline = rows[0]!;
        const perSession = (r: Row) =>
          r.sessions === 0
            ? "—"
            : `${Math.round(r.claudeMb / r.sessions)} / ${Math.round(
                (r.treeMb + r.serverMb - baseline.treeMb - baseline.serverMb) / r.sessions,
              )}`;
        const report = [
          "| step | server MB | claude processes | claude MB | child tree processes | child tree MB | MB per session (claude / server + tree) |",
          "|---|---|---|---|---|---|---|",
          ...rows.map(
            (r) =>
              `| ${r.label} | ${r.serverMb} | ${r.claudeProcesses} | ${r.claudeMb} | ${r.treeProcesses} | ${r.treeMb} | ${perSession(r)} |`,
          ),
          `threads cold after eviction: ${cold}/${threads.length}`,
          `cold start: ${coldPath().join(" → ")}; reply ${JSON.stringify(reply.slice(0, 40))}`,
          `child tree at ${STEPS.at(-1)} sessions: ${JSON.stringify(
            rows.find((r) => r.label === `${STEPS.at(-1)} warm`)?.names,
          )}`,
        ].join("\n");
        // Vitest hides a passing test's console output, so the table also goes to a file.
        writeFileSync(OUT_FILE, `${report}\n`);
        console.log(report);
        expect(rows.find((r) => r.label === "after eviction")?.treeProcesses).toBe(0);
        expect(cold).toBe(threads.length);
        expect(reply).not.toBe("");
      }),
    30 * 60_000,
  );
});
