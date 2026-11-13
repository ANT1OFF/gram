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
import { proveToHost } from "./local-handshake.ts";
import { RUN_TOKEN_ENV, sweepRun } from "./run-sweep.ts";
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

/** Writes the service's files, replacing what an earlier release wrote, and starts it. */
export const startLocalService = (spec: LocalServiceSpec, runner: ServiceRunner = run) =>
  Effect.gen(function* () {
    const { paths, platform } = spec;
    mkdirSync(paths.folder, { recursive: true, mode: 0o700 });
    writeFileSync(paths.launcher, LAUNCHER, { mode: 0o600 });
    mkdirSync(dirname(paths.serviceFile), { recursive: true });
    // A token of this start, which everything it starts inherits, so a stop finds it all.
    const token = randomBytes(16).toString("hex");
    writeFileSync(paths.runFile, `${token}\n`, { mode: 0o600 });
    // Found again whatever happens to the data folder: moved, removed, or another Gram's.
    recordInstance(paths, spec.dataDir, platform, token);
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
  });

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
  sweep: (token: string) => Effect.Effect<{ readonly left: ReadonlyArray<number> }> = (token) =>
    sweepRun(token, platform),
  /** The run token, when its file in the data folder may be gone (`sweepAbandoned`). */
  knownToken?: string,
) =>
  Effect.gen(function* () {
    const stop =
      platform === "linux"
        ? yield* runner("systemctl", ["--user", "stop", paths.name])
        : yield* runner("launchctl", ["bootout", `${domain()}/${paths.name}`]);
    // What got away from the service's own stop: a pseudo-terminal's shell has a session of its
    // own, which launchd doesn't end, and what it put in the background can outlive it.
    const token = readRunToken(paths) ?? knownToken;
    const swept = token === undefined ? { left: [] } : yield* sweep(token);
    const state = yield* serviceState(platform, paths, runner);
    if (state === "running" || state === "unknown")
      return yield* Effect.fail(
        new Error(
          state === "running"
            ? `The service is still running after the stop (${stop.code}: ${stop.output.slice(0, 300)}).`
            : `The service manager can't say the service stopped (${stop.code}: ${stop.output.slice(0, 300)}); it may still be running.`,
        ),
      );
    if (swept.left.length > 0)
      return yield* Effect.fail(
        new Error(
          `${swept.left.length} ${swept.left.length === 1 ? "process" : "processes"} it started couldn't be ended (${swept.left.join(", ")}).`,
        ),
      );
    if (forget) {
      rmSync(paths.serviceFile, { force: true });
      forgetFiles(paths);
      // Only now, the stop confirmed: until then the instance stays findable.
      rmSync(paths.registryFile, { force: true });
      if (platform === "linux") yield* runner("systemctl", ["--user", "daemon-reload"]);
    }
  });

/** One kept-running host as the user's registry has it. */
export interface KeptHostInstance {
  readonly id: string;
  readonly platform: LocalServicePlatform;
  /** The data folder it was started for, which may since have moved or gone. */
  readonly dataDir: string;
  readonly name: string;
  readonly serviceFile: string;
  /** Its last start's run token, which a stop ends every process of. */
  readonly runToken: string;
  readonly startedAt: string;
}

const recordInstance = (
  paths: LocalServicePaths,
  dataDir: string,
  platform: LocalServicePlatform,
  runToken: string,
) => {
  mkdirSync(dirname(paths.registryFile), { recursive: true, mode: 0o700 });
  const entry: KeptHostInstance = {
    id: paths.id,
    platform,
    dataDir,
    name: paths.name,
    serviceFile: paths.serviceFile,
    runToken,
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
      const entry = JSON.parse(readFileSync(join(registry, name), "utf8")) as KeptHostInstance;
      if (
        typeof entry.dataDir === "string" &&
        typeof entry.name === "string" &&
        typeof entry.runToken === "string" &&
        `${entry.id}.json` === name
      )
        found.push(entry);
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
  sweep?: (token: string) => Effect.Effect<{ readonly left: ReadonlyArray<number> }>,
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
        instance.runToken,
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

/** The run token the service's last start was given, if one was. */
const readRunToken = (paths: LocalServicePaths): string | undefined => {
  try {
    const token = readFileSync(paths.runFile, "utf8").trim();
    return token === "" ? undefined : token;
  } catch {
    return undefined;
  }
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
    yield* Effect.tryPromise({
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
    const socket = yield* NodeSocket.fromDuplex(Effect.succeed(raw));
    return yield* connectHost(socket, { hostId: LOCAL_HOST_ID, gone: Deferred.await(ended) });
  });
