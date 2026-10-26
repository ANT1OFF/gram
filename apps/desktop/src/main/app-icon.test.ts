import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { expect, it, vi } from "vitest";
import { Channels } from "@gram/shell/channels";
import { createShellIpc } from "@gram/shell/modules/ipc";

vi.mock("electron", () => ({
  app: { getVersion: () => "0.1.0", isPackaged: false },
  BrowserWindow: {},
  clipboard: {},
  dialog: {},
  nativeImage: {},
  shell: {},
}));
vi.mock("@gram/shell/electron", () => ({}));
import { parseStoredAppIcon } from "./app-icon.ts";
import { registerIpc, type IpcOptions } from "./ipc.ts";

it("reads a saved icon and falls back to the bundled one for anything else", () => {
  expect(parseStoredAppIcon('{"icon":"blade"}')).toBe("blade");
  expect(parseStoredAppIcon(undefined)).toBe("gift");
  expect(parseStoredAppIcon("not json")).toBe("gift");
  expect(parseStoredAppIcon('{"icon":"../../etc/passwd"}')).toBe("gift");
  expect(parseStoredAppIcon("null")).toBe("gift");
});

it("sets only a known icon, and only for a trusted page", () => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, arg: unknown) => unknown>();
  const native = {
    on: vi.fn(),
    handle: (channel: string, handler: (event: IpcMainInvokeEvent, arg: unknown) => unknown) =>
      handlers.set(channel, handler),
  };
  const trusted = {} as IpcMainInvokeEvent;
  const appIcon = { get: vi.fn(() => "gift" as const), set: vi.fn() };
  registerIpc({
    ipc: createShellIpc(native as unknown as IpcMain, (event) => event === trusted),
    appIcon,
  } as unknown as IpcOptions);
  const set = handlers.get(Channels.appIconSet)!;
  set(trusted, "fanout");
  expect(appIcon.set).toHaveBeenCalledWith("fanout");
  expect(() => set(trusted, "../escape")).toThrow("one of APP_ICONS");
  expect(() => set({} as IpcMainInvokeEvent, "blade")).toThrow("untrusted sender");
  expect(appIcon.set).toHaveBeenCalledTimes(1);
  expect(handlers.get(Channels.appIconGet)!(trusted, undefined)).toBe("gift");
});
