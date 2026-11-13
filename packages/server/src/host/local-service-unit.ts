// The app's side of "Keep agents running after Gram quits": this machine's host as a service of
// this user that the app starts and connects to, and that outlives the app. A systemd user unit on
// Linux, a launchd agent on a Mac, each named for Gram's data folder, so a release and a checkout
// of Gram on one machine never share one. It isn't started at login: the app starts it, and it
// ends on its own once no app has been connected for a while with nothing running.
//
// The macOS coalition trap (see herdr's notes): a process the app spawns, even with `setsid`, stays
// in the app's coalition, which macOS can end with the app. A launchd agent the user's own launchd
// starts is in a coalition of its own, so it is started through `launchctl`, never spawned.

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createConnection, type Socket as NetSocket } from "node:net";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { HostUnavailable, LOCAL_HOST_ID } from "@gram/contracts";
import { isStrictlyInside } from "@gram/git";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Scope from "effect/Scope";
import { KEPT_TERMINALS_ENV } from "../terminal/kept.ts";
import { hostEntry } from "./child.ts";
import { macFramed, proveToHost } from "./local-handshake.ts";
import { RUN_TOKEN_ENV, sweepRun, systemScanner } from "./run-sweep.ts";
import { connectHost, type HostConnection } from "./protocol.ts";
import type { Run, ServiceRunner } from "./service.ts";

export type LocalServicePlatform = "darwin" | "linux";

export const localServicePlatform = (
  platform: NodeJS.Platform = process.platform,
): LocalServicePlatform | undefined =>
  platform === "darwin" || platform === "linux" ? platform : undefined;

/** Where one Gram's kept-running host lives: its files, its socket and its service's name. */
export interface LocalServicePaths {
  /** `local-host` in Gram's data folder: the launcher, the environment file. */
  readonly folder: string;
  readonly socket: string;
  /** The service's environment, readable by this user only. */
  readonly envFile: string;
  /** A script the service runs, which finds the host inside the app wherever it is mounted. */
  readonly launcher: string;
  /** The install's secret, which the app proves it holds to the host and the host to the app. */
  readonly secretFile: string;
  /** The token of the service's last start, which a stop ends every process of. */
  readonly runFile: string;
  /** `gram-local-host-<id>.service`, or the launchd label `io.github.ant1off.gram.local.<id>`. */
  readonly name: string;
  /** The instance's id: from its data folder, which its service's name carries. */
  readonly id: string;
  /**
   * Its entry in the user's registry of kept-running hosts, outside any data folder, so an
   * instance whose data folder was moved or removed can still be found and stopped.
   */
  readonly registryFile: string;
  /** The unit or property list file. */
  readonly serviceFile: string;
}

/** Longest Unix socket path every platform takes (macOS's 104 bytes, less its terminator). */
const SOCKET_PATH_MAX = 103;

export const localServicePaths = (
  dataDir: string,
  platform: LocalServicePlatform,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): LocalServicePaths => {
  const id = createHash("sha256").update(dataDir).digest("hex").slice(0, 10);
  const folder = join(dataDir, "local-host");
  const wanted = join(folder, "host.sock");
  // A data folder deep enough to push the socket past what the OS takes uses a private folder of
  // its own in the temporary one instead.
  const socket =
    Buffer.byteLength(wanted) <= SOCKET_PATH_MAX
      ? wanted
      : join(
          env["XDG_RUNTIME_DIR"]?.startsWith("/") ? env["XDG_RUNTIME_DIR"] : tmpdir(),
          `gram-${userInfo().uid}-${id}`,
          "host.sock",
        );
  const name =
    platform === "darwin" ? `io.github.ant1off.gram.local.${id}` : `gram-local-host-${id}.service`;
  // On macOS the definition sits in Gram's data folder, not `~/Library/LaunchAgents`, which launchd
  // loads at every login: only Gram's own `launchctl bootstrap` ever loads it.
  const serviceFile =
    platform === "darwin"
      ? join(folder, `${name}.plist`)
      : join(
          env["XDG_CONFIG_HOME"]?.startsWith("/") === true
            ? env["XDG_CONFIG_HOME"]
            : join(home, ".config"),
          "systemd",
          "user",
          name,
        );
  return {
    folder,
    socket,
    envFile: join(folder, "env"),
    launcher: join(folder, "launch.cjs"),
    secretFile: join(folder, "secret"),
    runFile: join(folder, "run"),
    name,
    id,
    registryFile: join(keptHostRegistry(platform, env, home), `${id}.json`),
    serviceFile,
  };
};

