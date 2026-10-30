// A thread's dev servers for the Preview pane: started by name from the project's launch config,
// each on its port or the next free one (workers run many worktrees at once), their output kept to
// read back, and stopped with the thread. Starting one runs the project's own command on the
// user's computer, so the tools ask the user first (`dev-server-tools.ts`).

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isInside, realPath } from "@gram/git";
import { LINE_CHARS, makeBoundedList, makeLineCutter, TRUNCATED } from "../bounded.ts";

/** Where a project names its dev servers, first found wins. */
export const LAUNCH_FILES = [".gram/launch.json", ".claude/launch.json"] as const;

/** One server the project can start. */
export interface LaunchConfiguration {
  readonly name: string;
  readonly runtimeExecutable: string;
  readonly runtimeArgs: readonly string[];
  /** The port it listens on, `${port}` in its arguments or `PORT` in its environment. */
  readonly port: number;
  /** Relative to the checkout. */
  readonly cwd?: string | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
}

export interface LaunchConfig {
  /** The file it came from, relative to the checkout. */
  readonly file: string;
  readonly configurations: readonly LaunchConfiguration[];
}

/** Why a launch config can't be used; the message the tool returns. */
export class LaunchConfigError extends Error {}

const NAME = /^[\w .:-]{1,64}$/;
const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string" && item.length <= 2_000);

/** `raw` as launch configurations, or why not. */
export function parseLaunchConfig(raw: unknown, file: string): LaunchConfig {
  const entries = (raw as { configurations?: unknown } | null)?.configurations;
  if (!Array.isArray(entries) || entries.length === 0)
    throw new LaunchConfigError(`${file} has no "configurations".`);
  const configurations = entries.map((entry, index): LaunchConfiguration => {
    const c = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
    const where = `${file} configuration ${index + 1}`;
    if (typeof c["name"] !== "string" || !NAME.test(c["name"]))
      throw new LaunchConfigError(`${where} needs a "name" of letters, digits, spaces, . : _ -.`);
    const executable = c["runtimeExecutable"] ?? c["command"];
    if (typeof executable !== "string" || executable.trim() === "" || executable.length > 500)
      throw new LaunchConfigError(`${where} needs a "runtimeExecutable".`);
    const args = c["runtimeArgs"] ?? c["args"] ?? [];
    if (!isStrings(args) || args.length > 100)
      throw new LaunchConfigError(`${where}: "runtimeArgs" must be a list of strings.`);
    const port = c["port"];
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1_024 || port > 65_535)
      throw new LaunchConfigError(`${where} needs a "port" from 1024 to 65535.`);
    const cwd = c["cwd"];
    if (cwd !== undefined && (typeof cwd !== "string" || isAbsolute(cwd)))
      throw new LaunchConfigError(`${where}: "cwd" must be relative to the project.`);
    const env = c["env"];
    if (
      env !== undefined &&
      (typeof env !== "object" ||
        env === null ||
        !Object.values(env).every((value) => typeof value === "string"))
    )
      throw new LaunchConfigError(`${where}: "env" must map names to strings.`);
    return {
      name: c["name"],
      runtimeExecutable: executable,
      runtimeArgs: args,
      port,
      ...(cwd === undefined ? {} : { cwd }),
      ...(env === undefined ? {} : { env: env as Record<string, string> }),
    };
  });
  const names = new Set(configurations.map((c) => c.name));
  if (names.size !== configurations.length)
    throw new LaunchConfigError(`${file} names a configuration twice.`);
  return { file, configurations };
}

/** The checkout's launch config, or `undefined` when it has none. */
export async function readLaunchConfig(root: string): Promise<LaunchConfig | undefined> {
  for (const file of LAUNCH_FILES) {
    let text: string;
    try {
      text = await readFile(join(root, file), "utf8");
    } catch {
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new LaunchConfigError(`${file} isn't valid JSON.`);
    }
    return parseLaunchConfig(raw, file);
  }
  return undefined;
}

/** `${port}` in a value, replaced by the port the server got. */
const withPort = (value: string, port: number) => value.replaceAll("${port}", String(port));

/** What a start would run: the command line, folder and environment, port substituted. */
export interface ResolvedLaunch {
  readonly name: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly port: number;
  /** Identifies the command as the user approved it, port aside: a change asks again. */
  readonly fingerprint: string;
}

