import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { AppUpdateState, UpdateChannel } from "@gram/contracts";
import { judgeInstallRecord, type NativeInstallRecord } from "@gram/shell/modules/update";
import { describe, expect, it } from "vitest";

import { createUpdateFinalizer } from "./finalize.ts";
import { snapshotCandidate } from "./native-snapshot.ts";
import {
  CHECK_INTERVAL_MS,
  createNativeUpdates,
  oneLine,
  PENDING_DETECTION_DEADLINE_MS,
  plainNotes,
  QUIT_DEADLINE_MS,
  STAGE_DEADLINE_MS,
  STARTUP_CHECK_DELAY_MS,
  type NativeUpdaterPort,
  type NativeUpdatesOptions,
} from "./native-updates.ts";
import type { CandidateSnapshot } from "./native-snapshot.ts";
import { UpdateTeardownRefused } from "./shutdown.ts";

const found = { version: "0.1.0-rc.18", notes: "Notes", date: "2026-10-16T10:00:00.000Z" };

/** A synthetic Electron updater and Gram around it, recording every step in order. */
function harness(
  overrides: Partial<NativeUpdatesOptions> = {},
  portOverrides: Partial<NativeUpdaterPort> = {},
) {
  const steps: string[] = [];
  const staged: CandidateSnapshot[] = [];
  let intact = true;
  /** The verified download's snapshot, as `verifyDownload` hands it over. */
  const snapshot: CandidateSnapshot = {
    path: "/private/gram-native-candidate-x/candidate.zip",
    size: 1,
    sha256: "verified-sha",
    deliver: async () => {},
    intact: async () => {
      steps.push("intact");
      return intact;
    },
    close: async () => {
      steps.push("snapshot closed");
    },
  };
  const broadcasts: AppUpdateState[] = [];
  const timers: Array<{ ms: number; run: () => void; repeat: boolean }> = [];
  let record: NativeInstallRecord | undefined;
  let prefs: { channel: UpdateChannel; automaticChecks?: boolean } = {
    channel: "prerelease",
    automaticChecks: true,
  };
  const port: NativeUpdaterPort = {
    useFeed: (channel) => steps.push(`feed ${channel}`),
    check: async () => {
      steps.push("check");
      return found;
    },
    download: async (onPercent) => {
      steps.push("download");
      onPercent(40);
      onPercent(100);
      return "/cache/gram_0.1.0-rc.18_darwin-arm64_signed.zip";
    },
    stage: async (candidate) => {
      steps.push("stage");
      staged.push(candidate);
    },
    pendingInstall: async () => {
      steps.push("pending?");
      return false;
    },
    disarm: async () => {
      steps.push("disarm");
      return true;
    },
    quitAndInstall: () => steps.push("quitAndInstall"),
    ...portOverrides,
  };
  const updates = createNativeUpdates({
    port,
    currentVersion: "0.1.0-rc.17",
    canInstall: true,
    readPrefs: async () => prefs,
    timersAllowed: true,
    verifyDownload: async (_file, version, channel) => {
      steps.push(`verify ${version} ${channel}`);
      return snapshot;
    },
    stopForUpdate: async () => {
      steps.push("stop");
    },
    transaction: async (work) => {
      steps.push("transaction");
      await work(new AbortController().signal);
    },
    recover: async () => {
      steps.push("recover");
      return undefined;
    },
    armQuit: () => steps.push("armQuit"),
    disarmQuit: () => steps.push("disarmQuit"),
    ordinaryQuit: () => {
      steps.push("ordinary quit");
    },
    exit: () => steps.push("exit"),
    hideWindows: () => {
      steps.push("hide");
      return () => steps.push("show");
    },
    record: {
      read: async () => record,
      write: async (next) => {
        steps.push(`record ${next.from}→${next.to}`);
        record = next;
      },
      remove: async () => {
        steps.push("record removed");
        record = undefined;
      },
    },
    logHint: "Log: ShipIt_stderr.log",
    judge: (next) => judgeInstallRecord(next, "0.1.0-rc.17", 2_000, "Log: ShipIt_stderr.log"),
    broadcast: (state) => broadcasts.push(state),
    log: () => {},
    now: () => 2_000,
    setTimeout: (run, ms) => {
      const timer = { ms, run, repeat: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      const index = timers.indexOf(timer as (typeof timers)[number]);
      if (index >= 0) timers.splice(index, 1);
    },
    setInterval: (run, ms) => timers.push({ ms, run, repeat: true }),
    ...overrides,
  });
  return {
    updates,
    steps,
    broadcasts,
    timers,
    setRecord: (next: NativeInstallRecord | undefined) => {
      record = next;
    },
    record: () => record,
    staged,
    snapshot,
    setIntact: (next: boolean) => {
      intact = next;
    },
    setPrefs: (next: typeof prefs) => {
      prefs = next;
    },
  };
}

async function readyHarness(
  overrides: Partial<NativeUpdatesOptions> = {},
  port: Partial<NativeUpdaterPort> = {},
) {
  const h = harness(overrides, port);
  await h.updates.start();
  await h.updates.check("prerelease", true);
  await h.updates.download();
  h.steps.length = 0;
  return h;
}

describe("checks", () => {
  it("finds an update on the channel", async () => {
    const h = harness();
    await h.updates.start();
    const state = await h.updates.check("prerelease", true);
    expect(state).toMatchObject({
      status: "available",
      availableVersion: "0.1.0-rc.18",
      releaseNotes: "Notes",
      manual: true,
      checkedAt: 2_000,
    });
    // Launch settles any install macOS has pending first: here, none.
    expect(h.steps).toEqual(["pending?", "feed prerelease", "check"]);
    expect(h.broadcasts.map((s) => s.status)).toEqual(["idle", "checking", "available"]);
  });

  it("is up to date with nothing newer, and never offers an RC on Stable", async () => {
    const none = harness({}, { check: async () => null });
    expect((await none.updates.check("stable", false)).status).toBe("upToDate");
    const rc = harness();
    expect((await rc.updates.check("stable", false)).status).toBe("upToDate");
  });

  it("shows a failure as one line", async () => {
    const failed = harness(
      {},
      {
        check: async () => {
          throw new Error(
            "Cannot find rc-mac.yml in the latest release artifacts (https://github.com/x): HttpError: 404\n    at stack",
          );
        },
      },
    );
    expect(await failed.updates.check("stable", true)).toMatchObject({
      status: "error",
      errorStep: "check",
      message: "Cannot find rc-mac.yml in the latest release artifacts: HttpError: 404",
    });
  });

  it("checks 15 s after launch and every 4 minutes, only with automatic checks on", async () => {
    const h = harness();
    await h.updates.start();
    expect(h.timers.map(({ ms, repeat }) => ({ ms, repeat }))).toEqual([
      { ms: STARTUP_CHECK_DELAY_MS, repeat: false },
      { ms: CHECK_INTERVAL_MS, repeat: true },
    ]);
    h.timers[0]!.run();
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.updates.state()).toMatchObject({ status: "available", manual: false });
    // Over an available update a timer checks again; over a ready one it doesn't.
    await h.updates.download();
    h.steps.length = 0;
    h.timers[1]!.run();
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.steps).toEqual([]);
    h.setPrefs({ channel: "prerelease", automaticChecks: false });
    const off = harness();
    off.setPrefs({ channel: "prerelease" });
    await off.updates.start();
    off.timers[0]!.run();
    await new Promise((resolve) => setImmediate(resolve));
    expect(off.steps).toEqual(["pending?"]);
  });

  it("runs no timers in smoke runs and CI", async () => {
    const h = harness({ timersAllowed: false });
    await h.updates.start();
    expect(h.timers).toEqual([]);
  });
});