/**
 * The user's registry of kept-running hosts, one file per instance: under the XDG state folder on
 * Linux, Gram's support folder on macOS. Never in a data folder, which can move.
 */
export const keptHostRegistry = (
  platform: LocalServicePlatform,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string =>
  platform === "darwin"
    ? join(home, "Library", "Application Support", "Gram", "kept-hosts")
    : join(
        env["XDG_STATE_HOME"]?.startsWith("/") === true
          ? env["XDG_STATE_HOME"]
          : join(home, ".local", "state"),
        "gram",
        "kept-hosts",
      );

/**
 * What the service runs. From an AppImage, the app's files are mounted afresh at each start and
 * gone when it quits, so the service starts the AppImage itself with the launcher, which loads the
 * host from wherever that start mounted it. Otherwise it runs this same program and host entry.
 */
export const localServiceProgram = (
  paths: LocalServicePaths,
  env: NodeJS.ProcessEnv = process.env,
  execPath = process.execPath,
  entry = hostEntry(),
): ReadonlyArray<string> => {
  const appImage = env["APPIMAGE"];
  const appDir = env["APPDIR"];
  const fromAppImage =
    appImage !== undefined && appDir !== undefined && isStrictlyInside(appDir, execPath);
  return [
    ...(fromAppImage ? [appImage, paths.launcher] : [execPath, entry]),
    "local",
    "--socket",
    paths.socket,
  ];
};

/** The launcher an AppImage's service runs: the host from the AppImage's own mount. */
export const LAUNCHER = `// Written by Gram: runs this machine's host from the AppImage that started it.
require(require("node:path").join(process.env.APPDIR, "resources", "app.asar", "out", "server", "gram-host.js"));
`;

/**
 * The names the service's environment carries over from the app's, and nothing else: no token,
 * key or proxy (whose address can hold a password) is written to disk. Claude Code finds the
 * user's own sign-in where it keeps it, as it does from a terminal.
 */
const CARRIED = [
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "SHELL",
  "USER",
  "LOGNAME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "XDG_RUNTIME_DIR",
  "CLAUDE_CONFIG_DIR",
  // Synthetic runs: the fake agent in place of Claude Code, as the app itself was started.
  "GRAM_FAKE_AGENT",
  "GRAM_FAKE_AGENT_REPLY",
] as const;

/** Names the file holding the install's secret, in the host's environment (never the secret). */
export const LOCAL_SECRET_ENV = "GRAM_LOCAL_HOST_SECRET_FILE";

/** The service's environment. */
export const localServiceEnv = (
  keptTerminals: string | undefined,
  secretFile: string,
  env: NodeJS.ProcessEnv = process.env,
  path: string = env["PATH"] ?? "/usr/bin:/bin",
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const name of CARRIED) {
    const value = name === "PATH" ? path : env[name];
    if (value !== undefined && value !== "" && !/[\n\r]/.test(value)) out[name] = value;
  }
  out["ELECTRON_RUN_AS_NODE"] = "1";
  out[LOCAL_SECRET_ENV] = secretFile;
  if (keptTerminals !== undefined) out[KEPT_TERMINALS_ENV] = keptTerminals;
  return out;
};

/** One systemd word, quoted, its specifiers escaped, and in a command line its `$`. */
const systemdWord = (text: string, command = false) => {
  const quoted = text.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
  return `"${command ? quoted.replaceAll("$", "$$$$") : quoted}"`;
};

