import type { AppUpdateState } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import {
  backgroundCheckAllowed,
  initialNativeUpdateState,
  reduceNativeUpdate,
  type NativeUpdateEvent,
} from "./native-state.ts";

const start = initialNativeUpdateState({
  currentVersion: "0.1.0-rc.17",
  channel: "prerelease",
  canInstall: true,
});
const run = (state: AppUpdateState, ...events: NativeUpdateEvent[]) =>
  events.reduce(reduceNativeUpdate, state);

const check = { type: "checkStarted", channel: "prerelease", manual: false } as const;
const found = (version = "0.1.0-rc.18") =>
  ({
    type: "available",
    version,
    notes: "Notes",
    date: "2026-10-16T10:00:00Z",
    at: 1000,
  }) as const;
const available = run(start, check, found());
const downloading = run(available, { type: "downloadStarted" });
const ready = run(downloading, { type: "downloaded", version: "0.1.0-rc.18" });
const installing = run(ready, { type: "installStarted" });

describe("reduceNativeUpdate", () => {
  it("starts idle with nothing found", () => {
    expect(start).toMatchObject({
      status: "idle",
      availableVersion: null,
      downloadedVersion: null,
      canInstall: true,
    });
  });

  it("checks, then finds an update or nothing", () => {
    expect(run(start, check)).toMatchObject({ status: "checking", manual: false });
    expect(run(start, { ...check, manual: true }).manual).toBe(true);
    expect(available).toMatchObject({
      status: "available",
      availableVersion: "0.1.0-rc.18",
      releaseNotes: "Notes",
      releaseDate: "2026-10-16T10:00:00Z",
      checkedAt: 1000,
    });
    expect(run(start, check, { type: "upToDate", at: 5 })).toMatchObject({
      status: "upToDate",
      checkedAt: 5,
      availableVersion: null,
    });
  });

  it("reports a failed check as an error to retry", () => {
    expect(run(start, check, { type: "checkFailed", message: "offline", at: 9 })).toMatchObject({
      status: "error",
      errorStep: "check",
      message: "offline",
      checkedAt: 9,
    });
  });

  it("downloads with progress that only moves forward, clamped to 0–100", () => {
    expect(downloading).toMatchObject({ status: "downloading", percent: 0 });
    const half = run(downloading, { type: "downloadProgress", percent: 50.5 });
    expect(half.percent).toBe(50.5);
    expect(run(half, { type: "downloadProgress", percent: 20 }).percent).toBe(50.5);
    expect(run(half, { type: "downloadProgress", percent: 400 }).percent).toBe(100);
    expect(run(downloading, { type: "downloadProgress", percent: Number.NaN }).percent).toBe(0);
  });

  it("is ready once the download is verified, and installs from there", () => {
    expect(ready).toMatchObject({
      status: "ready",
      downloadedVersion: "0.1.0-rc.18",
      percent: 100,
    });
    expect(installing.status).toBe("installing");
  });

  it("refuses a download of another version than the one available", () => {
    expect(run(downloading, { type: "downloaded", version: "0.1.0-rc.19" })).toBe(downloading);
  });

  it("keeps the available version after a failed download, to retry", () => {
    const failed = run(downloading, { type: "downloadFailed", message: "checksum" });
    expect(failed).toMatchObject({
      status: "error",
      errorStep: "download",
      availableVersion: "0.1.0-rc.18",
      message: "checksum",
    });
    expect(run(failed, { type: "downloadStarted" }).status).toBe("downloading");
  });

  it("returns to an install error with the fence's reason when it refuses, and retries", () => {
    const refused = run(installing, {
      type: "installRefused",
      message: "An agent process did not exit cleanly when stopped.",
    });
    expect(refused).toMatchObject({
      status: "error",
      errorStep: "install",
      downloadedVersion: "0.1.0-rc.18",
      message: "An agent process did not exit cleanly when stopped.",
    });
    expect(run(refused, { type: "installStarted" }).status).toBe("installing");
    expect(run(refused, { type: "dismissed" })).toMatchObject({ status: "ready", message: null });
  });

  it("keeps a verified download through a failed check", () => {
    expect(
      run(ready, { ...check, manual: true }, { type: "checkFailed", message: "offline", at: 7 }),
    ).toMatchObject({
      status: "ready",
      downloadedVersion: "0.1.0-rc.18",
      message: null,
      checkedAt: 7,
    });
  });

  it("keeps a download the feed still offers, and drops one it withdrew", () => {
    expect(run(ready, check, found()).status).toBe("ready");
    expect(run(ready, check, found("0.1.0-rc.19"))).toMatchObject({
      status: "available",
      availableVersion: "0.1.0-rc.19",
      downloadedVersion: null,
    });
    expect(run(ready, check, { type: "upToDate", at: 3 })).toMatchObject({
      status: "upToDate",
      downloadedVersion: null,
    });
  });

  it("never offers another channel's release after the channel changes", () => {
    const stable = run(ready, { type: "checkStarted", channel: "stable", manual: true });
    expect(stable).toMatchObject({
      status: "checking",
      channel: "stable",
      availableVersion: null,
      downloadedVersion: null,
    });
  });

  it("doesn't check over a download or an install", () => {
    expect(run(downloading, check)).toBe(downloading);
    expect(run(installing, check)).toBe(installing);
  });

  it("ignores events that don't apply to the current state", () => {
    expect(run(start, { type: "downloadStarted" })).toBe(start);
    expect(run(start, { type: "downloadProgress", percent: 10 })).toBe(start);
    expect(run(start, { type: "downloaded", version: "0.1.0-rc.18" })).toBe(start);
    expect(run(start, { type: "installStarted" })).toBe(start);
    expect(run(ready, { type: "installRefused", message: "x" })).toBe(ready);
    expect(run(available, found("0.1.0-rc.19"))).toBe(available);
    expect(run(available, { type: "upToDate", at: 1 })).toBe(available);
    expect(run(available, { type: "checkFailed", message: "x", at: 1 })).toBe(available);
    expect(run(available, { type: "downloadFailed", message: "x" })).toBe(available);
  });

  it("shows an update that didn't apply until dismissed or installed again", () => {
    const notApplied = run(start, {
      type: "notApplied",
      version: "0.1.0-rc.18",
      reason: "See the log",
    });
    expect(notApplied.notApplied).toEqual({ version: "0.1.0-rc.18", reason: "See the log" });
    expect(run(notApplied, check, found()).notApplied).not.toBeNull();
    expect(run(notApplied, { type: "dismissed" }).notApplied).toBeNull();
    const retried = run(
      notApplied,
      check,
      found(),
      { type: "downloadStarted" },
      { type: "downloaded", version: "0.1.0-rc.18" },
      { type: "installStarted" },
    );
    expect(retried).toMatchObject({ status: "installing", notApplied: null });
  });

  it("dismisses an error back to where a retry starts", () => {
    const checkError = run(start, check, { type: "checkFailed", message: "x", at: 1 });
    expect(run(checkError, { type: "dismissed" }).status).toBe("idle");
    const downloadError = run(downloading, { type: "downloadFailed", message: "x" });
    expect(run(downloadError, { type: "dismissed" }).status).toBe("available");
    expect(run(available, { type: "dismissed" }).status).toBe("available");
  });
});