describe("downloads", () => {
  it("reports progress, verifies the file and is ready", async () => {
    const h = harness();
    await h.updates.check("prerelease", true);
    const state = await h.updates.download();
    expect(state).toMatchObject({
      status: "ready",
      downloadedVersion: "0.1.0-rc.18",
      percent: 100,
    });
    expect(h.steps.slice(-2)).toEqual(["download", "verify 0.1.0-rc.18 prerelease"]);
    expect(h.broadcasts.map((s) => s.percent)).toContain(40);
  });

  it("is a download error to retry when verification fails", async () => {
    const h = harness({
      verifyDownload: async () => {
        throw new Error("The downloaded ZIP doesn't match GitHub's SHA-256 for it.");
      },
    });
    await h.updates.check("prerelease", true);
    expect(await h.updates.download()).toMatchObject({
      status: "error",
      errorStep: "download",
      availableVersion: "0.1.0-rc.18",
      downloadedVersion: null,
    });
  });

  it("does nothing with nothing available", async () => {
    const h = harness();
    expect((await h.updates.download()).status).toBe("idle");
    expect(h.steps).toEqual(["pending?"]);
  });
});

describe("install", () => {
  it("stops Gram through the fence, records the restart, then quits into the update", async () => {
    const h = await readyHarness();
    const state = await h.updates.install("0.1.0-rc.18");
    expect(state.status).toBe("installing");
    expect(h.steps).toEqual([
      "intact",
      "pending?",
      "transaction",
      "hide",
      "stop",
      "record 0.1.0-rc.17→0.1.0-rc.18",
      "stage",
      "snapshot closed",
      "armQuit",
      "quitAndInstall",
    ]);
    // If the relaunch never comes, Gram exits so Squirrel.Mac's installer runs.
    const deadline = h.timers.find((timer) => timer.ms === QUIT_DEADLINE_MS);
    deadline!.run();
    expect(h.steps.at(-1)).toBe("exit");
  });

  it("quits nothing when the fence refuses, and says why in one line", async () => {
    const h = await readyHarness({
      stopForUpdate: async () => {
        throw new UpdateTeardownRefused(
          "Update cancelled before app replacement. An agent process (a Claude Code session or the Codex app-server) did not exit cleanly when stopped. Gram remains on the running version.",
          { path: "refused", reason: "agents" },
        );
      },
    });
    const state = await h.updates.install("0.1.0-rc.18");
    expect(state).toMatchObject({
      status: "error",
      errorStep: "install",
      downloadedVersion: "0.1.0-rc.18",
      message: "Didn't restart: an agent didn't stop cleanly. Nothing was installed.",
    });
    expect(h.steps).toEqual([
      "intact",
      "pending?",
      "transaction",
      "hide",
      "disarmQuit",
      "recover",
      "record removed",
      "show",
    ]);
    expect(h.steps).not.toContain("quitAndInstall");
    expect(h.steps).not.toContain("armQuit");
    expect(h.timers.some((timer) => timer.ms === QUIT_DEADLINE_MS)).toBe(false);
    expect(h.record()).toBeUndefined();
  });

  it("names each essential the fence can refuse for", async () => {
    for (const [reason, text] of [
      ["sessions", "agent sessions didn't save in time"],
      ["database", "the database couldn't be closed"],
      ["survivor", "a server process survived its stop"],
    ] as const) {
      const h = await readyHarness({
        stopForUpdate: async () => {
          throw new UpdateTeardownRefused("long", { path: "refused", reason });
        },
      });
      expect((await h.updates.install("0.1.0-rc.18")).message).toBe(
        `Didn't restart: ${text}. Nothing was installed.`,
      );
    }
  });

  it("recovers and quits nothing when Squirrel.Mac refuses the update", async () => {
    const h = await readyHarness(
      {},
      {
        stage: async () => {
          throw new Error("Code signature at URL did not pass validation");
        },
      },
    );
    const state = await h.updates.install("0.1.0-rc.18");
    expect(state.message).toBe(
      "Didn't restart: Code signature at URL did not pass validation. Nothing was installed.",
    );
    // Squirrel.Mac was invoked, so nothing comes back until macOS shows no install pending.
    expect(h.steps).toEqual([
      "intact",
      "pending?",
      "transaction",
      "hide",
      "stop",
      "record 0.1.0-rc.17→0.1.0-rc.18",
      "disarm",
      "disarmQuit",
      "recover",
      "record removed",
      "show",
    ]);
  });

  it("is cancelled, not raced, by a quit during the restart", async () => {
    const h = await readyHarness({
      transaction: async (work) => {
        const controller = new AbortController();
        controller.abort();
        await work(controller.signal);
      },
    });
    const state = await h.updates.install("0.1.0-rc.18");
    expect(state.message).toMatch(/asked to quit; the update was cancelled/);
    expect(h.steps).not.toContain("quitAndInstall");
    expect(h.steps).toContain("recover");
  });

  it("adds what recovery couldn't bring back", async () => {
    const h = await readyHarness({
      stopForUpdate: async () => {
        throw new UpdateTeardownRefused("x", { path: "refused", reason: "teardown" });
      },
      recover: async () => "The server didn't restart: port in use.",
    });
    expect((await h.updates.install("0.1.0-rc.18")).message).toBe(
      "Didn't restart: the server didn't stop cleanly. Nothing was installed. The server didn't restart: port in use.",
    );
  });

  it("refuses without stopping anything when the channel changed or the app can't update itself", async () => {
    const moved = await readyHarness();
    moved.setPrefs({ channel: "stable" });
    expect((await moved.updates.install("0.1.0-rc.18")).message).toBe(
      "The release channel changed. Check for updates again.",
    );
    expect(moved.steps).toEqual(["snapshot closed", "record removed"]);
    const elsewhere = await readyHarness({ canInstall: false });
    expect((await elsewhere.updates.install("0.1.0-rc.18")).message).toMatch(/from Applications/);
    expect(elsewhere.steps).toEqual(["record removed"]);
  });

  it("ignores an install of anything but the ready download", async () => {
    const h = await readyHarness();
    expect((await h.updates.install("0.1.0-rc.19")).status).toBe("ready");
    expect(h.steps).toEqual([]);
  });

  it("retries after a refusal", async () => {
    let refuse = true;
    const h = await readyHarness({
      stopForUpdate: async () => {
        if (refuse) throw new UpdateTeardownRefused("x", { path: "refused", reason: "agents" });
      },
    });
    await h.updates.install("0.1.0-rc.18");
    refuse = false;
    expect((await h.updates.install("0.1.0-rc.18")).status).toBe("installing");
    expect(h.steps).toContain("quitAndInstall");
  });
});