/**
 * The systemd user unit. No `[Install]`: it isn't started at login, only by the app. Stopping it
 * ends everything in its control group, the agents and shells it started included, so nothing is
 * left behind it.
 */
export const localSystemdUnit = (
  paths: LocalServicePaths,
  program: ReadonlyArray<string>,
  dataDir: string,
): string => {
  // systemd takes `EnvironmentFile=` as the rest of the line, unquoted: a quoted path is ignored,
  // and the host would start without its environment.
  if ([...program, dataDir, paths.envFile].some((word) => /[\n\r]/.test(word)))
    throw new Error("A service path can't hold a line break.");
  return `[Unit]
Description=Gram's own host, kept running after Gram quits (${dataDir.replaceAll("%", "%%")})

[Service]
Type=simple
ExecStart=${program.map((word) => systemdWord(word, true)).join(" ")}
EnvironmentFile=${paths.envFile.replaceAll("%", "%%")}
Restart=on-failure
RestartSec=5
# A stop's SIGTERM ends it in order, with Node's exit status for an interrupted run.
SuccessExitStatus=130 143
KillMode=control-group
TimeoutStopSec=20
`;
};

/** The environment file systemd reads: one `NAME="value"` a line. */
export const systemdEnvFile = (env: Readonly<Record<string, string>>): string =>
  Object.entries(env)
    .map(
      ([name, value]) =>
        `${name}="${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$")}"`,
    )
    .join("\n") + "\n";

const xml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

/**
 * The launchd agent: a one-shot job, started only by the app's `kickstart`. Not run at load and
 * with no `KeepAlive` (any `KeepAlive` condition, `SuccessfulExit` included, makes launchd start
 * the job when it is loaded, as at login). Its environment is in the file, this user's alone.
 */
export const localLaunchdPlist = (
  paths: LocalServicePaths,
  program: ReadonlyArray<string>,
  env: Readonly<Record<string, string>>,
): string => {
  const strings = program.map((value) => `    <string>${xml(value)}</string>`).join("\n");
  const vars = Object.entries(env)
    .map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`)
    .join("\n");
  const log = xml(join(paths.folder, "host.log"));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(paths.name)}</string>
  <key>ProgramArguments</key>
  <array>
${strings}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${vars}
  </dict>
  <key>RunAtLoad</key>
  <false/>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>AbandonProcessGroup</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${log}</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
</dict>
</plist>
`;
};

const run: ServiceRunner = (file, args) =>
  Effect.callback<Run>((resume) => {
    const child = execFile(file, [...args], { timeout: 30_000 }, (error, stdout, stderr) => {
      const code =
        error === null ? 0 : typeof error.code === "number" ? error.code : error.code ? 127 : 1;
      resume(Effect.succeed({ code, output: `${stdout}${stderr}`.trim() }));
    });
    return Effect.sync(() => child.kill());
  });

const must = (what: string) => (result: Run) =>
  result.code === 0
    ? Effect.void
    : Effect.fail(new Error(`${what} failed (${result.code}): ${result.output.slice(0, 400)}`));

const domain = () => `gui/${userInfo().uid}`;

export interface LocalServiceSpec {
  readonly dataDir: string;
  readonly platform: LocalServicePlatform;
  readonly paths: LocalServicePaths;
  readonly program: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
}

/** Ends the processes carrying any of `tokens`; fails on anything short of verified. */
export type Sweep = (tokens: ReadonlyArray<string>) => Effect.Effect<unknown, Error>;

/**
 * Writes the service's files, replacing what an earlier release wrote, and starts it. Each start's
 * run token is added to the outstanding ones, never put in place of them: an earlier run's
 * processes are cleaned up, verified, before its token is let go, here (when the service isn't
 * running, so they can only be leftovers) or by a stop. A start that fails after that keeps them.
 */
