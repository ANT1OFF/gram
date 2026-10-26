import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { UpdateProgress } from "@gram/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { UPDATE_DIR_PREFIX } from "./config.ts";
import {
  createUpdateService,
  explainUpdateFailure,
  NSIS_UPDATE_ARGS,
  type UpdateServiceOptions,
} from "./install.ts";
import type { Updater } from "./updater.ts";

let root: string | undefined;

const INTENT = { channel: "stable", tag: "v1.1.0", downgrade: false } as const;

const noop = () => {};
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

/** A verified installer in an update dir, as `downloadAndVerify` leaves it. */
function stagedInstaller(): string {
  root = mkdtempSync(join(tmpdir(), "gram-install-"));
  const dir = join(root, `${UPDATE_DIR_PREFIX}test`);
  mkdirSync(dir);
  const installer = join(dir, "Gram-1.1.0-setup.exe");
  writeFileSync(installer, "stub");
  return installer;
}

function fakeUpdater(installer: string, overrides: Partial<Updater> = {}): Updater {
  return {
    canSelfInstall: true,
    check: async () => ({ available: false, currentVersion: "1.0.0", canSelfInstall: true }),
    downloadAndVerify: async ({ tag }, onProgress) => {
      onProgress({ stage: "downloading", tag });
      onProgress({ stage: "verifying", tag });
      return installer;
    },
    ...overrides,
  };
}

