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
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
  /** `gram-local-host-<id>.service`, or the launchd label `io.github.ant1off.gram.local.<id>`. */
  readonly name: string;
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
  const serviceFile =
    platform === "darwin"
      ? join(home, "Library", "LaunchAgents", `${name}.plist`)
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
    name,
    serviceFile,
  };
};

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

/** The service's environment. */
export const localServiceEnv = (
  keptTerminals: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  path: string = env["PATH"] ?? "/usr/bin:/bin",
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const name of CARRIED) {
    const value = name === "PATH" ? path : env[name];
    if (value !== undefined && value !== "" && !/[\n\r]/.test(value)) out[name] = value;
  }
  out["ELECTRON_RUN_AS_NODE"] = "1";
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
 * The launchd agent. Not run at load and not kept alive: the app kicks it off, and it ends on its
 * own. Its environment is in the file, which is this user's alone.
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
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
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
    if (platform === "linux") {
      writeFileSync(paths.envFile, systemdEnvFile(spec.env), { mode: 0o600 });
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
    writeFileSync(paths.serviceFile, localLaunchdPlist(paths, spec.program, spec.env), {
      mode: 0o600,
    });
    const loaded = yield* runner("launchctl", ["print", `${domain()}/${paths.name}`]);
    if (loaded.code !== 0)
      yield* runner("launchctl", ["bootstrap", domain(), paths.serviceFile]).pipe(
        Effect.flatMap(must("launchctl bootstrap")),
      );
    yield* runner("launchctl", ["kickstart", `${domain()}/${paths.name}`]).pipe(
      Effect.flatMap(must("launchctl kickstart")),
    );
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
  for (const file of [paths.launcher, paths.envFile, join(paths.folder, "sessions.json")])
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
) =>
  Effect.gen(function* () {
    if (platform === "linux") {
      yield* runner("systemctl", ["--user", "stop", paths.name]);
      if (forget) {
        rmSync(paths.serviceFile, { force: true });
        forgetFiles(paths);
        yield* runner("systemctl", ["--user", "daemon-reload"]);
      }
      return;
    }
    yield* runner("launchctl", ["bootout", `${domain()}/${paths.name}`]);
    if (forget) {
      rmSync(paths.serviceFile, { force: true });
      forgetFiles(paths);
    }
  });

/** Whether the service runs now, by its manager's own answer. */
export const localServiceRunning = (
  platform: LocalServicePlatform,
  paths: LocalServicePaths,
  runner: ServiceRunner = run,
) =>
  platform === "linux"
    ? runner("systemctl", ["--user", "is-active", paths.name]).pipe(
        Effect.map((result) => result.code === 0),
      )
    : runner("launchctl", ["print", `${domain()}/${paths.name}`]).pipe(
        Effect.map((result) => result.code === 0 && /state = running/.test(result.output)),
      );

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
