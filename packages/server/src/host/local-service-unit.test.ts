import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterEach } from "vitest";
import { KEPT_TERMINALS_ENV } from "../terminal/kept.ts";
import {
  LAUNCHER,
  localLaunchdPlist,
  localServiceEnv,
  localServicePaths,
  localServiceProgram,
  localSystemdUnit,
  startLocalService,
  stopLocalService,
  systemdEnvFile,
} from "./local-service-unit.ts";
import type { Run } from "./service.ts";

const HOME = "/home/someone";

describe("the kept-running host's service", () => {
  it("is named for its data folder, so a release and a checkout never share one", () => {
    const release = localServicePaths(`${HOME}/.local/share/gram-state`, "linux", {}, HOME);
    const checkout = localServicePaths("/work/gram/.dev-data", "linux", {}, HOME);
    expect(release.name).toMatch(/^gram-local-host-[0-9a-f]{10}\.service$/);
    expect(checkout.name).not.toBe(release.name);
    expect(release.serviceFile).toBe(`${HOME}/.config/systemd/user/${release.name}`);
    expect(release.socket).toBe(`${HOME}/.local/share/gram-state/local-host/host.sock`);
    const mac = localServicePaths(
      `${HOME}/Library/Application Support/gram-state`,
      "darwin",
      {},
      HOME,
    );
    expect(mac.name).toMatch(/^io\.github\.ant1off\.gram\.local\.[0-9a-f]{10}$/);
    expect(mac.serviceFile).toBe(`${HOME}/Library/LaunchAgents/${mac.name}.plist`);
  });

  it("moves a socket too deep for the OS to the runtime folder", () => {
    const deep = `/data/${"nested/".repeat(20)}gram-state`;
    const paths = localServicePaths(deep, "linux", { XDG_RUNTIME_DIR: "/run/user/1000" }, HOME);
    expect(Buffer.byteLength(paths.socket)).toBeLessThanOrEqual(103);
    expect(paths.socket).toMatch(/^\/run\/user\/1000\/gram-\d+-[0-9a-f]{10}\/host\.sock$/);
  });

  it("starts an AppImage's host from the AppImage itself, which a quit app unmounts", () => {
    const paths = localServicePaths("/data", "linux", {}, HOME);
    expect(
      localServiceProgram(
        paths,
        { APPIMAGE: "/apps/Gram.AppImage", APPDIR: "/tmp/.mount_gramX" },
        "/tmp/.mount_gramX/gram",
        "/tmp/.mount_gramX/resources/app.asar/out/server/gram-host.js",
      ),
    ).toEqual(["/apps/Gram.AppImage", paths.launcher, "local", "--socket", paths.socket]);
    expect(LAUNCHER).toContain("process.env.APPDIR");
    // Installed anywhere else, its own program and entry, which stay where they are.
    expect(localServiceProgram(paths, {}, "/opt/Gram/gram", "/opt/Gram/resources/x.js")).toEqual([
      "/opt/Gram/gram",
      "/opt/Gram/resources/x.js",
      "local",
      "--socket",
      paths.socket,
    ]);
  });

  it("carries over only names it lists: no token, key or proxy is written to disk", () => {
    const env = localServiceEnv(
      "/data/kept-terminals",
      {
        PATH: "/ignored",
        LANG: "C.UTF-8",
        HOME,
        ANTHROPIC_API_KEY: "sk-ant-synthetic",
        CLAUDE_CODE_OAUTH_TOKEN: "synthetic",
        GH_TOKEN: "synthetic",
        HTTPS_PROXY: "http://user:secret@proxy.test:3128",
        CLAUDE_CONFIG_DIR: "/home/someone/.claude",
        WITH_BREAK: "a\nb",
        GRAM_FAKE_AGENT: "1",
      },
      "/usr/local/bin:/usr/bin",
    );
    expect(env).toEqual({
      PATH: "/usr/local/bin:/usr/bin",
      LANG: "C.UTF-8",
      CLAUDE_CONFIG_DIR: "/home/someone/.claude",
      GRAM_FAKE_AGENT: "1",
      ELECTRON_RUN_AS_NODE: "1",
      [KEPT_TERMINALS_ENV]: "/data/kept-terminals",
    });
  });

  it("writes a unit that isn't started at login and takes everything it started with it", () => {
    const paths = localServicePaths("/data/100%", "linux", {}, HOME);
    const unit = localSystemdUnit(paths, ["/opt/Gram/gram", "/x/$HOME.js", "local"], "/data/100%");
    expect(unit).not.toContain("[Install]");
    expect(unit).not.toContain("WantedBy");
    expect(unit).toContain("KillMode=control-group");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain(`\nEnvironmentFile=${paths.envFile.replaceAll("%", "%%")}\n`);
    // `$` and `%` reach the program as written, not expanded by systemd.
    expect(unit).toContain('"/x/$$HOME.js"');
    expect(unit).toContain("(/data/100%%)");
    expect(() => localSystemdUnit(paths, ["/a\nb"], "/data")).toThrow();
    expect(systemdEnvFile({ PATH: '/a b/"q"/$x' })).toBe('PATH="/a b/\\"q\\"/\\$x"\n');
  });

  it("writes a launchd agent that isn't run at load or kept alive after a clean end", () => {
    const paths = localServicePaths("/data", "darwin", {}, HOME);
    const plist = localLaunchdPlist(paths, ["/Applications/Gram.app/x", "local"], {
      PATH: "/usr/bin",
    });
    expect(plist).toContain("<key>RunAtLoad</key>\n  <false/>");
    expect(plist).toContain("<key>SuccessfulExit</key>\n    <false/>");
    expect(plist).toContain("<key>AbandonProcessGroup</key>\n  <false/>");
    expect(plist).toContain(`<string>${paths.name}</string>`);
  });

  const dirs: Array<string> = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it.effect("is started and stopped through the service manager, its files this user's", () =>
    Effect.gen(function* () {
      const root = mkdtempSync(join(tmpdir(), "gram-local-service-"));
      dirs.push(root);
      const paths = localServicePaths(
        join(root, "data"),
        "linux",
        { XDG_CONFIG_HOME: join(root, "config") },
        root,
      );
      const calls: Array<string> = [];
      const runner = (file: string, args: ReadonlyArray<string>) =>
        Effect.sync((): Run => {
          calls.push([file, ...args].join(" "));
          return { code: 0, output: "" };
        });
      yield* startLocalService(
        {
          dataDir: join(root, "data"),
          platform: "linux",
          paths,
          program: ["/opt/Gram/gram", "/x.js", "local", "--socket", paths.socket],
          env: { PATH: "/usr/bin" },
        },
        runner,
      );
      expect(calls).toEqual([
        "systemctl --user daemon-reload",
        `systemctl --user start ${paths.name}`,
      ]);
      expect(statSync(paths.envFile).mode & 0o777).toBe(0o600);
      expect(statSync(paths.folder).mode & 0o777).toBe(0o700);
      expect(readFileSync(paths.serviceFile, "utf8")).toContain("ExecStart=");

      calls.length = 0;
      yield* stopLocalService("linux", paths, runner);
      expect(calls).toEqual([
        `systemctl --user stop ${paths.name}`,
        "systemctl --user daemon-reload",
      ]);
      expect(() => statSync(paths.serviceFile)).toThrow();
      expect(() => statSync(paths.envFile)).toThrow();
      expect(() => statSync(paths.launcher)).toThrow();
    }),
  );
});
