import { execFile } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";

/**
 * `gram-host run` as a background service of this user: a launchd agent on a Mac, a systemd user
 * unit on Linux. It starts at login, restarts when it stops, and logs to the host's own folder.
 */

export const LAUNCHD_LABEL = "io.github.ant1off.gram.host";
export const SYSTEMD_UNIT = "gram-host.service";

export interface ServiceCommand {
  /** The program and arguments that run the host: Node (or Electron as Node), its entry, `run`. */
  readonly program: ReadonlyArray<string>;
  /** The host's environment: its folder, the PATH its agents and git are found on. */
  readonly env: Readonly<Record<string, string>>;
  /** The host's folder, where its log goes. */
  readonly home: string;
}

/**
 * The program a service runs: this same Node and entry, with `run`. `GRAM_HOST_SERVICE` tells the
 * host it runs as its service, which it can then move to another app when it updates itself.
 */
export const serviceCommand = (home: string): ServiceCommand => {
  const entry = process.argv[1] ?? fileURLToPath(new URL("./main.ts", import.meta.url));
  return {
    program: [process.execPath, entry, "run"],
    env: {
      GRAM_HOST_HOME: home,
      GRAM_HOST_SERVICE: "1",
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      // Where it clones the repositories its workers use, when not its own folder's `repos`.
      ...(process.env["GRAM_HOST_REPOS"]
        ? { GRAM_HOST_REPOS: process.env["GRAM_HOST_REPOS"] }
        : {}),
      // Run under Electron's own binary, as a packaged app's host is, it has to be plain Node.
      ...(process.versions["electron"] === undefined ? {} : { ELECTRON_RUN_AS_NODE: "1" }),
    },
    home,
  };
};

const xml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

/** The launchd agent's property list. */
export const launchdPlist = (command: ServiceCommand): string => {
  const strings = (values: ReadonlyArray<string>) =>
    values.map((value) => `    <string>${xml(value)}</string>`).join("\n");
  const env = Object.entries(command.env)
    .map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`)
    .join("\n");
  const log = xml(join(command.home, "host.log"));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${strings(command.program)}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${log}</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
</dict>
</plist>
`;
};

/**
 * One systemd word: quoted, with its backslashes, quotes and specifiers escaped, and in a command
 * line its `$`, which systemd expands there (never in `Environment=`).
 */
const systemdWord = (text: string, command = false) => {
  const quoted = text.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
  return `"${command ? quoted.replaceAll("$", "$$$$") : quoted}"`;
};

/** The systemd user unit. */
export const systemdUnit = (command: ServiceCommand): string => {
  if ([...command.program, ...Object.values(command.env)].some((word) => /[\n\r]/.test(word)))
    throw new Error("A service path can't hold a line break.");
  const env = Object.entries(command.env)
    .map(([key, value]) => `Environment=${systemdWord(`${key}=${value}`)}`)
    .join("\n");
  return `[Unit]
Description=Gram worker host
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${command.program.map((word) => systemdWord(word, true)).join(" ")}
${env}
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`;
};

export type ServicePlatform = "darwin" | "linux";

export const servicePlatform = (platform: NodeJS.Platform = process.platform) =>
  platform === "darwin" || platform === "linux" ? platform : undefined;

/** Where the service's file goes. */
export const serviceFile = (platform: ServicePlatform, home = homedir()): string =>
  platform === "darwin"
    ? join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`)
    : join(
        process.env["XDG_CONFIG_HOME"]?.startsWith("/") === true
          ? process.env["XDG_CONFIG_HOME"]
          : join(home, ".config"),
        "systemd",
        "user",
        SYSTEMD_UNIT,
      );

interface Run {
  readonly code: number;
  readonly output: string;
}

const run = (file: string, args: ReadonlyArray<string>) =>
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

const uid = () => userInfo().uid;

/** Writes the service and starts it, replacing one already there. */
export const installService = (platform: ServicePlatform, command: ServiceCommand) =>
  Effect.gen(function* () {
    const file = serviceFile(platform);
    mkdirSync(dirname(file), { recursive: true });
    if (platform === "darwin") {
      // A service already loaded is unloaded first, so the new file is the one that runs.
      yield* run("launchctl", ["bootout", `gui/${uid()}/${LAUNCHD_LABEL}`]);
      writeFileSync(file, launchdPlist(command), { mode: 0o644 });
      yield* run("launchctl", ["bootstrap", `gui/${uid()}`, file]).pipe(
        Effect.flatMap(must("launchctl bootstrap")),
      );
      return file;
    }
    writeFileSync(file, systemdUnit(command), { mode: 0o644 });
    yield* run("systemctl", ["--user", "daemon-reload"]).pipe(
      Effect.flatMap(must("systemctl --user daemon-reload")),
    );
    yield* run("systemctl", ["--user", "enable", SYSTEMD_UNIT]).pipe(
      Effect.flatMap(must("systemctl --user enable")),
    );
    yield* run("systemctl", ["--user", "restart", SYSTEMD_UNIT]).pipe(
      Effect.flatMap(must("systemctl --user restart")),
    );
    return file;
  });

/** Stops the service and removes its file; one that isn't there is left as it is. */
export const uninstallService = (platform: ServicePlatform) =>
  Effect.gen(function* () {
    const file = serviceFile(platform);
    if (platform === "darwin") {
      yield* run("launchctl", ["bootout", `gui/${uid()}/${LAUNCHD_LABEL}`]);
      rmSync(file, { force: true });
      return;
    }
    yield* run("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]);
    rmSync(file, { force: true });
    yield* run("systemctl", ["--user", "daemon-reload"]);
  });

/** Whether the service is running now. */
export const serviceRunning = (platform: ServicePlatform) =>
  platform === "darwin"
    ? run("launchctl", ["print", `gui/${uid()}/${LAUNCHD_LABEL}`]).pipe(
        Effect.map((result) => result.code === 0 && /state = running/.test(result.output)),
      )
    : run("systemctl", ["--user", "is-active", SYSTEMD_UNIT]).pipe(
        Effect.map((result) => result.code === 0),
      );