/** The configuration resolved for `port`, its folder inside the checkout, links resolved. */
export async function resolveLaunch(
  root: string,
  config: LaunchConfiguration,
  port: number,
): Promise<ResolvedLaunch> {
  const realRoot = await realPath(root);
  const cwd = await realPath(resolve(realRoot, config.cwd ?? ".")).catch(() => {
    throw new LaunchConfigError(`The folder ${config.cwd ?? "."} isn't there.`);
  });
  if (!isInside(realRoot, cwd))
    throw new LaunchConfigError(`"cwd" ${config.cwd} leads outside the project.`);
  const rel = relative(realRoot, cwd);
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        realRoot,
        config.runtimeExecutable,
        config.runtimeArgs,
        rel,
        Object.entries(config.env ?? {}).toSorted(),
      ]),
    )
    .digest("hex");
  return {
    name: config.name,
    executable: config.runtimeExecutable,
    args: config.runtimeArgs.map((arg) => withPort(arg, port)),
    cwd,
    env: Object.fromEntries(
      Object.entries(config.env ?? {}).map(([key, value]) => [key, withPort(value, port)]),
    ),
    port,
    fingerprint,
  };
}

/** How a log line reads: an error, a warning, or the rest. */
export type LogLevel = "error" | "warn" | "info";

export interface LogLine {
  readonly at: number;
  readonly stream: "stdout" | "stderr";
  readonly level: LogLevel;
  readonly text: string;
}

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
/** Terminal colour and title sequences, which a log line is read without. */
const ANSI = new RegExp(`${ESC}\\[[\\d;?]*[ -/]*[@-~]|${ESC}\\][^${BEL}]*${BEL}`, "g");

export const levelOf = (text: string): LogLevel =>
  /\b(error|err!|exception|fatal|failed|uncaught)\b/i.test(text)
    ? "error"
    : /\bwarn(ing)?\b/i.test(text)
      ? "warn"
      : "info";

/** The lines of `logs` at `level` or worse (`all` for every one) containing `search`. */
export function filterLogs(
  logs: readonly LogLine[],
  options: { readonly level?: LogLevel | "all"; readonly search?: string; readonly lines?: number },
): LogLine[] {
  const rank = { info: 0, warn: 1, error: 2 } as const;
  const floor = options.level === undefined || options.level === "all" ? 0 : rank[options.level];
  const needle = options.search?.toLowerCase();
  const kept = logs.filter(
    (line) =>
      rank[line.level] >= floor &&
      (needle === undefined || line.text.toLowerCase().includes(needle)),
  );
  return kept.slice(-(options.lines ?? 100));
}

/** Whether something already listens on `port` on this computer's loopback. */
const listening = (port: number, host: string) =>
  new Promise<boolean>((done) => {
    const socket = connect({ port, host });
    const finish = (open: boolean) => {
      socket.destroy();
      done(open);
    };
    // An ephemeral source port can equal the destination and connect the socket to itself.
    // That is not a listener, even though TCP reports a successful connection.
    socket.once("connect", () =>
      finish(
        socket.localPort !== socket.remotePort || socket.localAddress !== socket.remoteAddress,
      ),
    );
    socket.once("error", () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });

/** Whether `port` can be bound on loopback now. */
const bindable = (port: number) =>
  new Promise<boolean>((done) => {
    const server = createServer();
    server.once("error", () => done(false));
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () =>
      server.close(() => done(true)),
    );
  });

export const isFree = async (port: number) =>
  (await bindable(port)) && !(await listening(port, "::1"));

/**
 * The first port from `wanted` that `claim` takes and that's free, trying the next 100. A port is
 * claimed before it is probed, so a start probing at the same time passes it by; one found busy is
 * given back with `unclaim`.
 */
export async function claimPort(
  wanted: number,
  claim: (port: number) => boolean,
  unclaim: (port: number) => void,
  free: (port: number) => Promise<boolean> = isFree,
): Promise<number> {
  for (let port = wanted; port < Math.min(wanted + 100, 65_536); port++) {
    if (!claim(port)) continue;
    let ok = false;
    try {
      ok = await free(port);
    } finally {
      if (!ok) unclaim(port);
    }
    if (ok) return port;
  }
  throw new LaunchConfigError(`No free port from ${wanted} to ${wanted + 99}.`);
}

/** The first port from `wanted` that's free and not `reserved`, trying the next 100. */
export const freePort = (
  wanted: number,
  reserved: ReadonlySet<number>,
  free: (port: number) => Promise<boolean> = isFree,
): Promise<number> =>
  claimPort(
    wanted,
    (port) => !reserved.has(port),
    () => {},
    free,
  );

/** The most log lines a server keeps. */
const LOGS_KEPT = 2_000;
/** The longest log line kept, in characters (`bounded.ts`); the rest of a longer one is dropped. */
export { LINE_CHARS, TRUNCATED };
/** The most characters a server's kept log lines hold together; the oldest go first. */
export const LOG_CHARS_KEPT = 1_048_576;
/** How long a start waits for the server to answer on its port. */
const READY_MS = 30_000;
/** How often an exited server's group is checked for whether anything is left in it. */
const GROUP_POLL_MS = 1_000;
/** How long a stop waits before it kills. */
const STOP_GRACE_MS = 3_000;

