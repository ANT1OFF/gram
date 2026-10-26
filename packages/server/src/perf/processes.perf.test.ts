import { describe, expect, it } from "@effect/vitest";
import { GramRpcs, type ServerEvent, type ThreadId } from "@gram/contracts";
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

// Which processes the server's tree holds with N open threads, and who started them: zombies (`Z`),
// git and the agent CLI, sampled over time. Threads open without a prompt, so nothing is spent.
// Opt in with GRAM_PERF_PROCESSES=1 after `pnpm --filter @gram/desktop build`;
// GRAM_PERF_FAKE_AGENT=1 runs the echo fake, so only the server's own spawns show. macOS / Linux.
const CENSUS = process.env["GRAM_PERF_PROCESSES"] === "1";
const FAKE = process.env["GRAM_PERF_FAKE_AGENT"] === "1";
const THREADS = Number(process.env["GRAM_PERF_THREADS"] ?? "20");
const OUT_FILE = process.env["GRAM_PERF_OUT"] ?? join(tmpdir(), "gram-perf-processes.md");
const SERVER_JS = fileURLToPath(
  new URL("../../../../apps/desktop/out/server/server.js", import.meta.url),
);
/**
 * A window to report before sampling: `listed` has its sidebar open and no panes, so every thread is
 * a row on screen; `collapsed` has the sidebar collapsed too, so no thread's chips are. Unset, no
 * window registers, which the server takes as every thread listed.
 */
const WINDOW = process.env["GRAM_PERF_WINDOW"];
/** Seven samples 5 s apart by default; a fast run (e.g. 180 × 250 ms) catches short-lived spawns. */
const SAMPLES = Number(process.env["GRAM_PERF_SAMPLES"] ?? "7");
const SAMPLE_MS = Number(process.env["GRAM_PERF_SAMPLE_MS"] ?? "5000");

interface Proc {
  readonly pid: number;
  readonly ppid: number;
  readonly stat: string;
  readonly etime: string;
  readonly command: string;
}

