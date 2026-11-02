import type { AppUpdateState, UpdateChannel } from "@gram/contracts";
import type { NativeRelease } from "@gram/shell/modules/update";
import { describe, expect, it } from "vitest";

import { CHECK_INTERVAL_MS, STARTUP_CHECK_DELAY_MS } from "./native-updates.ts";
import { createPackageUpdates } from "./package-updates.ts";

const asset = (name: string) => ({ id: 1, name, size: 10, digest: `sha256:${"a".repeat(64)}` });
const release = (version: string): NativeRelease => ({
  tag: `v${version}`,
  version,
  payload: asset(`gram_${version}_amd64.deb`),
  manifest: asset("latest-linux.yml"),
  notes: "**New.** Things.",
  publishedAt: "2026-11-02T10:00:00Z",
});

function harness(offered: NativeRelease | undefined | Error) {
  const broadcasts: AppUpdateState[] = [];
  const timers: Array<{ ms: number; run: () => void }> = [];
  const quits: string[] = [];
  let picked: NativeRelease | undefined;
  const prefs: { channel: UpdateChannel; automaticChecks?: boolean } = {
    channel: "stable",
    automaticChecks: true,
  };
  const updates = createPackageUpdates({
    feed: {
      latest: async () => {
        if (offered instanceof Error) throw offered;
        picked = offered;
        return {
          version: offered?.version ?? "1.3.1",
          files: [],
          path: "",
          sha512: "",
          releaseDate: "",
        };
      },
      picked: () => picked,
    },
    repo: "ANT1OFF/gram",
    currentVersion: "1.3.1",
    readPrefs: async () => prefs,
    timersAllowed: true,
    ordinaryQuit: () => quits.push("quit"),
    broadcast: (state) => broadcasts.push(state),
    log: () => {},
    now: () => 5_000,
    setTimeout: (run, ms) => timers.push({ ms, run }),
    setInterval: (run, ms) => timers.push({ ms, run }),
  });
  return { updates, broadcasts, timers, quits };
}

describe("createPackageUpdates (.deb)", () => {
  it("says a release is out and links to its page, and can never install", async () => {
    const { updates } = harness(release("1.4.0"));
    expect(updates.state()).toMatchObject({ target: "deb", canInstall: false });
    const state = await updates.check("stable", true);
    expect(state).toMatchObject({
      status: "available",
      target: "deb",
      canInstall: false,
      availableVersion: "1.4.0",
      releaseUrl: "https://github.com/ANT1OFF/gram/releases/tag/v1.4.0",
      releaseDate: "2026-11-02T10:00:00Z",
      checkedAt: 5_000,
    });
    // Download and install leave everything as it is: apt installs a .deb, never Gram.
    expect(await updates.download()).toBe(state);
    expect(await updates.install("1.4.0")).toBe(state);
    expect(updates.state().status).toBe("available");
    expect(updates.state().downloadedVersion).toBeNull();
  });

  it("is up to date when nothing newer carries the .deb, and says when the check failed", async () => {
    const current = harness(undefined);
    expect(await current.updates.check("stable", true)).toMatchObject({
      status: "upToDate",
      releaseUrl: null,
    });
    const failing = harness(new Error("GitHub is limiting anonymous update checks."));
    expect(await failing.updates.check("stable", true)).toMatchObject({
      status: "error",
      errorStep: "check",
      message: "GitHub is limiting anonymous update checks.",
    });
  });

  it("checks on the timers only with automatic checks on, and quits without a fence", async () => {
    const { updates, timers, quits } = harness(release("1.4.0"));
    await updates.start();
    expect(timers.map((timer) => timer.ms)).toEqual([STARTUP_CHECK_DELAY_MS, CHECK_INTERVAL_MS]);
    timers[0]!.run();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(updates.state()).toMatchObject({ status: "available", manual: false });
    expect(updates.quitNeedsFence()).toBe(false);
    await updates.quitThroughFence();
    expect(quits).toEqual(["quit"]);
  });
});