export interface DevServer {
  readonly threadId: string;
  readonly name: string;
  readonly port: number;
  readonly url: string;
  readonly command: string;
  readonly startedAt: number;
  readonly pid: number | undefined;
  readonly logs: LogLine[];
  exit: { readonly code: number | null; readonly signal: string | null } | undefined;
  /**
   * The server's process group has emptied since its leader exited. A group that existed all
   * along keeps its id, so until then signalling it reaches only the server's processes; after,
   * its id may be reused by another group, which is never signalled.
   */
  groupGone: boolean;
  readonly child: ChildProcess;
}

export interface DevServerHostOptions {
  /** The environment a server starts with: the user's login-shell PATH and the server's own. */
  readonly env: () => Promise<Readonly<Record<string, string | undefined>>>;
  /** Tells the thread's port scan about a server's process. */
  readonly rooted?: ((threadId: string, pid: number) => void) | undefined;
  readonly unrooted?: ((pid: number) => void) | undefined;
  readonly free?: ((port: number) => Promise<boolean>) | undefined;
}

const keyOf = (threadId: string, name: string) => `${threadId}\u0000${name}`;

/** Every thread's dev servers, in this server process. */
export function createDevServerHost(options: DevServerHostOptions) {
  const servers = new Map<string, DevServer>();
  /** Ports given out or being given, by holder, so two starts at once never pick the same. */
  const reserved = new Map<number, symbol>();
  const holders = new Map<string, symbol>();
  /** Frees `port` only for the holder that has it, never for a later start of another thread. */
  const free = (port: number, holder: symbol | undefined) => {
    if (holder !== undefined && reserved.get(port) === holder) reserved.delete(port);
  };
  /** Thread and name pairs being started, so a second start of one waits for none. */
  const starting = new Set<string>();
  /** Pending spawns remain cancellable while the environment is being resolved. */
  const launches = new Map<string, { readonly threadId: string; cancelled: boolean }>();

  /**
   * Signals the server's whole process group (`npm run dev` and what it started), whose remainder
   * can outlive its leader, until that group has emptied; on Windows, its tree while it runs.
   */
  const kill = (server: DevServer, signal: NodeJS.Signals) => {
    if (server.pid === undefined || server.groupGone) return;
    if (process.platform === "win32") {
      // A tree is found by its root, whose id may be reused once it exits.
      if (server.exit === undefined)
        execFile("taskkill", ["/pid", String(server.pid), "/T", "/F"], () => {});
      return;
    }
    try {
      process.kill(-server.pid, signal);
    } catch {
      server.groupGone = true;
    }
  };

  /** Watches an exited leader's group until it empties, so it is never signalled after. */
  const watchGroup = (server: DevServer) => {
    if (server.pid === undefined || process.platform === "win32") {
      server.groupGone = true;
      return;
    }
    const pid = server.pid;
    const timer = setInterval(() => {
      try {
        process.kill(-pid, 0);
      } catch {
        server.groupGone = true;
        clearInterval(timer);
      }
    }, GROUP_POLL_MS);
    timer.unref();
  };

  const stopServer = async (server: DevServer) => {
    const key = keyOf(server.threadId, server.name);
    if (servers.get(key) === server) servers.delete(key);
    const exited =
      server.exit === undefined
        ? new Promise<void>((done) => server.child.once("exit", () => done()))
        : Promise.resolve();
    kill(server, "SIGTERM");
    await Promise.race([exited, new Promise((done) => setTimeout(done, STOP_GRACE_MS))]);
    // Whatever is left of the group, its leader gone or not, is killed.
    kill(server, "SIGKILL");
    free(server.port, holders.get(key));
    if (server.pid !== undefined) options.unrooted?.(server.pid);
  };

  return {
    get: (threadId: string, name: string) => servers.get(keyOf(threadId, name)),
    list: (threadId: string) => [...servers.values()].filter((s) => s.threadId === threadId),
    /**
     * Claims the thread's `name` for one start at a time; `false` when one is already starting.
     * `unclaim` ends it, whatever came of the start.
     */
    claim: (threadId: string, name: string) => {
      const key = keyOf(threadId, name);
      if (starting.has(key)) return false;
      starting.add(key);
      return true;
    },
    unclaim: (threadId: string, name: string) => void starting.delete(keyOf(threadId, name)),
    /** The port a start of `config` would get now, reserved for it until it stops. */
    reserve: async (threadId: string, config: LaunchConfiguration) => {
      const holder = Symbol(config.name);
      // Each candidate is claimed before it is probed, so a start at the same time skips it.
      const port = await claimPort(
        config.port,
        (candidate) => {
          if (reserved.has(candidate)) return false;
          reserved.set(candidate, holder);
          return true;
        },
        (candidate) => free(candidate, holder),
        options.free,
      );
      holders.set(keyOf(threadId, config.name), holder);
      return port;
    },
    release: (threadId: string, name: string, port: number) =>
      free(port, holders.get(keyOf(threadId, name))),
    /** Starts `launch` for the thread, its port already reserved, and waits for it to answer. */
    start: async (threadId: string, launch: ResolvedLaunch) => {
      const running = servers.get(keyOf(threadId, launch.name));
      if (running !== undefined && running.exit === undefined)
        throw new LaunchConfigError(`"${launch.name}" is already running.`);
      const key = keyOf(threadId, launch.name);
      if (launches.has(key)) throw new LaunchConfigError(`"${launch.name}" is already starting.`);
      const attempt = { threadId, cancelled: false };
      launches.set(key, attempt);
      try {
        const base = await options.env();
        if (attempt.cancelled)
          throw new LaunchConfigError(`"${launch.name}" launch was cancelled.`);
        const env: Record<string, string> = {};
        for (const [name, value] of Object.entries(base))
          if (value !== undefined) env[name] = value;
        Object.assign(env, launch.env, { PORT: String(launch.port) });
        const child = spawn(launch.executable, [...launch.args], {
          cwd: launch.cwd,
          env,
          detached: process.platform !== "win32",
          shell: process.platform === "win32",
          stdio: ["ignore", "pipe", "pipe"],
        });
        const server: DevServer = {
          threadId,
          name: launch.name,
          port: launch.port,
          url: `http://localhost:${launch.port}/`,
          command: [launch.executable, ...launch.args].join(" "),
          startedAt: Date.now(),
          pid: child.pid,
          logs: [],
          exit: undefined,
          groupGone: false,
          child,
        };
        servers.set(keyOf(threadId, launch.name), server);
        if (child.pid !== undefined) options.rooted?.(threadId, child.pid);
        /** Characters in `server.logs`, kept under `LOG_CHARS_KEPT` with their count under `LOGS_KEPT`. */
        const kept = makeBoundedList(server.logs, {
          maxItems: LOGS_KEPT,
          maxSize: LOG_CHARS_KEPT,
          sizeOf: (line) => line.text.length,
        });
        const log = (stream: LogLine["stream"], text: string, level = levelOf(text)) =>
          kept.push({ at: Date.now(), stream, level, text });
        for (const stream of ["stdout", "stderr"] as const) {
          // Each line is kept to `LINE_CHARS` while it is read, so a partial line never grows past it.
          const lines = makeLineCutter((partial, cut) => {
            let text = partial.replace(ANSI, "").trimEnd();
            if (cut) text = text.slice(0, LINE_CHARS - TRUNCATED.length) + TRUNCATED;
            if (text !== "") log(stream, text);
          });
          child[stream]?.setEncoding("utf8");
          child[stream]?.on("data", lines.write);
          // Output that never ended its last line is still kept.
          child[stream]?.once("end", lines.end);
        }
        child.once("error", (error) => {
          log("stderr", error.message.slice(0, LINE_CHARS), "error");
          server.exit ??= { code: null, signal: null };
        });
        const holder = holders.get(keyOf(threadId, launch.name));
        child.once("exit", (code, signal) => {
          server.exit = { code, signal };
          watchGroup(server);
          free(server.port, holder);
          if (server.pid !== undefined) options.unrooted?.(server.pid);
        });
        const deadline = Date.now() + READY_MS;
        while (Date.now() < deadline && server.exit === undefined) {
          if ((await listening(launch.port, "127.0.0.1")) || (await listening(launch.port, "::1")))
            return { server, ready: true };
          await new Promise((done) => setTimeout(done, 250));
        }
        return { server, ready: false };
      } finally {
        launches.delete(key);
      }
    },
    stop: async (threadId: string, name: string) => {
      const server = servers.get(keyOf(threadId, name));
      if (server === undefined) return false;
      await stopServer(server);
      return true;
    },
    stopThread: async (threadId: string) => {
      for (const attempt of launches.values())
        if (attempt.threadId === threadId) attempt.cancelled = true;
      await Promise.all(
        [...servers.values()].filter((s) => s.threadId === threadId).map(stopServer),
      );
    },
    stopAll: async () => {
      for (const attempt of launches.values()) attempt.cancelled = true;
      await Promise.all([...servers.values()].map(stopServer));
    },
  };
}

export type DevServerHost = ReturnType<typeof createDevServerHost>;
