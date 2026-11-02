import { describe, expect, it } from "vitest";

import { createAppImageUpdaterPort } from "./appimage-port.ts";
import type { ReleaseFeed } from "./native-feed.ts";
import type { CandidateSnapshot } from "./native-snapshot.ts";

const feed: ReleaseFeed = {
  latest: async () => ({ version: "1.3.1", files: [], path: "", sha512: "", releaseDate: "" }),
  assetUrl: () => new URL("https://example.invalid/"),
  picked: () => undefined,
  pickedSha512: () => undefined,
};

/** A synthetic electron-updater AppImageUpdater, recording what the port asks of it. */
function fakeUpdater() {
  const calls: string[] = [];
  const listeners = new Map<string, (info: { percent: number }) => void>();
  const updater = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    autoRunAppAfterInstall: true,
    disableDifferentialDownload: false,
    fullChangelog: true,
    logger: null as unknown,
    channel: null as string | null,
    allowPrerelease: true,
    allowDowngrade: true,
    setFeedURL: (options: unknown) => {
      calls.push(`feed ${(options as { channel: string }).channel}`);
    },
    checkForUpdates: async () => {
      calls.push("check");
      return {
        isUpdateAvailable: true,
        updateInfo: {
          version: "1.4.0",
          releaseNotes: "<p>Notes</p>",
          releaseDate: "2026-11-02T10:00:00.000Z",
          files: [],
          path: "",
          sha512: "",
        },
      };
    },
    downloadUpdate: async () => {
      calls.push("download");
      listeners.get("download-progress")?.({ percent: 50 });
      return ["/cache/gram-updater/pending/gram_1.4.0_x86_64.AppImage"];
    },
    on: (event: string, listener: (info: { percent: number }) => void) => {
      listeners.set(event, listener);
    },
    off: (event: string) => {
      listeners.delete(event);
    },
    quitAndInstall: () => {
      calls.push("electron-updater quitAndInstall");
    },
  };
  return { updater, calls };
}

describe("createAppImageUpdaterPort", () => {
  it("never lets electron-updater download, install or relaunch on its own, nor downgrade", () => {
    const { updater } = fakeUpdater();
    const port = createAppImageUpdaterPort({
      feed,
      appImage: "/home/u/Gram.AppImage",
      relaunch: () => {},
      log: () => {},
      updater: updater as never,
    });
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.autoRunAppAfterInstall).toBe(false);
    expect(updater.disableDifferentialDownload).toBe(true);
    for (const channel of ["stable", "prerelease"] as const) {
      port.useFeed(channel);
      expect(updater.allowDowngrade).toBe(false);
      expect(updater.channel).toBe(channel === "prerelease" ? "rc" : "latest");
      expect(updater.allowPrerelease).toBe(channel === "prerelease");
    }
  });

  it("checks and downloads through electron-updater", async () => {
    const { updater, calls } = fakeUpdater();
    const port = createAppImageUpdaterPort({
      feed,
      appImage: "/home/u/Gram.AppImage",
      relaunch: () => {},
      log: () => {},
      updater: updater as never,
    });
    port.useFeed("stable");
    expect(await port.check()).toEqual({
      version: "1.4.0",
      notes: "Notes",
      date: "2026-11-02T10:00:00.000Z",
    });
    const percents: number[] = [];
    expect(await port.download((percent) => percents.push(percent))).toBe(
      "/cache/gram-updater/pending/gram_1.4.0_x86_64.AppImage",
    );
    expect(percents).toEqual([50]);
    expect(calls).toEqual(["feed stable", "check", "download"]);
  });

  it("installs the snapshot over the AppImage itself, one attempt at a time, and relaunches it", async () => {
    const { updater, calls } = fakeUpdater();
    const installs: string[] = [];
    const written = Promise.withResolvers<void>();
    const relaunched: string[] = [];
    const port = createAppImageUpdaterPort({
      feed,
      appImage: "/home/u/Gram.AppImage",
      relaunch: (path) => relaunched.push(path),
      log: () => {},
      updater: updater as never,
      install: async (_snapshot, target) => {
        installs.push(target);
        await written.promise;
      },
    });
    const snapshot = {} as CandidateSnapshot;
    const first = port.stage(snapshot, "1.4.0");
    await expect(port.stage(snapshot, "1.4.0")).rejects.toThrow(/already writing/);
    written.resolve();
    await first;
    expect(installs).toEqual(["/home/u/Gram.AppImage"]);
    // Nothing is ever pending outside Gram: no ShipIt, no Squirrel.Mac.
    expect(await port.pendingInstall()).toBe(false);
    expect(await port.disarm()).toBe(true);
    port.quitAndInstall();
    expect(relaunched).toEqual(["/home/u/Gram.AppImage"]);
    expect(calls).not.toContain("electron-updater quitAndInstall");
  });
});