describe("not applied", () => {
  it("says the last restart's update didn't apply, and removes the record", async () => {
    const h = harness();
    h.setRecord({ schema: 1, from: "0.1.0-rc.17", to: "0.1.0-rc.18", at: 1_000 });
    await h.updates.start();
    expect(h.updates.state().notApplied).toEqual({
      version: "0.1.0-rc.18",
      reason: "Gram restarted but macOS kept 0.1.0-rc.17. Log: ShipIt_stderr.log",
    });
    expect(h.record()).toBeUndefined();
    expect((await h.updates.dismiss()).notApplied).toBeNull();
  });

  it("says nothing when the update applied", async () => {
    const h = harness({
      judge: (next) => judgeInstallRecord(next, "0.1.0-rc.18", 2_000, ""),
    });
    h.setRecord({ schema: 1, from: "0.1.0-rc.17", to: "0.1.0-rc.18", at: 1_000 });
    await h.updates.start();
    expect(h.updates.state().notApplied).toBeNull();
    expect(h.record()).toBeUndefined();
  });
});

describe("text", () => {
  it("keeps one short line of an error", () => {
    expect(oneLine(new Error("\n  first   line\nsecond"))).toBe("first line");
    expect(oneLine(new Error("x".repeat(300)))).toHaveLength(200);
    expect(oneLine("")).toBe("Something went wrong.");
  });

  it("turns the public feed's HTML notes into plain text", () => {
    expect(plainNotes("<p>Fixes &amp; <b>speed</b></p><ul><li>One</li><li>Two</li></ul>")).toBe(
      "Fixes & speed\nOne\nTwo",
    );
    expect(
      plainNotes([
        { version: "1", note: "A" },
        { version: "2", note: "B" },
      ]),
    ).toBe("A\n\nB");
    expect(plainNotes(null)).toBeNull();
    expect(plainNotes("   ")).toBeNull();
  });
});