const processTable = (): ReadonlyArray<Proc> =>
  execFileSync("ps", ["-A", "-o", "pid=,ppid=,stat=,etime=,command="], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
      return match
        ? [
            {
              pid: +match[1]!,
              ppid: +match[2]!,
              stat: match[3]!,
              etime: match[4]!,
              command: match[5]!,
            },
          ]
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

/** A short name: `claude` for the agent CLI (always run with `stream-json`), else the executable. */
const nameOf = (proc: Proc) =>
  proc.command.includes("stream-json")
    ? "claude"
    : (proc.command.split(" ")[0]?.split("/").at(-1) ?? proc.command);

const isZombie = (proc: Proc) => proc.stat.includes("Z") || proc.command.includes("<defunct>");
const isGit = (proc: Proc) => /^\(?git\)?$/.test(nameOf(proc));
const sampleSeconds = (s: Sample) => s.at.toFixed(1);

interface Sample {
  readonly at: number;
  readonly total: number;
  readonly zombies: ReadonlyArray<string>;
  readonly git: ReadonlyArray<string>;
  readonly claude: number;
  /** `pid command` for every process, to find the long-lived ones. */
  readonly ids: ReadonlySet<string>;
  readonly groups: Readonly<Record<string, number>>;
  /** Live (non-zombie) processes per executable name. */
  readonly running: Readonly<Record<string, number>>;
}

/** Every process the server has started, by pid and command, so cleanup never touches others. */
const started = new Map<number, string>();

const sample = (server: ChildProcess, at: number): Sample => {
  const table = processTable();
  const byPid = new Map(table.map((p) => [p.pid, p]));
  const tree = descendants(table, server.pid!);
  for (const proc of tree) started.set(proc.pid, proc.command);
  const chain = (proc: Proc) => {
    const names: Array<string> = [];
    let parent = byPid.get(proc.ppid);
    while (parent !== undefined && names.length < 3) {
      names.push(parent.pid === server.pid ? "server" : nameOf(parent));
      if (parent.pid === server.pid) break;
      parent = byPid.get(parent.ppid);
    }
    return names.join(" ← ");
  };
  const describeProc = (proc: Proc) =>
    `${proc.pid} ${nameOf(proc)} [${proc.stat} ${proc.etime}] ← ${chain(proc)}`;
  const groups: Record<string, number> = {};
  const running: Record<string, number> = {};
  for (const proc of tree) {
    const key = `${nameOf(proc)} [${proc.stat.charAt(0)}] ← ${chain(proc)}`;
    groups[key] = (groups[key] ?? 0) + 1;
    if (!isZombie(proc)) running[nameOf(proc)] = (running[nameOf(proc)] ?? 0) + 1;
  }
  return {
    at,
    total: tree.length,
    zombies: tree.filter(isZombie).map(describeProc),
    git: tree.filter(isGit).map(describeProc),
    claude: tree.filter((p) => nameOf(p) === "claude").length,
    ids: new Set(tree.map((p) => `${p.pid} ${p.command}`)),
    groups,
    running,
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
    // A zombie can't be killed, only reaped by its parent; with the server gone launchd reaps it.
    const left = survivors().filter((p) => !isZombie(p));
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

const until = (label: string, check: () => boolean, timeoutMs: number, context: () => unknown) =>
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
  const dir = mkdtempSync(join(tmpdir(), "gram-census-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "census\n");
  return dir;
};

describe.skipIf(!CENSUS || process.platform === "win32")("server process census", () => {
  it.live(
    `samples the process tree with ${THREADS} open threads`,
    () =>
      Effect.gen(function* () {
        expect(existsSync(SERVER_JS), `build the server bundle first: ${SERVER_JS}`).toBe(true);
        const dataDir = mkdtempSync(join(tmpdir(), "gram-census-data-"));
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
            ...(FAKE ? { GRAM_FAKE_AGENT: "1", GRAM_FAKE_AGENT_REPLY: "echo" } : {}),
            GRAM_DATA_DIR: dataDir,
            GRAM_PORT: "0",
            // No eviction while sampling.
            GRAM_IDLE_EVICT_MINUTES: "60",
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
        yield* Effect.forkScoped(
          Stream.runForEach(client["events.subscribe"](), (e: ServerEvent) =>
            Effect.sync(() => {
              if (e.type === "thread.status") status.set(e.threadId, e.status);
            }),
          ),
        );

        const threads: Array<ThreadId> = [];
        while (threads.length < THREADS) {
          const repo = tempRepo();
          repos.push(repo);
          // No `input`: a warm draft opens the session without sending anything.
          const thread = yield* client["thread.create"]({
            projectRoot: repo,
            checkout: { kind: "current" },
            ...(FAKE ? {} : { model: { agent: "claude", model: "haiku" } }),
            mode: "default",
          });
          threads.push(thread.id);
        }
        yield* until(
          `${THREADS} threads to go idle`,
          () => threads.every((id) => status.get(id) === "idle"),
          240_000,
          () => threads.map((id) => status.get(id)),
        );

        if (WINDOW === "listed" || WINDOW === "collapsed") {
          let registered = false;
          yield* Effect.forkScoped(
            Stream.runForEach(client["windows.watch"]({ windowId: "w1", name: "Main" }), () =>
              Effect.sync(() => {
                registered = true;
              }),
            ),
          );
          yield* until(
            "the window to register",
            () => registered,
            10_000,
            () => WINDOW,
          );
          yield* client["windows.report"]({
            windowId: "w1",
            threadIds: [],
            sidebarCollapsed: WINDOW === "collapsed",
          });
        }

        const samples: Array<Sample> = [];
        const start = Date.now();
        for (let i = 0; i < SAMPLES; i++) {
          if (i > 0) yield* Effect.sleep(SAMPLE_MS);
          samples.push(sample(server, (Date.now() - start) / 1000));
        }

        const last = samples.at(-1)!;
        const longLived = [...last.ids].filter((id) => samples.every((s) => s.ids.has(id)));
        const peaks: Record<string, number> = {};
        for (const s of samples) {
          for (const [name, count] of Object.entries(s.running)) {
            peaks[name] = Math.max(peaks[name] ?? 0, count);
          }
        }
        // Long runs list only the samples that caught something.
        const busy =
          SAMPLES > 20 ? samples.filter((s) => s.zombies.length + s.git.length > 0) : samples;
        const report = [
          `agent: ${FAKE ? "echo fake" : "claude (warm, no prompt)"}; threads: ${THREADS}; window: ${WINDOW ?? "none"}; ${SAMPLES} samples every ${SAMPLE_MS} ms`,
          "| t (s) | tree processes | claude | zombies | git |",
          "|---|---|---|---|---|",
          ...busy.map(
            (s) =>
              `| ${sampleSeconds(s)} | ${s.total} | ${s.claude} | ${s.zombies.length} | ${s.git.length} |`,
          ),
          "",
          "groups at the last sample (name [state] ← parent ← grandparent):",
          ...Object.entries(last.groups)
            .toSorted(([, a], [, b]) => b - a)
            .map(([key, count]) => `  ${count} × ${key}`),
          "",
          "peak live processes per name across samples:",
          ...Object.entries(peaks)
            .toSorted(([, a], [, b]) => b - a)
            .map(([name, count]) => `  ${name}: ${count}`),
          "",
          "zombies per sample:",
          ...busy.map((s) => `  t=${sampleSeconds(s)}: ${s.zombies.join("; ") || "none"}`),
          "",
          "git per sample:",
          ...busy.map((s) => `  t=${sampleSeconds(s)}: ${s.git.join("; ") || "none"}`),
          "",
          `present in every sample: ${longLived.length} of ${last.total}`,
        ].join("\n");
        // Vitest hides a passing test's console output, so the report also goes to a file.
        writeFileSync(OUT_FILE, `${report}\n`);
        console.log(report);
      }),
    20 * 60_000,
  );
});