/** The service over recording seams: nothing is launched, hidden or exited for real. */
function service(updater: Updater, overrides: Partial<UpdateServiceOptions> = {}) {
  const calls: string[] = [];
  const progress: UpdateProgress[] = [];
  const instance = createUpdateService({
    updater,
    stopServer: async () => void calls.push("stopServer"),
    restartServer: async () => void calls.push("restartServer"),
    broadcast: (p) => progress.push(p),
    hideWindows: () => {
      calls.push("hide");
      return () => void calls.push("show");
    },
    exit: () => void calls.push("exit"),
    spawnInstaller: async (path) => void calls.push(`spawn ${path}`),
    exitDelayMs: 0,
    ...overrides,
  });
  return { instance, calls, progress };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("NSIS_UPDATE_ARGS", () => {
  it("are the flags electron-builder's installer reads for a silent update and relaunch", () => {
    expect(NSIS_UPDATE_ARGS).toEqual(["--updated", "/S", "--force-run"]);
  });
});

describe("createUpdateService.install", () => {
  it("cancels a non-orderly stop, cleans the owned download and restores the server/windows", async () => {
    const installer = stagedInstaller();
    const { instance, calls } = service(fakeUpdater(installer), {
      stopServer: async () => {
        throw new Error("Server was forced to stop");
      },
    });
    const result = await instance.install(INTENT);
    expect(result.updating).toBe(false);
    expect(calls).toEqual(["hide", "restartServer", "show"]);
    expect(existsSync(installer)).toBe(false);
    await tick();
    expect(calls).not.toContain("exit");
  });

  it("hides the app, flushes the server, launches the installer, then exits", async () => {
    const installer = stagedInstaller();
    const { instance, calls, progress } = service(fakeUpdater(installer));

    expect(await instance.install(INTENT)).toEqual({ updating: true });
    expect(calls).toEqual(["hide", "stopServer", `spawn ${installer}`]);
    await tick();
    expect(calls.at(-1)).toBe("exit");
    expect(progress.map((p) => p.stage)).toEqual(["downloading", "verifying", "installing"]);
  });

  it("reports a refused signature without touching the app, and allows a retry", async () => {
    const installer = stagedInstaller();
    const asked: unknown[] = [];
    const { instance, calls, progress } = service(
      fakeUpdater(installer, {
        downloadAndVerify: async (intent) => {
          asked.push(intent);
          throw new Error("installer signature is not valid (status: NotSigned)");
        },
      }),
    );

    expect(await instance.install(INTENT)).toEqual({
      updating: false,
      error: "installer signature is not valid (status: NotSigned)",
    });
    expect(calls).toEqual([]);
    expect(progress.at(-1)).toMatchObject({ stage: "failed", tag: "v1.1.0" });
    await instance.install(INTENT);
    // The whole intent, so the updater re-checks the channel and downgrade, not only the tag.
    expect(asked).toEqual([INTENT, INTENT]);
  });

  it("brings the app back and removes the download when the installer can't launch", async () => {
    const installer = stagedInstaller();
    const { instance, calls } = service(fakeUpdater(installer), {
      spawnInstaller: async () => {
        throw new Error("EACCES");
      },
    });

    const result = await instance.install(INTENT);
    expect(result).toEqual({ updating: false, error: "failed to launch installer: EACCES" });
    expect(calls).toEqual(["hide", "stopServer", "restartServer", "show"]);
    expect(existsSync(installer)).toBe(false);
    await tick();
    expect(calls).not.toContain("exit");
  });

  it("still brings the windows back, and allows a retry, when the server doesn't restart", async () => {
    const installer = stagedInstaller();
    const { instance, calls } = service(fakeUpdater(installer), {
      spawnInstaller: async () => {
        throw new Error("EACCES");
      },
      restartServer: async () => {
        calls.push("restartServer");
        throw new Error("server exited with code 1 before booting");
      },
    });

    expect(await instance.install(INTENT)).toEqual({
      updating: false,
      error:
        "failed to launch installer: EACCES; the server didn't restart: server exited with code 1 before booting",
    });
    expect(calls).toEqual(["hide", "stopServer", "restartServer", "show"]);
    await tick();
    expect(calls).not.toContain("exit");
    expect(await instance.install(INTENT)).not.toMatchObject({
      error: "an install is already in progress",
    });
  });

  it("runs one install at a time", async () => {
    const installer = stagedInstaller();
    let finish: (path: string) => void = noop;
    const { instance } = service(
      fakeUpdater(installer, {
        downloadAndVerify: () => new Promise((resolve) => (finish = resolve)),
      }),
    );

    const first = instance.install(INTENT);
    expect(await instance.install(INTENT)).toEqual({
      updating: false,
      error: "an install is already in progress",
    });
    finish(installer);
    expect(await first).toEqual({ updating: true });
  });

  it("refuses where the build can't install itself", async () => {
    const installer = stagedInstaller();
    const { instance, calls } = service(fakeUpdater(installer, { canSelfInstall: false }));
    expect(await instance.install(INTENT)).toEqual({
      updating: false,
      error: "This installation can't update itself.",
    });
    expect(calls).toEqual([]);
  });
});

const coded = (message: string, code: string) => Object.assign(new Error(message), { code });
const named = (message: string, name: string) => Object.assign(new Error(message), { name });

describe("explainUpdateFailure", () => {
  it("says why a download failed on the machine or the network, and what to do", () => {
    for (const [error, text, manual] of [
      [coded("ENOSPC: no space left on device, write", "ENOSPC"), "The disk is full", false],
      [named("The operation was aborted due to timeout", "TimeoutError"), "took too long", true],
      [new Error("net::ERR_CONNECTION_RESET"), "(net::ERR_CONNECTION_RESET)", true],
      [
        Object.assign(new TypeError("fetch failed"), { cause: coded("", "ECONNREFUSED") }),
        "Couldn't reach GitHub to download the installer (ECONNREFUSED)",
        true,
      ],
      [
        coded("EBUSY: resource busy or locked", "EBUSY"),
        "(EBUSY); another process or security software may be",
        true,
      ],
      [
        new Error("the installer's SHA-256 isn't the one GitHub reports"),
        "damaged on the way",
        true,
      ],
      // The desktop's `gh release download`, whose failure is its stderr text alone.
      [
        new Error("download failed: write x.exe: There is not enough space on the disk."),
        "The disk is full",
        false,
      ],
      [
        new Error(
          'download failed: Get "https://api.github.com/x": dial tcp: lookup api.github.com: no such host',
        ),
        "Couldn't reach GitHub to download the installer (dial tcp)",
        true,
      ],
      [new Error("download failed: Command failed\ntimed out after 180 s"), "took too long", true],
      [
        new Error("download failed: open x.exe: Access is denied."),
        "The operating system refused",
        true,
      ],
    ] as const) {
      const explained = explainUpdateFailure(error);
      expect(explained.text, error.message).toContain(text);
      expect(explained.manual, error.message).toBe(manual);
    }
  });

  it("passes the updater's own refusals through, which already say why", () => {
    for (const text of [
      "1.1.0 is already installed",
      "GitHub CLI (gh) is not installed or not authenticated",
      "installer signature is not valid (status: NotSigned)",
    ]) {
      expect(explainUpdateFailure(new Error(text))).toEqual({ text, manual: false });
    }
  });
});

describe("createUpdateService failures", () => {
  it("logs the error as thrown, and shows it explained with the release page", async () => {
    const installer = stagedInstaller();
    const warnings: string[] = [];
    const { instance, progress } = service(
      fakeUpdater(installer, {
        downloadAndVerify: async () => {
          throw new Error("net::ERR_TIMED_OUT");
        },
      }),
      { warn: (message) => warnings.push(message) },
    );

    const error =
      "Couldn't reach GitHub to download the installer (net::ERR_TIMED_OUT). Check the network " +
      "connection, VPN or proxy and try again. Or install it by hand from https://github.com/ANT1OFF/gram/releases/tag/v1.1.0.";
    expect(await instance.install(INTENT)).toEqual({ updating: false, error });
    expect(progress.at(-1)).toEqual({ stage: "failed", tag: "v1.1.0", error });
    expect(warnings).toEqual(["update: installing v1.1.0 failed: net::ERR_TIMED_OUT"]);
  });

  it("explains a launch refused by antivirus from the spawn error's code, after bringing the app back", async () => {
    const installer = stagedInstaller();
    const warnings: string[] = [];
    const { instance, calls } = service(fakeUpdater(installer), {
      spawnInstaller: async () => {
        throw coded("spawn EACCES", "EACCES");
      },
      restartServer: async () => {
        calls.push("restartServer");
        throw new Error("server exited");
      },
      warn: (message) => warnings.push(message),
    });

    expect(await instance.install(INTENT)).toEqual({
      updating: false,
      error:
        "failed to launch installer: The operating system refused the update file (EACCES); another process or security software may " +
        "be using it. Try again in a minute.; the server didn't restart: " +
        "server exited Or install it by hand from https://github.com/ANT1OFF/gram/releases/tag/v1.1.0.",
    });
    expect(calls).toEqual(["hide", "stopServer", "restartServer", "show"]);
    expect(warnings).toEqual([
      "update: installing v1.1.0 failed: failed to launch installer: spawn EACCES; the server " +
        "didn't restart: server exited",
    ]);
  });
});
