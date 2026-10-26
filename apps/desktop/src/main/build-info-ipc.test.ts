import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { afterEach, expect, it, vi } from "vitest";
import { Channels } from "@gram/shell/channels";
import { createShellIpc } from "@gram/shell/modules/ipc";

vi.mock("electron", () => ({
  app: { getVersion: () => "0.1.0-rc.2", isPackaged: true },
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
import { runningBuildInfo } from "./build-info.ts";

afterEach(() => vi.unstubAllGlobals());
it("serves packaged build identity through the actual trusted IPC registration", () => {
  const source = "a".repeat(40);
  vi.stubGlobal("GRAM_BUILD_SOURCE", source);
  const handlers = new Map<string, (event: IpcMainInvokeEvent, arg: unknown) => unknown>();
  const native = {
    on: vi.fn(),
    handle: (channel: string, handler: (event: IpcMainInvokeEvent, arg: unknown) => unknown) =>
      handlers.set(channel, handler),
  };
  const trusted = {} as IpcMainInvokeEvent;
  const ipc = createShellIpc(native as unknown as IpcMain, (event) => event === trusted);
  registerIpc({
    ipc,
    updates: {},
    staged: {},
    restart: {},
    windows: {},
    autoUpdateCheck: false,
    setMenuShortcuts: vi.fn(),
  } as unknown as IpcOptions);
  const read = handlers.get(Channels.appBuildInfo)!;
  expect(read(trusted, { version: "invented", sourceCommit: "invented" })).toEqual({
    version: "0.1.0-rc.2",
    packaged: true,
    sourceCommit: source,
  });
  expect(() => read({} as IpcMainInvokeEvent, undefined)).toThrow("untrusted sender");
});
it("never attributes development or malformed/absent build source to a running binary", () => {
  expect(runningBuildInfo("0.1.0-rc.2", true)).toEqual({ version: "0.1.0-rc.2", packaged: true });
  vi.stubGlobal("GRAM_BUILD_SOURCE", "a".repeat(40));
  expect(runningBuildInfo("0.1.0-rc.2", false)).toEqual({ version: "0.1.0-rc.2", packaged: false });
  vi.stubGlobal("GRAM_BUILD_SOURCE", "not a commit");
  expect(runningBuildInfo("0.1.0-rc.2", true)).toEqual({ version: "0.1.0-rc.2", packaged: true });
});