export const startLocalService = (
  spec: LocalServiceSpec,
  runner: ServiceRunner = run,
  sweep: Sweep = (tokens) => sweepRun(tokens, systemScanner(spec.platform, spec.paths.name)),
) =>
  lifecycle(
    spec.paths,
    Effect.gen(function* () {
      const { paths, platform } = spec;
      mkdirSync(paths.folder, { recursive: true, mode: 0o700 });
      writeFileSync(paths.launcher, LAUNCHER, { mode: 0o600 });
      mkdirSync(dirname(paths.serviceFile), { recursive: true });
      let outstanding = readRunTokens(paths);
      if (outstanding.length > 0) {
        const state = yield* serviceState(platform, paths, runner);
        if (state === "stopped" || state === "absent") {
          const cleaned = yield* sweep(outstanding).pipe(Effect.exit);
          if (Exit.isSuccess(cleaned)) outstanding = [];
        }
      }
      // A token of this start, which everything it starts inherits, so a stop finds it all.
      const token = randomBytes(16).toString("hex");
      // An unverified generation is never let go to make room: past the bound the start is
      // refused, and a Stop (which cleans every outstanding run up, verified) makes room again.
      if (outstanding.length >= RUNS_KEPT)
        return yield* Effect.fail(
          new Error(
            `${outstanding.length} earlier runs of the service aren't verified ended. Stop it in Settings to clean them up, then start it again.`,
          ),
        );
      outstanding = [...outstanding, token];
      writeRunTokens(paths, outstanding);
      // Found again whatever happens to the data folder: moved, removed, or another Gram's.
      recordInstance(paths, spec.dataDir, platform, outstanding);
      const env = { ...spec.env, [RUN_TOKEN_ENV]: token };
      if (platform === "linux") {
        writeFileSync(paths.envFile, systemdEnvFile(env), { mode: 0o600 });
        writeFileSync(paths.serviceFile, localSystemdUnit(paths, spec.program, spec.dataDir), {
          mode: 0o644,
        });
        yield* runner("systemctl", ["--user", "daemon-reload"]).pipe(
          Effect.flatMap(must("systemctl --user daemon-reload")),
        );
        yield* runner("systemctl", ["--user", "start", paths.name]).pipe(
          Effect.flatMap(must("systemctl --user start")),
        );
        return;
      }
      // Its environment is in the property list, so the file is this user's alone.
      writeFileSync(paths.serviceFile, localLaunchdPlist(paths, spec.program, env), {
        mode: 0o600,
      });
      // launchd keeps the definition it loaded, whatever the file says now: a job left loaded from
      // an earlier start (another release, an older environment) would run as it was. It is booted
      // out first, and only once launchd no longer has it is the new definition loaded.
      yield* runner("launchctl", ["bootout", `${domain()}/${paths.name}`]);
      yield* untilLaunchdForgets(paths, runner);
      yield* bootstrapRetrying(paths, runner);
      yield* runner("launchctl", ["kickstart", `${domain()}/${paths.name}`]).pipe(
        Effect.flatMap(must("launchctl kickstart")),
      );
    }),
  );

/** Waits, up to ten seconds, until launchd has no job by the service's label. */
const untilLaunchdForgets = (paths: LocalServicePaths, runner: ServiceRunner) =>
  Effect.gen(function* () {
    for (let i = 0; i < 50; i++) {
      const state = yield* serviceState("darwin", paths, runner);
      if (state === "absent") return;
      yield* Effect.sleep("200 millis");
    }
    return yield* Effect.fail(
      new Error(`launchd still has ${paths.name} loaded after booting it out.`),
    );
  });

/** `launchctl bootstrap`, again for a moment while launchd finishes an earlier bootout (EIO). */
const bootstrapRetrying = (paths: LocalServicePaths, runner: ServiceRunner) =>
  Effect.gen(function* () {
    let last: Run = { code: 1, output: "" };
    for (let i = 0; i < 10; i++) {
      last = yield* runner("launchctl", ["bootstrap", domain(), paths.serviceFile]);
      if (last.code === 0) return;
      yield* Effect.sleep("300 millis");
    }
    return yield* must("launchctl bootstrap")(last);
  });