/** A promise and its settlers, for a stage that finishes when the test says so. */
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("Squirrel.Mac once invoked", () => {
  it("joins a stage that a quit interrupts, then quits into it: no recovery races it", async () => {
    const stage = deferred();
    const controller = new AbortController();
    const h = await readyHarness(
      {
        transaction: async (work) => {
          await work(controller.signal);
        },
      },
      { stage: () => stage.promise },
    );
    const install = h.updates.install("0.1.0-rc.18");
    await settle();
    controller.abort();
    await settle();
    expect(h.steps).not.toContain("recover");
    stage.resolve();
    expect((await install).status).toBe("installing");
    expect(h.steps).toContain("quitAndInstall");
    expect(h.steps).not.toContain("recover");
    expect(h.record()).toBeDefined();
  });

  it("waits out a slow stage without recovering, saying so, and quits once it stages", async () => {
    const stage = deferred();
    const h = await readyHarness({}, { stage: () => stage.promise });
    const install = h.updates.install("0.1.0-rc.18");
    await settle();
    h.timers.find((timer) => timer.ms === STAGE_DEADLINE_MS)!.run();
    await settle();
    expect(h.updates.state()).toMatchObject({
      status: "installing",
      message: "macOS is still preparing the update. Gram waits for it; quitting now is safe.",
    });
    expect(h.steps).toContain("show");
    expect(h.steps).not.toContain("recover");
    expect(h.record()).toBeDefined();
    stage.resolve();
    await install;
    expect(h.steps).toContain("quitAndInstall");
    expect(h.steps).not.toContain("recover");
  });

  it("recovers from a slow stage that fails only once macOS shows nothing pending", async () => {
    const stage = deferred();
    const h = await readyHarness({}, { stage: () => stage.promise });
    const install = h.updates.install("0.1.0-rc.18");
    await settle();
    h.timers.find((timer) => timer.ms === STAGE_DEADLINE_MS)!.run();
    await settle();
    stage.reject(new Error("Code signature did not pass validation"));
    expect((await install).status).toBe("error");
    expect(h.steps.indexOf("disarm")).toBeLessThan(h.steps.indexOf("recover"));
    // The quit armed while waiting is ordinary again before anything comes back.
    expect(h.steps.indexOf("armQuit")).toBeLessThan(h.steps.indexOf("disarmQuit"));
    expect(h.steps.indexOf("disarmQuit")).toBeLessThan(h.steps.indexOf("recover"));
    expect(h.steps).not.toContain("quitAndInstall");
  });

  it("stays stopped, keeping the record, when a pending install can't be removed", async () => {
    const h = await readyHarness(
      {},
      {
        stage: async () => {
          throw new Error("ShipIt request written, then failed");
        },
        disarm: async () => false,
      },
    );
    const state = await h.updates.install("0.1.0-rc.18");
    expect(state).toMatchObject({
      status: "installing",
      message:
        "macOS may still install this update when Gram quits, so Gram stays stopped. Quit Gram to finish.",
    });
    expect(h.steps).not.toContain("recover");
    expect(h.steps).not.toContain("quitAndInstall");
    // Quitting is the way out: everything is already stopped, and the record stays to explain it.
    expect(h.steps).toContain("armQuit");
    expect(h.record()).toBeDefined();
  });

  it("never invokes Squirrel.Mac after a quit during the record write", async () => {
    const controller = new AbortController();
    const h = await readyHarness({
      transaction: async (work) => {
        await work(controller.signal);
      },
      record: {
        read: async () => undefined,
        write: async () => {
          controller.abort();
        },
        remove: async () => {},
      },
    });
    const state = await h.updates.install("0.1.0-rc.18");
    expect(state.message).toMatch(/asked to quit; the update was cancelled/);
    expect(h.steps).not.toContain("stage");
    expect(h.steps).not.toContain("quitAndInstall");
    expect(h.steps).toContain("recover");
  });

  it("clears an earlier pending install before stopping anything, and refuses if it can't", async () => {
    const cleared = await readyHarness({}, { pendingInstall: async () => true });
    await cleared.updates.install("0.1.0-rc.18");
    expect(cleared.steps.slice(0, 2)).toEqual(["intact", "disarm"]);
    expect(cleared.steps).toContain("quitAndInstall");

    // One that appears after launch, macOS unable to say what it is, and that can't be removed.
    let appeared = false;
    const stuck = await readyHarness(
      {},
      {
        pendingInstall: async () => (appeared ? undefined : false),
        disarm: async () => !appeared,
      },
    );
    appeared = true;
    // Held as an update would be: the fence runs, quitting is armed, nothing is staged.
    expect(await stuck.updates.install("0.1.0-rc.18")).toMatchObject({
      status: "installing",
      message:
        "macOS has an earlier update waiting to install, so Gram has stopped. Quitting is safe and lets it install; or try again to remove it.",
    });
    expect(stuck.steps).toEqual(expect.arrayContaining(["transaction", "stop", "armQuit"]));
    expect(stuck.steps).not.toContain("stage");
    expect(stuck.steps).not.toContain("recover");
  });

  it("refuses a download whose bytes changed since they were verified, asking for it again", async () => {
    const h = await readyHarness();
    h.setIntact(false);
    expect(await h.updates.install("0.1.0-rc.18")).toMatchObject({
      status: "error",
      errorStep: "download",
      downloadedVersion: null,
      message: "The download changed since it was verified. Download it again.",
    });
    expect(h.steps).not.toContain("transaction");
  });

  it("refuses a channel change as a check to redo, not a restart to retry", async () => {
    const h = await readyHarness();
    h.setPrefs({ channel: "stable" });
    expect(await h.updates.install("0.1.0-rc.18")).toMatchObject({
      status: "error",
      errorStep: "check",
      manual: true,
    });
    const unreadable = await readyHarness({
      readPrefs: async () => {
        throw new Error("EACCES");
      },
    });
    expect((await unreadable.updates.install("0.1.0-rc.18")).message).toBe(
      "Gram couldn't read its update settings. Try again.",
    );
  });

  it("offers nothing for a restart until the download verifies", async () => {
    const h = harness({
      verifyDownload: async () => {
        throw new Error("Signed update refused: Gatekeeper does not accept it as notarized");
      },
    });
    await h.updates.start();
    await h.updates.check("prerelease", true);
    expect(await h.updates.download()).toMatchObject({
      status: "error",
      errorStep: "download",
      downloadedVersion: null,
      message: "Signed update refused: Gatekeeper does not accept it as notarized",
    });
  });
});