describe("refusals and holds", () => {
  it("does not re-offer a snapshot discarded after a channel-change refusal", () => {
    const refused = run(installing, {
      type: "installRefused",
      message: "Channel changed",
      step: "check",
    });
    expect(refused.downloadedVersion).toBeNull();
    expect(run(refused, { type: "dismissed" }).status).toBe("idle");
  });

  it("sends a retry to the step that has to run again", () => {
    expect(
      run(installing, { type: "installRefused", message: "Channel changed", step: "check" }),
    ).toMatchObject({
      status: "error",
      errorStep: "check",
      manual: true,
      downloadedVersion: null,
    });
    expect(
      run(installing, { type: "installRefused", message: "Changed on disk", step: "download" }),
    ).toMatchObject({
      status: "error",
      errorStep: "download",
      downloadedVersion: null,
      availableVersion: "0.1.0-rc.18",
    });
    const retried = run(
      installing,
      { type: "installRefused", message: "Changed on disk", step: "download" },
      { type: "downloadStarted" },
    );
    expect(retried.status).toBe("downloading");
  });

  it("holds the restart with a reason, offering nothing to click", () => {
    const held = run(installing, { type: "installHeld", message: "macOS is still preparing" });
    expect(held).toMatchObject({ status: "installing", message: "macOS is still preparing" });
    expect(backgroundCheckAllowed(held)).toBe(false);
    expect(run(held, check)).toBe(held);
    expect(run(ready, { type: "installHeld", message: "x" })).toBe(ready);
  });
});

describe("a pending earlier install", () => {
  it("holds from any state, blocking checks, and lets go only when cleared", () => {
    for (const from of [start, available, ready]) {
      const held = run(from, { type: "pendingInstall", message: "macOS has one waiting" });
      expect(held).toMatchObject({ status: "installing", message: "macOS has one waiting" });
      expect(backgroundCheckAllowed(held)).toBe(false);
      expect(run(held, check)).toBe(held);
    }
    expect(
      run(start, { type: "pendingInstall", message: "x" }, { type: "pendingCleared" }),
    ).toMatchObject({ status: "idle", message: null });
    expect(
      run(ready, { type: "pendingInstall", message: "x" }, { type: "pendingCleared" }).status,
    ).toBe("ready");
    expect(run(ready, { type: "pendingCleared" })).toBe(ready);
  });
});

describe("backgroundCheckAllowed", () => {
  it("leaves downloads, ready updates and installs alone", () => {
    expect(backgroundCheckAllowed(start)).toBe(true);
    expect(backgroundCheckAllowed(available)).toBe(true);
    expect(backgroundCheckAllowed(run(start, check))).toBe(false);
    expect(backgroundCheckAllowed(downloading)).toBe(false);
    expect(backgroundCheckAllowed(ready)).toBe(false);
    expect(backgroundCheckAllowed(installing)).toBe(false);
    expect(
      backgroundCheckAllowed(run(installing, { type: "installRefused", message: "refused" })),
    ).toBe(false);
  });
});