/**
 * Restarts the service with the files rewritten for this release: an earlier release's host was
 * running, and nothing of a thread runs there.
 */
export const restartLocalService = (spec: LocalServiceSpec, runner: ServiceRunner = run) =>
  stopLocalService(spec.platform, spec.paths, runner, false).pipe(
    Effect.andThen(startLocalService(spec, runner)),
  );

/** What the app wrote for the service in Gram's data folder: its launcher, environment and record. */
const forgetFiles = (paths: LocalServicePaths) => {
  for (const file of [
    paths.launcher,
    paths.envFile,
    paths.runFile,
    join(paths.folder, "sessions.json"),
  ])
    rmSync(file, { force: true });
};

/**
 * Stops the service, which ends every session and shell in it, and with `forget` removes its files
 * too. A service that isn't there is left as it is.
 */
export const stopLocalService = (
  platform: LocalServicePlatform,
  paths: LocalServicePaths,
  runner: ServiceRunner = run,
  forget = true,
  sweep: Sweep = (tokens) => sweepRun(tokens, systemScanner(platform, paths.name)),
  /** Run tokens the registry knows, when the data folder's own file may be gone. */
  knownTokens: ReadonlyArray<string> = [],
  cgroupProcs: (cgroup: string) => string | undefined = readCgroupProcs,
) =>
  lifecycle(
    paths,
    Effect.gen(function* () {
      const stop =
        platform === "linux"
          ? yield* runner("systemctl", ["--user", "stop", paths.name])
          : yield* runner("launchctl", ["bootout", `${domain()}/${paths.name}`]);
      const state = yield* serviceState(platform, paths, runner);
      if (state === "running" || state === "unknown")
        return yield* Effect.fail(
          new Error(
            state === "running"
              ? `The service is still running after the stop (${stop.code}: ${stop.output.slice(0, 300)}).`
              : `The service manager can't say the service stopped (${stop.code}: ${stop.output.slice(0, 300)}); it may still be running.`,
          ),
        );
      // On Linux the unit's control group holds everything it started, whatever it did to its
      // environment, session or parent; systemd stopped all of it, and its group must now be empty.
      if (platform === "linux") yield* verifyCgroupEmpty(paths, runner, cgroupProcs);
      // What got away from the service's own stop where nothing holds it (on macOS, a pty shell's
      // session): every outstanding run's processes, by token, each ending verified. A failure
      // keeps the tokens and the records for another try.
      const tokens = [...new Set([...readRunTokens(paths), ...knownTokens])];
      if (tokens.length > 0) yield* sweep(tokens);
      writeRunTokens(paths, []);
      if (forget) {
        rmSync(paths.serviceFile, { force: true });
        forgetFiles(paths);
        // Only now, the stop confirmed: until then the instance stays findable.
        rmSync(paths.registryFile, { force: true });
        if (platform === "linux") yield* runner("systemctl", ["--user", "daemon-reload"]);
      }
    }),
  );

