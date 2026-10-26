import type { AppUpdateState } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { notesPreview, pillView, statusLine } from "./update-pill-view";

const base: AppUpdateState = {
  status: "idle",
  channel: "prerelease",
  currentVersion: "0.1.0-rc.17",
  availableVersion: null,
  downloadedVersion: null,
  releaseNotes: null,
  releaseDate: null,
  percent: null,
  checkedAt: null,
  manual: false,
  message: null,
  errorStep: null,
  notApplied: null,
  canInstall: true,
};
const intl = { timeZone: "UTC", locale: "en-GB" };
const at = (patch: Partial<AppUpdateState>) => pillView({ ...base, ...patch }, intl);

describe("pillView", () => {
  it("stays hidden with nothing to say, and for the timer's checks", () => {
    expect(pillView(undefined)).toBeUndefined();
    expect(pillView(null)).toBeUndefined();
    expect(at({})).toBeUndefined();
    expect(at({ status: "upToDate", checkedAt: 1 })).toBeUndefined();
    expect(at({ status: "checking" })).toBeUndefined();
    expect(at({ status: "error", errorStep: "check", message: "offline" })).toBeUndefined();
  });

  it("shows a check the user asked for, and its failure", () => {
    expect(at({ status: "checking", manual: true })).toEqual({
      kind: "checking",
      hint: "Checking for updates…",
      action: "none",
    });
    expect(at({ status: "error", errorStep: "check", message: "offline", manual: true })).toEqual({
      kind: "error",
      hint: "offline\nClick to check again.",
      action: "check",
    });
  });

  it("offers an available update to download, with notes and a 24-hour publish time", () => {
    expect(
      at({
        status: "available",
        availableVersion: "0.1.0-rc.18",
        releaseNotes: "Faster restarts",
        releaseDate: "2026-10-16T17:05:00Z",
      }),
    ).toEqual({
      kind: "available",
      hint: "Gram 0.1.0-rc.18 is available.\nPublished 16 Oct, 17:05\nClick to download.",
      notes: "Faster restarts",
      action: "download",
      version: "0.1.0-rc.18",
    });
  });

  it("shows the download's percent as its label", () => {
    expect(at({ status: "downloading", availableVersion: "0.1.0-rc.18", percent: 42.7 })).toEqual({
      kind: "downloading",
      label: "42%",
      hint: "Downloading Gram 0.1.0-rc.18 · 42%",
      action: "none",
      percent: 42,
      version: "0.1.0-rc.18",
    });
  });

  it("offers Restart once the download is verified, saying what a restart does", () => {
    expect(
      at({ status: "ready", availableVersion: "0.1.0-rc.18", downloadedVersion: "0.1.0-rc.18" }),
    ).toEqual({
      kind: "ready",
      label: "Restart",
      hint: "Gram 0.1.0-rc.18 is ready.\nRestart to update. Gram saves sessions and stops running agents first.",
      action: "install",
      version: "0.1.0-rc.18",
    });
    expect(at({ status: "installing", downloadedVersion: "0.1.0-rc.18" })).toMatchObject({
      kind: "installing",
      label: "Restarting…",
      action: "none",
    });
  });

  it("gives the refusal's reason in one line and retries the step that failed", () => {
    expect(
      at({
        status: "error",
        errorStep: "install",
        downloadedVersion: "0.1.0-rc.18",
        message: "Didn't restart: an agent didn't stop cleanly. Nothing was installed.",
      }),
    ).toEqual({
      kind: "error",
      hint: "Didn't restart: an agent didn't stop cleanly. Nothing was installed.\nClick to try again.",
      action: "install",
      version: "0.1.0-rc.18",
    });
    expect(
      at({ status: "error", errorStep: "download", availableVersion: "0.1.0-rc.18", message: "x" }),
    ).toMatchObject({ kind: "error", action: "download" });
  });

  it("says an update didn't apply until it's dismissed, and mentions it when offered again", () => {
    const notApplied = { version: "0.1.0-rc.18", reason: "See ShipIt_stderr.log." };
    expect(at({ status: "upToDate", notApplied })).toEqual({
      kind: "notApplied",
      hint: "Gram 0.1.0-rc.18 wasn't applied.\nSee ShipIt_stderr.log.",
      action: "settings",
      version: "0.1.0-rc.18",
    });
    expect(at({ status: "available", availableVersion: "0.1.0-rc.18", notApplied })?.hint).toMatch(
      /^Gram 0\.1\.0-rc\.18 didn't apply last time\./,
    );
  });
});

describe("pillView, restart guards", () => {
  it("says it's verifying once the download is whole", () => {
    expect(
      at({ status: "downloading", availableVersion: "0.1.0-rc.18", percent: 100 }),
    ).toMatchObject({
      label: "Verifying…",
      hint: "Verifying Gram 0.1.0-rc.18: its signature, notarization and version.",
      action: "none",
    });
  });

  it("shows why a restart is held, with nothing to click", () => {
    expect(
      at({
        status: "installing",
        downloadedVersion: "0.1.0-rc.18",
        message: "macOS is still preparing the update. Gram waits for it; quitting now is safe.",
      }),
    ).toMatchObject({
      hint: "Restarting into Gram 0.1.0-rc.18.\nmacOS is still preparing the update. Gram waits for it; quitting now is safe.",
      action: "none",
    });
  });

  it("never offers a download or restart that can't work outside Applications", () => {
    const elsewhere = { canInstall: false } as const;
    for (const patch of [
      { status: "available", availableVersion: "0.1.0-rc.18" },
      { status: "ready", availableVersion: "0.1.0-rc.18", downloadedVersion: "0.1.0-rc.18" },
      { status: "error", errorStep: "install", downloadedVersion: "0.1.0-rc.18", message: "x" },
    ] as const) {
      const view = at({ ...patch, ...elsewhere });
      expect(view?.action).toBe("settings");
      expect(view?.hint).not.toMatch(/try again|Click to download|Restart to update\./);
    }
  });
});

describe("notesPreview", () => {
  it("drops Markdown's marks for the hover", () => {
    expect(
      notesPreview("### Features\n\n- **Pill**: `check` and [restart](https://x)\n\n\n\n## Fixes"),
    ).toBe("Features\n\n• Pill: check and restart\n\nFixes");
  });
});

describe("statusLine", () => {
  it("names each state for Settings, with a 24-hour check time", () => {
    expect(statusLine(base)).toBe("Not checked yet");
    expect(
      statusLine({ ...base, status: "upToDate", checkedAt: Date.UTC(2026, 9, 16, 9, 5) }, intl),
    ).toBe("Up to date · checked 09:05");
    expect(statusLine({ ...base, status: "ready", downloadedVersion: "0.1.0-rc.18" })).toBe(
      "Gram 0.1.0-rc.18 is downloaded and verified · restart to update",
    );
    expect(
      statusLine({ ...base, status: "downloading", availableVersion: "x", percent: 9.9 }),
    ).toBe("Downloading Gram x · 9%");
    // The refusal's reason shows once, beside the buttons; the status line says where things are.
    expect(
      statusLine({
        ...base,
        status: "error",
        errorStep: "install",
        downloadedVersion: "0.1.0-rc.18",
        message: "Didn't restart: an agent didn't stop cleanly.",
      }),
    ).toBe("Gram 0.1.0-rc.18 is downloaded · the restart didn't go ahead");
  });
});
