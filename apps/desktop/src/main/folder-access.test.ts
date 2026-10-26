import type { OpenDialogOptions, OpenDialogReturnValue } from "electron";
import { describe, expect, it, vi } from "vitest";

import {
  bundlePathOf,
  chooseFolder,
  openPrivacySettings,
  PRIVACY_FILES_AND_FOLDERS_URL,
} from "./folder-access.ts";

describe("openPrivacySettings", () => {
  it("opens the Files & Folders pane on macOS", async () => {
    const openExternal = vi.fn(async () => {});
    expect(await openPrivacySettings({ platform: "darwin", openExternal })).toBe(true);
    expect(openExternal).toHaveBeenCalledWith(PRIVACY_FILES_AND_FOLDERS_URL);
  });

  it("does nothing elsewhere, and reports a pane that won't open", async () => {
    const openExternal = vi.fn(async () => {});
    expect(await openPrivacySettings({ platform: "win32", openExternal })).toBe(false);
    expect(openExternal).not.toHaveBeenCalled();

    const failing = vi.fn(async () => {
      throw new Error("no handler");
    });
    expect(await openPrivacySettings({ platform: "darwin", openExternal: failing })).toBe(false);
  });
});

const dialog = (result: OpenDialogReturnValue) =>
  vi.fn(async (_options: OpenDialogOptions) => result);

describe("chooseFolder", () => {
  it("asks for a folder, which it may create, starting at an absolute default path", async () => {
    const showOpenDialog = dialog({ canceled: false, filePaths: ["/Users/dev/code/api"] });
    expect(await chooseFolder(showOpenDialog, { defaultPath: "/Users/dev/code" })).toBe(
      "/Users/dev/code/api",
    );
    expect(showOpenDialog).toHaveBeenCalledWith({
      properties: ["openDirectory", "createDirectory"],
      defaultPath: "/Users/dev/code",
    });
  });

  it("ignores a relative or malformed default path, and returns null on cancel", async () => {
    const showOpenDialog = dialog({ canceled: true, filePaths: [] });
    expect(await chooseFolder(showOpenDialog, { defaultPath: "~/code" })).toBeNull();
    expect(await chooseFolder(showOpenDialog, "nonsense")).toBeNull();
    expect(showOpenDialog.mock.calls.map(([options]) => options)).toEqual([
      { properties: ["openDirectory", "createDirectory"] },
      { properties: ["openDirectory", "createDirectory"] },
    ]);
  });
});

describe("bundlePathOf", () => {
  it("names the .app on macOS and the executable elsewhere", () => {
    expect(bundlePathOf("/Applications/Gram.app/Contents/MacOS/Gram")).toBe(
      "/Applications/Gram.app",
    );
    expect(bundlePathOf("C:\\Program Files\\Gram\\Gram.exe")).toBe(
      "C:\\Program Files\\Gram\\Gram.exe",
    );
  });
});