/** The processes in a cgroup (v2), or undefined when it no longer exists. */
const readCgroupProcs = (cgroup: string): string | undefined => {
  try {
    return readFileSync(join("/sys/fs/cgroup", cgroup, "cgroup.procs"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

/** Fails unless systemd says the unit has no control group left, or the group is empty. */
const verifyCgroupEmpty = (
  paths: LocalServicePaths,
  runner: ServiceRunner,
  cgroupProcs: (cgroup: string) => string | undefined,
) =>
  Effect.gen(function* () {
    const shown = yield* runner("systemctl", [
      "--user",
      "show",
      "-p",
      "ControlGroup",
      "--value",
      paths.name,
    ]);
    if (shown.code !== 0)
      return yield* Effect.fail(
        new Error(`systemd can't say what is left of the service (${shown.code}); try Stop again.`),
      );
    const cgroup = shown.output.trim();
    if (cgroup === "") return;
    const procs = yield* Effect.try({
      try: () => cgroupProcs(cgroup),
      catch: (error) => new Error(`Couldn't read the service's control group: ${String(error)}`),
    });
    const left = (procs ?? "").split("\n").filter((line) => line.trim() !== "");
    if (left.length > 0)
      return yield* Effect.fail(
        new Error(
          `${left.length} ${left.length === 1 ? "process is" : "processes are"} still in the service's control group (${left.join(", ")}).`,
        ),
      );
  });

/** How many runs' tokens are kept at most while their cleanup isn't verified. */
const RUNS_KEPT = 64;

/** A process's start time, which a pid reused by another process doesn't share. */
export const processStart = (pid: number): string | undefined => {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    }
    process.kill(pid, 0);
    // Elsewhere, a live pid alone: no process start time short of `ps`, which a lock can't wait on.
    return "alive";
  } catch {
    return undefined;
  }
};

interface LockOwner {
  readonly pid: number;
  readonly start: string;
  readonly nonce: string;
}

const lockOwner = (lock: string): LockOwner | undefined => {
  try {
    const owner = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")) as LockOwner;
    return typeof owner.pid === "number" && typeof owner.nonce === "string" ? owner : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Runs `effect` holding the instance's lifecycle lock, so two starts or stops never interleave, in
 * this Gram or another. The lock is a folder made atomically, with its owner (pid, the process's
 * start time and a nonce) inside. It is taken over only when that owner is verifiably gone: no
 * process with that pid and start time. A live owner keeps it however long it holds it. Releasing
 * removes the lock only while it is still the one this holder made, by its nonce, so a late
 * release never removes a successor's.
 */
export const lifecycle = <A, E, R>(
  paths: LocalServicePaths,
  effect: Effect.Effect<A, E, R>,
  options: {
    readonly waitMs?: number;
    readonly started?: (pid: number) => string | undefined;
  } = {},
) => {
  const lock = join(dirname(paths.registryFile), `${paths.id}.lock`);
  const started = options.started ?? processStart;
  const nonce = randomBytes(16).toString("hex");
  return Effect.acquireUseRelease(
    Effect.gen(function* () {
      mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
      const until = Date.now() + (options.waitMs ?? 15_000);
      while (true) {
        try {
          mkdirSync(lock, { mode: 0o700 });
          const owner: LockOwner = {
            pid: process.pid,
            start: started(process.pid) ?? "unknown",
            nonce,
          };
          writeFileSync(join(lock, "owner.json"), JSON.stringify(owner), { mode: 0o600 });
          return;
        } catch {
          const owner = lockOwner(lock);
          // Made but its owner not yet written: a holder between its two steps, alive.
          const dead = owner !== undefined && started(owner.pid) !== owner.start;
          if (dead) {
            // Moved aside first, atomically, so two takers never both remove it.
            const aside = `${lock}.gone-${randomBytes(4).toString("hex")}`;
            try {
              renameSync(lock, aside);
              if (lockOwner(aside)?.nonce === owner.nonce) rmSync(aside, { recursive: true });
              else renameSync(aside, lock);
            } catch {
              // Taken over by another meanwhile.
            }
            continue;
          }
          if (Date.now() >= until)
            return yield* Effect.fail(
              new Error(
                "Another start or stop of the kept-running host is under way; try again in a moment.",
              ),
            );
          yield* Effect.sleep("100 millis");
        }
      }
    }),
    () => effect,
    () =>
      Effect.sync(() => {
        if (lockOwner(lock)?.nonce === nonce) rmSync(lock, { recursive: true, force: true });
      }),
  );
};

export interface KeptHostInstance {
  readonly id: string;
  readonly platform: LocalServicePlatform;
  /** The data folder it was started for, which may since have moved or gone. */
  readonly dataDir: string;
  readonly name: string;
  readonly serviceFile: string;
  /** Its runs' tokens whose processes aren't yet verified ended, which a stop ends. */
  readonly runTokens: ReadonlyArray<string>;
  readonly startedAt: string;
}

const recordInstance = (
  paths: LocalServicePaths,
  dataDir: string,
  platform: LocalServicePlatform,
  runTokens: ReadonlyArray<string>,
) => {
  mkdirSync(dirname(paths.registryFile), { recursive: true, mode: 0o700 });
  const entry: KeptHostInstance = {
    id: paths.id,
    platform,
    dataDir,
    name: paths.name,
    serviceFile: paths.serviceFile,
    runTokens,
    startedAt: new Date().toISOString(),
  };
  const temporary = `${paths.registryFile}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, paths.registryFile);
};

/** Every instance in the user's registry. */
export const keptHostInstances = (registry: string): ReadonlyArray<KeptHostInstance> => {
  let names: ReadonlyArray<string>;
  try {
    names = readdirSync(registry);
  } catch {
    return [];
  }
  const found: Array<KeptHostInstance> = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(readFileSync(join(registry, name), "utf8")) as KeptHostInstance & {
        readonly runToken?: unknown;
      };
      // An entry from before generations were kept names its one token as `runToken`.
      const runTokens = Array.isArray(raw.runTokens)
        ? raw.runTokens.filter((token): token is string => typeof token === "string")
        : typeof raw.runToken === "string"
          ? [raw.runToken]
          : undefined;
      if (
        typeof raw.dataDir === "string" &&
        typeof raw.name === "string" &&
        runTokens !== undefined &&
        `${raw.id}.json` === name
      ) {
        const { runToken: _old, ...rest } = raw;
        found.push({ ...rest, runTokens });
      }
    } catch {
      // Unreadable: left for a person to look at, never acted on.
    }
  }
  return found;
};

/**
 * Whether `instance` lost its data folder: its install secret is gone, so no Gram can ever connect
 * to it again. One whose folder is there is some Gram's, closed or not, and left alone.
 */
export const abandoned = (instance: KeptHostInstance): boolean =>
  !existsSync(join(instance.dataDir, "local-host", "secret"));

/**
 * Stops and forgets every instance in the registry whose data folder is gone (moved or removed),
 * each stop verified as any other; one that won't stop stays in the registry for the next try.
 * Answers what was stopped, and what couldn't be, with why.
 */
export const sweepAbandoned = (
  platform: LocalServicePlatform,
  runner: ServiceRunner = run,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  sweep?: Sweep,
) =>
  Effect.gen(function* () {
    const stopped: Array<string> = [];
    const failed: Array<{ readonly name: string; readonly reason: string }> = [];
    for (const instance of keptHostInstances(keptHostRegistry(platform, env, home))) {
      if (instance.platform !== platform || !abandoned(instance)) continue;
      const paths = localServicePaths(instance.dataDir, platform, env, home);
      const outcome = yield* stopLocalService(
        platform,
        { ...paths, serviceFile: instance.serviceFile },
        runner,
        true,
        sweep,
        instance.runTokens,
      ).pipe(Effect.exit);
      if (Exit.isSuccess(outcome)) stopped.push(instance.name);
      else {
        const error = Cause.squash(outcome.cause);
        failed.push({
          name: instance.name,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { stopped, failed };
  });

/**
 * The service as its manager says it is: running, loaded but not running, absent, or unknown when
 * the manager couldn't answer (not there, or an answer that says neither).
 */
export const serviceState = (
  platform: LocalServicePlatform,
  paths: LocalServicePaths,
  runner: ServiceRunner = run,
): Effect.Effect<"running" | "stopped" | "absent" | "unknown"> =>
  platform === "linux"
    ? runner("systemctl", ["--user", "is-active", paths.name]).pipe(
        Effect.map((result) => {
          const state = result.output.split("\n")[0]?.trim() ?? "";
          if (
            result.code === 0 ||
            /^(active|activating|deactivating|reloading|refreshing)$/.test(state)
          )
            return "running";
          return state === "inactive" || state === "failed" ? "stopped" : "unknown";
        }),
      )
    : runner("launchctl", ["print", `${domain()}/${paths.name}`]).pipe(
        Effect.map((result) => {
          if (result.code === 0)
            return /state = running/.test(result.output) ? "running" : "stopped";
          // 113: launchd has no job by that label in this user's domain.
          return result.code === 113 || /could not find service/i.test(result.output)
            ? "absent"
            : "unknown";
        }),
      );

/** Whether the service runs now, by its manager's own answer. */
export const localServiceRunning = (
  platform: LocalServicePlatform,
  paths: LocalServicePaths,
  runner: ServiceRunner = run,
) => Effect.map(serviceState(platform, paths, runner), (state) => state === "running");

/** The tokens of the service's runs whose processes aren't yet verified ended. */
export const readRunTokens = (paths: LocalServicePaths): ReadonlyArray<string> => {
  try {
    return readFileSync(paths.runFile, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
  } catch {
    return [];
  }
};

const writeRunTokens = (paths: LocalServicePaths, tokens: ReadonlyArray<string>) => {
  mkdirSync(dirname(paths.runFile), { recursive: true, mode: 0o700 });
  const temporary = `${paths.runFile}.tmp`;
  writeFileSync(temporary, tokens.map((token) => `${token}\n`).join(""), { mode: 0o600 });
  renameSync(temporary, paths.runFile);
};

/** One connection to the socket, or the reason there is none. */
const dial = (socketPath: string) =>
  Effect.callback<NetSocket, Error>((resume) => {
    const socket = createConnection(socketPath);
    const failed = (error: Error) => resume(Effect.fail(error));
    socket.once("error", failed);
    socket.once("connect", () => {
      socket.off("error", failed);
      resume(Effect.succeed(socket));
    });
    return Effect.sync(() => socket.destroy());
  });

const asError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));

/** Dials the socket until a host answers on it, for up to `withinMs`. */
const dialWithin = (socketPath: string, withinMs: number) =>
  Effect.gen(function* () {
    const until = Date.now() + withinMs;
    while (true) {
      const attempt = yield* Effect.exit(dial(socketPath));
      if (Exit.isSuccess(attempt)) return attempt.value;
      if (Date.now() >= until) return yield* Effect.fail(asError(Cause.squash(attempt.cause)));
      yield* Effect.sleep("200 millis");
    }
  });

/**
 * Connects to the kept-running host on its socket. The connection ends with the scope, the host
 * goes on: closing the app closes only the socket.
 */
export const connectLocalService = (
  socketPath: string,
  secret: string,
  withinMs = 15_000,
): Effect.Effect<HostConnection, HostUnavailable, Scope.Scope> =>
  Effect.gen(function* () {
    const raw = yield* Effect.acquireRelease(
      dialWithin(socketPath, withinMs).pipe(
        Effect.mapError(
          (error) =>
            new HostUnavailable({
              hostId: LOCAL_HOST_ID,
              message: `The kept-running host didn't answer: ${error.message}`,
            }),
        ),
      ),
      (socket) => Effect.sync(() => socket.destroy()),
    );
    // Before any of the protocol: each side proves it holds the install's secret.
    const key = yield* Effect.tryPromise({
      try: () => proveToHost(raw, secret),
      catch: (error) =>
        new HostUnavailable({
          hostId: LOCAL_HOST_ID,
          message: error instanceof Error ? error.message : String(error),
        }),
    });
    const ended = yield* Deferred.make<never, HostUnavailable>();
    raw.once("close", () =>
      Deferred.doneUnsafe(
        ended,
        Exit.fail(
          new HostUnavailable({ hostId: LOCAL_HOST_ID, message: "The kept-running host went." }),
        ),
      ),
    );
    raw.on("error", () => {});
    // Every frame after the handshake carries this connection's MAC, both ways.
    const framed = macFramed(raw, key, "app");
    framed.on("error", () => framed.destroy());
    const socket = yield* NodeSocket.fromDuplex(Effect.succeed(framed));
    return yield* connectHost(socket, { hostId: LOCAL_HOST_ID, gone: Deferred.await(ended) });
  });