describe("an install macOS has pending from before", () => {
  const PENDING =
    "macOS has an earlier update waiting to install, so Gram has stopped. Quitting is safe and lets it install; or try again to remove it.";

  it("is held at launch as an update would be: the fence runs, and quitting is the way out", async () => {
    let removable = false;
    const h = harness({}, { pendingInstall: async () => true, disarm: async () => removable });
    await h.updates.start();
    expect(h.updates.state()).toMatchObject({ status: "installing", message: PENDING });
    expect(h.steps).toEqual(
      expect.arrayContaining(["transaction", "hide", "stop", "armQuit", "show"]),
    );
    expect(h.steps).not.toContain("recover");
    // No timer checks over it.
    expect(h.timers).toEqual(
      expect.arrayContaining([expect.objectContaining({ ms: STARTUP_CHECK_DELAY_MS })]),
    );
    expect((await h.updates.check("prerelease", true)).status).toBe("installing");
    // Trying again: still there, nothing changes; then gone, and everything comes back.
    expect((await h.updates.dismiss()).status).toBe("installing");
    expect(h.steps).not.toContain("recover");
    removable = true;
    expect(await h.updates.dismiss()).toMatchObject({ status: "idle", message: null });
    expect(h.steps.indexOf("disarmQuit")).toBeLessThan(h.steps.indexOf("recover"));
  });

  it("starts nothing new when a pending install appears and can't be removed", async () => {
    const h = harness({}, { pendingInstall: async () => undefined, disarm: async () => false });
    await h.updates.start();
    expect(h.updates.quitNeedsFence()).toBe(false);
    expect(h.steps).toContain("armQuit");
  });

  it("routes every quit through the fence when the fence refused, and keeps running if it refuses again", async () => {
    let refuse = true;
    const h = harness(
      {
        stopForUpdate: async () => {
          h.steps.push("stop");
          if (refuse) throw new UpdateTeardownRefused("x", { path: "refused", reason: "agents" });
        },
      },
      { pendingInstall: async () => true, disarm: async () => false },
    );
    await h.updates.start();
    // Couldn't stop safely: everything comes back, but no exit may skip the fence.
    expect(h.steps).toContain("recover");
    expect(h.steps).not.toContain("armQuit");
    expect(h.updates.quitNeedsFence()).toBe(true);
    expect(h.updates.state().message).toMatch(
      /couldn't stop safely for it \(an agent didn't stop cleanly\)/,
    );
    // A quit that the fence refuses again doesn't exit.
    await h.updates.quitThroughFence();
    expect(h.steps).not.toContain("exit");
    expect(h.updates.quitNeedsFence()).toBe(true);
    // Once the fence passes, the quit goes through.
    refuse = false;
    await h.updates.quitThroughFence();
    expect(h.steps).toContain("armQuit");
    expect(h.steps.at(-1)).toBe("exit");
    expect(h.updates.quitNeedsFence()).toBe(false);
  });
});

describe("the bytes Squirrel.Mac gets", () => {
  it("are the verified snapshot, handed to the stage itself, not a path read again", async () => {
    const h = await readyHarness();
    await h.updates.install("0.1.0-rc.18");
    expect(h.staged).toEqual([h.snapshot]);
  });

  it("are dropped with the download when a newer one replaces it", async () => {
    let checks = 0;
    const h = await readyHarness(
      {},
      {
        check: async () => ({ ...found, version: ++checks === 1 ? "0.1.0-rc.18" : "0.1.0-rc.19" }),
      },
    );
    await h.updates.check("prerelease", true);
    expect(h.updates.state().availableVersion).toBe("0.1.0-rc.19");
    await h.updates.download();
    expect(h.steps).toContain("snapshot closed");
  });
});

