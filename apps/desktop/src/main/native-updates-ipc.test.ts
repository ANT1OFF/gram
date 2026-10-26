import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";
import { Channels } from "@gram/shell/channels";
import { createShellIpc } from "@gram/shell/modules/ipc";

vi.mock("electron", () => ({
  app: { getVersion: () => "0.1.0-rc.17", isPackaged: true },
  BrowserWindow: {},
  clipboard: {},
  dialog: {},
  shell: {},
}));
vi.mock("@gram/shell/electron", () => ({
  notify: vi.fn(),
  openLink: vi.fn(),
  parseMenuShortcuts: vi.fn(),
  setBadge: vi.fn(),
  setTitleBarTheme: vi.fn(),
  setVibrancy: vi.fn(),
  trustedLinkHosts: vi.fn(),
  untrustLinkHost: vi.fn(),
}));
import { registerIpc, type IpcOptions } from "./ipc.ts";
import type { NativeUpdates } from "./update/native-updates.ts";

const PUBLIC_SOURCE = { repo: "example/gram", visibility: "public" } as const;

function register(native: NativeUpdates | undefined) {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, arg: unknown) => unknown>();
  const ipcMain = {
    on: vi.fn(),
    handle: (channel: string, handler: (event: IpcMainInvokeEvent, arg: unknown) => unknown) =>
      handlers.set(channel, handler),
  };
  const trusted = {} as IpcMainInvokeEvent;
  const privateInstall = vi.fn(async () => ({ updating: true }));
  registerIpc({
    ipc: createShellIpc(ipcMain as unknown as IpcMain, (event) => event === trusted),
    updates: { check: vi.fn(), install: privateInstall },
    native,
    updateSource: PUBLIC_SOURCE,
    windows: {},
    autoUpdateCheck: false,
    setMenuShortcuts: vi.fn(),
  } as unknown as IpcOptions);
  const call = (channel: string, arg?: unknown) => handlers.get(channel)!(trusted, arg);
  return {
    call,
    privateInstall,
    untrusted: (channel: string) => handlers.get(channel)!({} as IpcMainInvokeEvent, undefined),
  };
}

describe("signed updater IPC", () => {
  it("tells a trusted page where releases come from", () => {
    const { call } = register(undefined);
    expect(call(Channels.updatesSource)).toEqual(PUBLIC_SOURCE);
  });

  it("is null everywhere on an install that uses the private updater", async () => {
    const { call, privateInstall } = register(undefined);
    expect(call(Channels.updatesNativeState)).toBeNull();
    expect(call(Channels.updatesNativeCheck, "stable")).toBeNull();
    expect(call(Channels.updatesNativeDownload)).toBeNull();
    expect(call(Channels.updatesNativeInstall, "0.1.0-rc.18")).toBeNull();
    expect(call(Channels.updatesNativeDismiss)).toBeNull();
    const intent = { channel: "prerelease", tag: "v0.1.0-rc.18", downgrade: false };
    await call(Channels.updatesInstall, intent);
    expect(privateInstall).toHaveBeenCalledOnce();
  });

  it("routes a signed install's actions to Electron's updater, and refuses the private installer", async () => {
    const native = {
      state: vi.fn(() => ({ status: "ready" })),
      check: vi.fn(async () => ({ status: "checking" })),
      download: vi.fn(async () => ({ status: "downloading" })),
      install: vi.fn(async () => ({ status: "installing" })),
      dismiss: vi.fn(() => ({ status: "idle" })),
      start: vi.fn(),
    } as unknown as NativeUpdates;
    const { call, privateInstall, untrusted } = register(native);
    expect(call(Channels.updatesNativeState)).toEqual({ status: "ready" });
    await call(Channels.updatesNativeCheck, "prerelease");
    expect(native.check).toHaveBeenCalledWith("prerelease", true);
    // Anything but Pre-release is Stable.
    await call(Channels.updatesNativeCheck, "nightly");
    expect(native.check).toHaveBeenLastCalledWith("stable", true);
    await call(Channels.updatesNativeInstall, "0.1.0-rc.18");
    expect(native.install).toHaveBeenCalledWith("0.1.0-rc.18");
    await call(Channels.updatesNativeInstall, { version: "0.1.0-rc.18" });
    expect(native.install).toHaveBeenCalledOnce();
    expect(
      await call(Channels.updatesInstall, { channel: "stable", tag: "v0.1.0", downgrade: false }),
    ).toEqual({
      updating: false,
      error: "This Gram updates from the update button or Settings → Updates.",
    });
    expect(privateInstall).not.toHaveBeenCalled();
    expect(() => untrusted(Channels.updatesNativeInstall)).toThrow("untrusted sender");
  });
});
