import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
  sweepAbandoned,
  systemdEnvFile,
  keptHostInstances,
  keptHostRegistry,
} from "./local-service-unit.ts";
import type { Run } from "./service.ts";
import { RUN_TOKEN_ENV } from "./run-sweep.ts";

const HOME = "/home/someone";

const answering =
  (answers: (file: string, args: ReadonlyArray<string>) => Run, calls: Array<string> = []) =>
  (file: string, args: ReadonlyArray<string>) =>
    Effect.sync(() => {
      calls.push([file, ...args].join(" "));
      return answers(file, args);
    });
const noSweep = () => Effect.succeed({ left: [] as ReadonlyArray<number> });

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
    // Never in ~/Library/LaunchAgents, which launchd loads at every login (review finding 5).
    expect(mac.serviceFile).toBe(
      `${HOME}/Library/Application Support/gram-state/local-host/${mac.name}.plist`,
    );
    expect(mac.serviceFile).not.toContain("LaunchAgents");
    // The registry is outside every data folder, so a moved one is still found.
    expect(mac.registryFile).toBe(
      `${HOME}/Library/Application Support/Gram/kept-hosts/${mac.id}.json`,
    );
    expect(release.registryFile).toBe(`${HOME}/.local/state/gram/kept-hosts/${release.id}.json`);
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
      "/data/local-host/secret",
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
      // The file's name only: the secret itself never goes into the service's definition.
      GRAM_LOCAL_HOST_SECRET_FILE: "/data/local-host/secret",
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

  it("writes a launchd agent that launchd never starts by itself, at login or after an exit", () => {
    const paths = localServicePaths("/data", "darwin", {}, HOME);
    const plist = localLaunchdPlist(paths, ["/Applications/Gram.app/x", "local"], {
      PATH: "/usr/bin",
    });
    expect(plist).toContain("<key>RunAtLoad</key>\n  <false/>");
    // Any KeepAlive condition (SuccessfulExit included) has launchd start the job once it is
    // loaded, which a login does: the review's reproduction. A one-shot job carries none.
    expect(plist).not.toContain("KeepAlive");
    expect(plist).not.toContain("SuccessfulExit");
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
          // systemd's own answer once it is stopped: `inactive`, exit 3.
          return args[1] === "is-active"
            ? { code: 3, output: "inactive" }
            : { code: 0, output: "" };
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
      // Each start gets a run token of its own, in its environment and beside it, this user's.
      const token = readFileSync(paths.runFile, "utf8").trim();
      expect(token).toMatch(/^[0-9a-f]{32}$/);
      expect(readFileSync(paths.envFile, "utf8")).toContain(`${RUN_TOKEN_ENV}="${token}"`);
      expect(statSync(paths.runFile).mode & 0o777).toBe(0o600);

      calls.length = 0;
      const swept: Array<string> = [];
      yield* stopLocalService("linux", paths, runner, true, (t) =>
        Effect.sync(() => {
          swept.push(t);
          return { left: [] };
        }),
      );
      expect(swept).toEqual([token]);
      expect(calls).toEqual([
        `systemctl --user stop ${paths.name}`,
        `systemctl --user is-active ${paths.name}`,
        "systemctl --user daemon-reload",
      ]);
      expect(() => statSync(paths.runFile)).toThrow();
      expect(() => statSync(paths.serviceFile)).toThrow();
      expect(() => statSync(paths.envFile)).toThrow();
      expect(() => statSync(paths.launcher)).toThrow();
    }),
  );

  /** Paths in a fresh folder, for `platform`. */
  const fresh = (platform: "linux" | "darwin") => {
    const root = mkdtempSync(join(tmpdir(), "gram-local-service-"));
    dirs.push(root);
    return localServicePaths(
      join(root, "data"),
      platform,
      { XDG_CONFIG_HOME: join(root, "config") },
      root,
    );
  };

  it.effect("fails a stop the service manager doesn't confirm, and keeps the files then", () =>
    Effect.gen(function* () {
      const paths = fresh("linux");
      // The review's reproduction: the stop fails and the unit is still active.
      const stillActive = answering((_file, args) =>
        args[1] === "is-active"
          ? { code: 0, output: "active" }
          : { code: 1, output: "Failed to stop" },
      );
      const running = yield* stopLocalService("linux", paths, stillActive, true, noSweep).pipe(
        Effect.flip,
      );
      expect(running.message).toContain("still running");
      // A manager that can't answer at all (systemctl missing): unknown, so not a success either.
      const silent = answering(() => ({ code: 127, output: "" }));
      const unknown = yield* stopLocalService("linux", paths, silent, true, noSweep).pipe(
        Effect.flip,
      );
      expect(unknown.message).toContain("may still be running");
      // Stopped, but something it started (by its run token) couldn't be ended.
      mkdirSync(paths.folder, { recursive: true });
      writeFileSync(paths.runFile, `${"c".repeat(32)}\n`);
      const stopped = answering((_f, args) =>
        args[1] === "is-active" ? { code: 3, output: "inactive" } : { code: 0, output: "" },
      );
      const left = yield* stopLocalService("linux", paths, stopped, true, () =>
        Effect.succeed({ left: [4242] }),
      ).pipe(Effect.flip);
      expect(left.message).toContain("4242");
      // None of these took: the service's files stay, for a stop that does.
      expect(readFileSync(paths.runFile, "utf8")).toContain("c".repeat(32));
      // launchd, with the job still loaded after its bootout.
      const mac = fresh("darwin");
      const loaded = answering((_f, args) =>
        args[0] === "print" ? { code: 0, output: "state = running" } : { code: 0, output: "" },
      );
      const macRunning = yield* stopLocalService("darwin", mac, loaded, true, noSweep).pipe(
        Effect.flip,
      );
      expect(macRunning.message).toContain("still running");
    }),
  );

  it.effect("boots a loaded launchd job out before loading the rewritten definition", () =>
    Effect.gen(function* () {
      const paths = fresh("darwin");
      const calls: Array<string> = [];
      // The review's reproduction: an earlier start's job is still loaded, so launchd would go on
      // running its cached definition. It stays known until booted out, then is gone.
      let booted = false;
      const runner = answering((_f, args) => {
        if (args[0] === "bootout") {
          booted = true;
          return { code: 0, output: "" };
        }
        if (args[0] === "print")
          return booted
            ? { code: 113, output: "Could not find service" }
            : { code: 0, output: "state = running" };
        return { code: 0, output: "" };
      }, calls);
      yield* startLocalService(
        {
          dataDir: "/data",
          platform: "darwin",
          paths,
          program: ["/Applications/Gram.app/x", "local"],
          env: { PATH: "/usr/bin" },
        },
        runner,
      );
      const verbs = calls.map((call) => call.split(" ")[1]);
      expect(verbs.indexOf("bootout")).toBeGreaterThanOrEqual(0);
      expect(verbs.indexOf("bootstrap")).toBeGreaterThan(verbs.indexOf("bootout"));
      expect(verbs.at(-1)).toBe("kickstart");
      expect(readFileSync(paths.serviceFile, "utf8")).toContain(RUN_TOKEN_ENV);
    }),
  );

  it.effect("finds and stops a host whose data folder is gone, and leaves every other alone", () =>
    Effect.gen(function* () {
      const root = mkdtempSync(join(tmpdir(), "gram-local-service-"));
      dirs.push(root);
      const env = { XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state") };
      const start = (dataDir: string) =>
        Effect.gen(function* () {
          const paths = localServicePaths(dataDir, "linux", env, root);
          mkdirSync(paths.folder, { recursive: true });
          writeFileSync(paths.secretFile, `${"d".repeat(64)}\n`);
          yield* startLocalService(
            {
              dataDir,
              platform: "linux",
              paths,
              program: ["/x", "local"],
              env: { PATH: "/usr/bin" },
            },
            answering(() => ({ code: 0, output: "" })),
          );
          return paths;
        });
      const kept = yield* start(join(root, "kept"));
      const moved = yield* start(join(root, "moved"));
      const registry = keptHostRegistry("linux", env, root);
      expect(
        keptHostInstances(registry)
          .map((i) => i.name)
          .toSorted(),
      ).toEqual([kept.name, moved.name].toSorted());
      expect(statSync(moved.registryFile).mode & 0o777).toBe(0o600);
      // The review's reproduction: the data folder is moved away while its host waits on an
      // approval, and another Gram starts.
      const movedToken = readFileSync(moved.runFile, "utf8").trim();
      renameSync(join(root, "moved"), join(root, "elsewhere"));
      const calls: Array<string> = [];
      const swept: Array<string> = [];
      const systemd = answering(
        (_f, args) =>
          args[1] === "is-active" ? { code: 3, output: "inactive" } : { code: 0, output: "" },
        calls,
      );
      const outcome = yield* sweepAbandoned("linux", systemd, env, root, (token) =>
        Effect.sync(() => {
          swept.push(token);
          return { left: [] };
        }),
      );
      expect(outcome).toEqual({ stopped: [moved.name], failed: [] });
      expect(calls).toContain(`systemctl --user stop ${moved.name}`);
      expect(calls.some((call) => call.includes(kept.name))).toBe(false);
      // Its run token came from the registry, its own file having moved with the folder.
      expect(swept).toEqual([movedToken]);
      expect(keptHostInstances(registry).map((i) => i.name)).toEqual([kept.name]);
      // One that won't stop stays in the registry, for the next start to try again.
      rmSync(kept.secretFile);
      const stuck = yield* sweepAbandoned(
        "linux",
        answering((_f, args) =>
          args[1] === "is-active" ? { code: 0, output: "active" } : { code: 1, output: "no" },
        ),
        env,
        root,
        noSweep,
      );
      expect(stuck.failed.map((f) => f.name)).toEqual([kept.name]);
      expect(keptHostInstances(registry).map((i) => i.name)).toEqual([kept.name]);
    }),
  );
});