describe("round 3 launch and settlement", () => {
  it("fences quits synchronously, joins launch, then routes a clear result to ordinary quit", async () => {
    const probe = deferred();
    const h = harness(
      {
        ordinaryQuit: () => {
          h.steps.push("ordinary quit");
        },
      },
      {
        pendingInstall: async () => {
          await probe.promise;
          return false;
        },
      },
    );
    expect(h.updates.quitNeedsFence()).toBe(true);
    const launch = h.updates.start();
    const quit = h.updates.quitThroughFence();
    const repeatedQuit = h.updates.quitThroughFence();
    await settle();
    expect(h.steps).not.toContain("exit");
    expect(h.steps).not.toContain("ordinary quit");
    probe.resolve();
    await Promise.all([launch, quit, repeatedQuit]);
    expect(h.steps.filter((step) => step === "ordinary quit")).toHaveLength(1);
    expect(h.steps).not.toContain("exit");
    expect(h.updates.quitNeedsFence()).toBe(false);
  });

  it("joins the launch probe before check, download or install can start", async () => {
    const probe = deferred();
    const h = harness(
      {},
      {
        pendingInstall: async () => {
          await probe.promise;
          return false;
        },
      },
    );
    const launch = h.updates.start();
    const actions = [
      h.updates.check("prerelease", true),
      h.updates.download(),
      h.updates.install(found.version),
    ];
    await settle();
    expect(h.steps).not.toContain("check");
    expect(h.steps).not.toContain("download");
    expect(h.steps).not.toContain("stage");
    probe.resolve();
    await Promise.all([launch, ...actions]);
  });

  it("keeps an unknown launch result held and retries the fence before exiting", async () => {
    const probe = deferred();
    const h = harness(
      {
        stopForUpdate: async () => {
          throw new Error("agents still working");
        },
      },
      {
        pendingInstall: async () => {
          await probe.promise;
          throw new Error("probe failed");
        },
        disarm: async () => false,
      },
    );
    const launch = h.updates.start();
    const quit = h.updates.quitThroughFence();
    probe.resolve();
    await Promise.all([launch, quit]);
    expect(h.updates.quitNeedsFence()).toBe(true);
    expect(h.updates.state().message).toMatch(/couldn't stop safely/);
    expect(h.steps).not.toContain("exit");
    expect(h.steps).not.toContain("armQuit");
  });

  it("shares overlapping launch settlements without recovering the owner's deferred stop", async () => {
    const probe = deferred();
    const stop = deferred();
    const finalizer = createUpdateFinalizer();
    let probes = 0;
    let services = true;
    let armed = false;
    const h = harness(
      {
        transaction: (work) => finalizer.run(work),
        stopForUpdate: () =>
          finalizer.own(async () => {
            await stop.promise;
            services = false;
          }),
        recover: async () => {
          h.steps.push("recover");
          await finalizer.settle();
          services = true;
          finalizer.recovered();
          return undefined;
        },
        armQuit: () => {
          armed = true;
        },
        disarmQuit: () => {
          armed = false;
        },
      },
      {
        pendingInstall: async () => {
          if (++probes === 1) await probe.promise;
          return true;
        },
        disarm: async () => false,
      },
    );
    const first = h.updates.start();
    await settle();
    const second = h.updates.start();
    await settle();
    probe.resolve();
    await settle();
    stop.resolve();
    await Promise.all([first, second]);
    expect(h.steps).not.toContain("recover");
    expect(probes).toBe(1);
    expect(armed).toBe(true);
    expect(services).toBe(false);
    expect(finalizer.active()).toBe(true);
  });

  it("does not recover a transaction that refused admission before this call stopped anything", async () => {
    const h = harness(
      {
        transaction: async () => {
          throw new Error("An update transaction is already active");
        },
      },
      {
        pendingInstall: async () => true,
        disarm: async () => false,
      },
    );
    await h.updates.start();
    expect(h.steps).not.toContain("recover");
    expect(h.steps).not.toContain("disarmQuit");
    expect(h.updates.quitNeedsFence()).toBe(true);
  });

  it("disarms quit before recovering its own refused stop", async () => {
    const h = harness(
      {
        stopForUpdate: async () => {
          throw new Error("refused");
        },
      },
      {
        pendingInstall: async () => true,
        disarm: async () => false,
      },
    );
    await h.updates.start();
    expect(h.steps).toContain("disarmQuit");
    expect(h.steps.indexOf("disarmQuit")).toBeLessThan(h.steps.indexOf("recover"));
  });
});

describe("round 3 shared retries", () => {
  it("joins overlapping retries and quit through disarm and recovery, without using a stale fenced outcome", async () => {
    const disarm = deferred();
    const recovery = deferred();
    let retry = false;
    let disarms = 0;
    const h = harness(
      {
        recover: async () => {
          h.steps.push("recover");
          await recovery.promise;
          return undefined;
        },
      },
      {
        pendingInstall: async () => true,
        disarm: async () => {
          disarms++;
          if (!retry) return false;
          await disarm.promise;
          return true;
        },
      },
    );
    await h.updates.start();
    h.steps.length = 0;
    retry = true;
    const first = h.updates.dismiss();
    const second = h.updates.dismiss();
    await settle();
    const quit = h.updates.quitThroughFence();
    await settle();
    expect(disarms).toBe(2); // Launch and the one owned retry.
    expect(h.steps).not.toContain("exit");
    disarm.resolve();
    await settle();
    expect(h.steps).toEqual(["disarmQuit", "recover"]);
    recovery.resolve();
    await Promise.all([first, second, quit]);
    expect(h.steps).toEqual(["disarmQuit", "recover", "ordinary quit"]);
  });
});

describe("round 3 snapshot lifetime", () => {
  it("awaits close when a release is withdrawn, removing the real file and descriptor", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gram-snapshot-lifetime-test-"));
    let snapshot: CandidateSnapshot | undefined;
    try {
      const source = join(dir, "source.zip");
      await writeFile(source, "synthetic ZIP bytes; no provider or native installer");
      snapshot = await snapshotCandidate(source, dir);
      let offered = true;
      const h = await readyHarness(
        { verifyDownload: async () => snapshot! },
        { check: async () => (offered ? found : null) },
      );
      offered = false;
      await h.updates.check("prerelease", true);
      expect(h.updates.state().downloadedVersion).toBeNull();
      await expect(access(dirname(snapshot.path))).rejects.toThrow();
      await expect(snapshot.deliver(async () => {})).rejects.toThrow(/closed/);
    } finally {
      await snapshot?.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("closes after staging consumes the snapshot and before quitting", async () => {
    const h = await readyHarness();
    await h.updates.install(found.version);
    expect(h.steps).toContain("snapshot closed");
    expect(h.steps.indexOf("stage")).toBeLessThan(h.steps.indexOf("snapshot closed"));
    expect(h.steps.indexOf("snapshot closed")).toBeLessThan(h.steps.indexOf("quitAndInstall"));
  });

  it("closes on supersession and channel change before another download", async () => {
    let version = found.version;
    const h = await readyHarness({}, { check: async () => ({ ...found, version }) });
    version = "0.1.0-rc.19";
    await h.updates.check("prerelease", true);
    expect(h.steps).toContain("snapshot closed");
    const moved = await readyHarness();
    moved.setPrefs({ channel: "stable" });
    await moved.updates.install(found.version);
    expect(moved.steps).toContain("snapshot closed");
  });

  it("retains the snapshot for retryable refusal, then disposes it on ordinary quit", async () => {
    const h = await readyHarness({
      stopForUpdate: async () => {
        throw new Error("refused");
      },
    });
    await h.updates.install(found.version);
    expect(h.steps).not.toContain("snapshot closed");
    await h.updates.dispose();
    await h.updates.dispose();
    expect(h.steps.filter((step) => step === "snapshot closed")).toHaveLength(1);
  });
});

describe("round 3 disposal races", () => {
  it("cannot recover a retry after a fenced quit has committed disposal", async () => {
    const disarm = deferred();
    let retry = false;
    const h = harness(
      {},
      {
        pendingInstall: async () => true,
        disarm: async () => {
          if (!retry) return false;
          await disarm.promise;
          return true;
        },
      },
    );
    await h.updates.start();
    retry = true;
    const recovery = h.updates.dismiss();
    await settle();
    await h.updates.dispose();
    disarm.resolve();
    await recovery;
    expect(h.steps).not.toContain("disarmQuit");
    expect(h.steps).not.toContain("recover");
    expect(h.updates.state().status).toBe("installing");
  });

  it("joins a close already in progress on supersession when quit disposes again", async () => {
    const close = deferred();
    let offered = true;
    const h = await readyHarness({}, { check: async () => (offered ? found : null) });
    h.snapshot.close = () => close.promise;
    offered = false;
    const check = h.updates.check("prerelease", true);
    await settle();
    let disposed = false;
    const disposal = h.updates.dispose().then(() => {
      disposed = true;
    });
    await settle();
    expect(disposed).toBe(false);
    close.resolve();
    await Promise.all([check, disposal]);
    expect(disposed).toBe(true);
  });

  it("closes a download verified after disposal instead of publishing it", async () => {
    const verify = deferred();
    const h = harness({
      verifyDownload: async () => {
        await verify.promise;
        return h.snapshot;
      },
    });
    await h.updates.check("prerelease", true);
    const download = h.updates.download();
    await settle();
    await h.updates.dispose();
    verify.resolve();
    await download;
    expect(h.steps).toContain("snapshot closed");
    expect(h.broadcasts.some((state) => state.status === "ready")).toBe(false);
  });

  it("keeps an unresolved stage's descriptor alive through disposal, then closes on its outcome", async () => {
    const stage = deferred();
    const h = await readyHarness({}, { stage: () => stage.promise });
    const install = h.updates.install(found.version);
    await settle();
    await h.updates.dispose();
    expect(h.steps).not.toContain("snapshot closed");
    stage.resolve();
    await install;
    expect(h.steps.filter((step) => step === "snapshot closed")).toHaveLength(1);
  });
});

describe("R4-1 bounded pending detection", () => {
  it("also bounds detection before a restart and lets quit join that owner without staging", async () => {
    let hangs = false;
    const h = await readyHarness(
      {},
      { pendingInstall: () => (hangs ? new Promise(() => {}) : Promise.resolve(false)) },
    );
    hangs = true;
    const install = h.updates.install(found.version);
    await settle();
    const quit = h.updates.quitThroughFence();
    const deadline = h.timers.find((timer) => timer.ms === PENDING_DETECTION_DEADLINE_MS);
    expect(deadline).toBeDefined();
    deadline!.run();
    await Promise.all([install, quit]);
    expect(h.steps).toContain("stop");
    expect(h.steps).toContain("armQuit");
    expect(h.steps).toContain("exit");
    expect(h.steps).not.toContain("stage");
    expect(h.steps).not.toContain("ordinary quit");
    expect(h.steps).not.toContain("recover");
  });

  it("bounds a never-settling launch probe, then joins the actual fence before either quit exits", async () => {
    const stop = deferred();
    const finalizer = createUpdateFinalizer();
    let services = true;
    let launchDone = false;
    let quitDone = false;
    const h = harness(
      {
        transaction: (work) => finalizer.run(work),
        stopForUpdate: () =>
          finalizer.own(async () => {
            h.steps.push("stop");
            await stop.promise;
            services = false;
          }),
      },
      { pendingInstall: () => new Promise(() => {}) },
    );
    const launch = h.updates.start().then(() => {
      launchDone = true;
    });
    const quit = h.updates.quitThroughFence().then(() => {
      quitDone = true;
    });
    const repeated = h.updates.quitThroughFence();
    await settle();
    expect(launchDone).toBe(false);
    expect(quitDone).toBe(false);
    expect(h.steps).not.toContain("stop");
    const deadline = h.timers.find((timer) => timer.ms === PENDING_DETECTION_DEADLINE_MS);
    expect(deadline).toBeDefined();
    deadline!.run();
    await settle();
    expect(h.steps).toContain("stop");
    expect(services).toBe(true);
    expect(h.steps).not.toContain("exit");
    expect(h.steps).not.toContain("ordinary quit");
    stop.resolve();
    await Promise.all([launch, quit, repeated]);
    expect(launchDone).toBe(true);
    expect(quitDone).toBe(true);
    expect(services).toBe(false);
    expect(finalizer.active()).toBe(true);
    expect(h.steps.filter((step) => step === "exit")).toHaveLength(1);
    expect(h.steps).not.toContain("recover");
    expect(h.steps).not.toContain("ordinary quit");
  });

  it("resolves launch into a visible held state when the timeout's fence refuses, and allows a later fenced quit", async () => {
    let refuses = true;
    const h = harness(
      {
        stopForUpdate: async () => {
          h.steps.push("stop");
          if (refuses)
            throw new UpdateTeardownRefused("working agent", { path: "refused", reason: "agents" });
        },
      },
      { pendingInstall: () => new Promise(() => {}) },
    );
    const launch = h.updates.start();
    const quit = h.updates.quitThroughFence();
    await settle();
    const deadline = h.timers.find((timer) => timer.ms === PENDING_DETECTION_DEADLINE_MS);
    expect(deadline).toBeDefined();
    deadline!.run();
    await Promise.all([launch, quit]);
    expect(h.updates.state().message).toMatch(/couldn't stop safely/);
    expect(h.updates.quitNeedsFence()).toBe(true);
    expect(h.steps).not.toContain("exit");
    expect(h.steps).not.toContain("ordinary quit");
    refuses = false;
    await h.updates.quitThroughFence();
    expect(h.steps).toContain("armQuit");
    expect(h.steps.at(-1)).toBe("exit");
  });

  it("ignores a probe reporting clear after the deadline fenced services", async () => {
    const probe = deferred();
    const h = harness(
      {},
      {
        pendingInstall: async () => {
          await probe.promise;
          return false;
        },
      },
    );
    const launch = h.updates.start();
    await settle();
    const deadline = h.timers.find((timer) => timer.ms === PENDING_DETECTION_DEADLINE_MS);
    expect(deadline).toBeDefined();
    deadline!.run();
    await launch;
    expect(h.steps).toContain("armQuit");
    expect(h.steps).not.toContain("disarm");
    probe.resolve();
    await settle();
    expect(h.updates.state().status).toBe("installing");
    expect(h.steps).not.toContain("disarmQuit");
    expect(h.steps).not.toContain("recover");
  });

  it("bounds a hung disarm and joins its actual late outcome on retry without overlapping native mutations", async () => {
    const disarm = deferred();
    let calls = 0;
    const h = harness(
      {},
      {
        pendingInstall: async () => true,
        disarm: async () => {
          calls++;
          await disarm.promise;
          return true;
        },
      },
    );
    const launch = h.updates.start();
    await settle();
    const deadline = h.timers.find((timer) => timer.ms === PENDING_DETECTION_DEADLINE_MS);
    expect(deadline).toBeDefined();
    deadline!.run();
    await launch;
    expect(h.steps).toContain("armQuit");
    const retry = h.updates.dismiss();
    await settle();
    expect(calls).toBe(1);
    const retryDeadline = h.timers.find((timer) => timer.ms === PENDING_DETECTION_DEADLINE_MS);
    expect(retryDeadline).toBeDefined();
    retryDeadline!.run();
    await retry;
    disarm.resolve();
    await settle();
    expect(h.steps).not.toContain("recover");
    expect(h.steps).not.toContain("disarmQuit");
    expect(h.updates.state().status).toBe("installing");
    await h.updates.dismiss();
    expect(h.steps).toContain("recover");
    expect(h.steps.indexOf("disarmQuit")).toBeLessThan(h.steps.indexOf("recover"));
  });
});
