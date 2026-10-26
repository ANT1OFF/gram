// @vitest-environment happy-dom
import type { DesktopBridge } from "@gram/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { folderAccessDenial, PRIVACY_SETTINGS_FALLBACK } from "@/api/folder-access";

import { FolderAccessRecovery } from "./folder-access-recovery";

const denial = { path: "/Users/dev/Documents/Private", code: "EPERM" } as const;
const MESSAGE =
  "Gram can't read /Users/dev/Documents/Private. Allow it in System Settings → Privacy & Security → Files & Folders.";

const withBridge = (bridge: Partial<DesktopBridge>) =>
  Object.defineProperty(window, "gram", { value: bridge, configurable: true });

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "gram");
});

describe("folderAccessDenial", () => {
  it("reads the typed denial, not the message", () => {
    expect(folderAccessDenial({ _tag: "InvalidState", message: MESSAGE, access: denial })).toEqual(
      denial,
    );
    expect(folderAccessDenial({ _tag: "InvalidState", message: MESSAGE })).toBeUndefined();
    expect(
      folderAccessDenial({ _tag: "NotFound", access: denial, message: "Folder not found" }),
    ).toBeUndefined();
    expect(
      folderAccessDenial({ _tag: "InvalidState", access: { path: "/x", code: "ENOENT" } }),
    ).toBeUndefined();
  });
});

describe("FolderAccessRecovery", () => {
  it("names the path, retries and copies diagnostic details without a bridge", async () => {
    const onRetry = vi.fn();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<FolderAccessRecovery denial={denial} message={MESSAGE} onRetry={onRetry} />);

    expect(screen.getByText(denial.path)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open Privacy Settings" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Copy diagnostic details" }));
    expect((await screen.findByRole("status")).textContent).toBe("Copied diagnostic details.");
    expect(writeText).toHaveBeenCalledWith(
      [
        "Gram folder access",
        "Path: /Users/dev/Documents/Private",
        "Error: EPERM",
        "Platform: browser",
        "App: not the desktop app",
      ].join("\n"),
    );
  });

  it("on macOS opens Privacy Settings, and falls back to directions when it can't", async () => {
    const openPrivacySettings = vi.fn(async () => false);
    const copyText = vi.fn(async () => {});
    withBridge({
      platform: "darwin",
      openPrivacySettings,
      copyText,
      appBundlePath: async () => "/Applications/Gram.app",
    });
    render(<FolderAccessRecovery denial={denial} message={MESSAGE} onRetry={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Open Privacy Settings" }));
    await waitFor(() => expect(screen.getByText(PRIVACY_SETTINGS_FALLBACK)).toBeTruthy());
    expect(openPrivacySettings).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Copy diagnostic details" }));
    await waitFor(() =>
      expect(copyText).toHaveBeenCalledWith(expect.stringContaining("App: /Applications/Gram.app")),
    );
    expect(copyText).toHaveBeenCalledWith(expect.stringContaining("Platform: darwin"));
  });

  it("offers no Privacy Settings shortcut off macOS", () => {
    withBridge({ platform: "win32", openPrivacySettings: vi.fn(async () => false) });
    render(<FolderAccessRecovery denial={denial} message="Permission denied" onRetry={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Open Privacy Settings" })).toBeNull();
  });
});
