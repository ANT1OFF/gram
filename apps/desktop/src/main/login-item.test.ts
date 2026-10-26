import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";
import { Channels } from "@gram/shell/channels";
import { createShellIpc } from "@gram/shell/modules/ipc";

vi.mock("electron", () => ({
  app: { getVersion: () => "0.1.0", isPackaged: false },
  BrowserWindow: {},
  clipboard: {},
  dialog: {},
  shell: {},
}));
vi.mock("@gram/shell/electron", () => ({}));
import { registerIpc, type IpcOptions } from "./ipc.ts";
import {
  createLoginItem,
  LOGIN_ARG,
  LOGIN_ITEMS_SETTINGS_URL,
  startsHidden,
  type LoginItemApi,
} from "./login-item.ts";

/** Electron's login-item calls over an in-memory registration, the way macOS or Windows keeps it. */
const fakeApi = (initial: {
  openAtLogin?: boolean;
  status?: string;
  wasOpenedAtLogin?: boolean;
}) => {
  let openAtLogin = initial.openAtLogin ?? false;
  let status = initial.status ?? (openAtLogin ? "enabled" : "not-registered");
  const api = {
    getLoginItemSettings: vi.fn((_options?: { readonly args?: string[] }) => ({
      openAtLogin,
      status,
      wasOpenedAtLogin: initial.wasOpenedAtLogin ?? false,
    })),
    setLoginItemSettings: vi.fn((settings: { openAtLogin: boolean }) => {
      openAtLogin = settings.openAtLogin;
      status = openAtLogin ? "enabled" : "not-registered";
    }),
  } satisfies LoginItemApi;
  return {
    api,
    /** What System Settings does when the user turns the item off or leaves it unapproved. */
    setStatus: (next: string, open: boolean) => {
      status = next;
      openAtLogin = open;
    },
  };
};

const mac = (api: LoginItemApi, more: { packaged?: boolean; argv?: string[] } = {}) =>
  createLoginItem({
    api,
    platform: "darwin",
    packaged: more.packaged ?? true,
    argv: more.argv ?? [],
    openExternal: async () => {},
  });

describe("createLoginItem", () => {
  it("is off by default and touches nothing until the user turns it on", () => {
    const { api } = fakeApi({});
    const item = mac(api);
    expect(item.state()).toEqual({ enabled: false, needsApproval: false });
    expect(item.launchedAtLogin).toBe(false);
    expect(api.setLoginItemSettings).not.toHaveBeenCalled();
  });

  it("registers and removes the item, reading back what the OS kept", () => {
    const fake = fakeApi({});
    const item = mac(fake.api);
    expect(item.set(true)).toEqual({ enabled: true, needsApproval: false });
    expect(fake.api.setLoginItemSettings).toHaveBeenLastCalledWith({ openAtLogin: true });
    expect(item.set(false)).toEqual({ enabled: false, needsApproval: false });
    expect(fake.api.setLoginItemSettings).toHaveBeenLastCalledWith({ openAtLogin: false });
  });

  it("says when macOS waits for approval in Login Items", () => {
    const fake = fakeApi({});
    const item = mac(fake.api);
    fake.setStatus("requires-approval", false);
    expect(item.state()).toEqual({ enabled: true, needsApproval: true });
  });

  it("follows a removal made in System Settings and never re-registers at startup", () => {
    const fake = fakeApi({ openAtLogin: true });
    fake.setStatus("not-registered", false);
    const item = mac(fake.api);
    expect(item.state()).toEqual({ enabled: false, needsApproval: false });
    expect(fake.api.setLoginItemSettings).not.toHaveBeenCalled();
  });

  it("keeps an existing registration as it is across a launch of a new build", () => {
    // A signed update replaces the bundle but keeps its identifier and team, so SMAppService still
    // has it registered; the new build only reads it.
    const fake = fakeApi({ openAtLogin: true });
    expect(mac(fake.api).state()).toEqual({ enabled: true, needsApproval: false });
    expect(fake.api.setLoginItemSettings).not.toHaveBeenCalled();
  });

  it("tells a macOS login launch from what Electron reports", () => {
    expect(mac(fakeApi({ openAtLogin: true, wasOpenedAtLogin: true }).api).launchedAtLogin).toBe(
      true,
    );
    // The Windows argument means nothing on macOS.
    expect(mac(fakeApi({}).api, { argv: ["gram", LOGIN_ARG] }).launchedAtLogin).toBe(false);
  });

  it("registers Windows with an argument that marks a login launch", () => {
    const fake = fakeApi({});
    const create = (argv: string[]) =>
      createLoginItem({
        api: fake.api,
        platform: "win32",
        packaged: true,
        argv,
        openExternal: async () => {},
      });
    const item = create(["Gram.exe"]);
    item.set(true);
    expect(fake.api.setLoginItemSettings).toHaveBeenLastCalledWith({
      openAtLogin: true,
      args: [LOGIN_ARG],
    });
    expect(fake.api.getLoginItemSettings).toHaveBeenLastCalledWith({ args: [LOGIN_ARG] });
    expect(item.launchedAtLogin).toBe(false);
    expect(create(["Gram.exe", LOGIN_ARG]).launchedAtLogin).toBe(true);
  });

  it("isn't offered on Linux or in a development run, which would register bare Electron", () => {
    for (const item of [
      mac(fakeApi({ wasOpenedAtLogin: true }).api, { packaged: false }),
      createLoginItem({
        api: fakeApi({}).api,
        platform: "linux",
        packaged: true,
        argv: [LOGIN_ARG],
        openExternal: async () => {},
      }),
    ]) {
      expect(item.state()).toBeNull();
      expect(item.set(true)).toBeNull();
      expect(item.launchedAtLogin).toBe(false);
    }
  });

  it("opens Login Items on macOS only", async () => {
    const openExternal = vi.fn(async (_url: string) => {});
    const item = createLoginItem({
      api: fakeApi({}).api,
      platform: "darwin",
      packaged: true,
      argv: [],
      openExternal,
    });
    expect(await item.openSettings()).toBe(true);
    expect(openExternal).toHaveBeenCalledWith(LOGIN_ITEMS_SETTINGS_URL);
    openExternal.mockRejectedValueOnce(new Error("no pane"));
    expect(await item.openSettings()).toBe(false);
    const win = createLoginItem({
      api: fakeApi({}).api,
      platform: "win32",
      packaged: true,
      argv: [],
      openExternal,
    });
    expect(await win.openSettings()).toBe(false);
  });
});

describe("startsHidden", () => {
  it("hides a login launch only where something brings the window back", () => {
    expect(startsHidden("darwin", true, false)).toBe(true);
    expect(startsHidden("win32", true, true)).toBe(true);
    // No tray icon, and a hidden window has no taskbar button: it would be unreachable.
    expect(startsHidden("win32", true, false)).toBe(false);
    expect(startsHidden("darwin", false, true)).toBe(false);
  });
});

it("serves the setting to trusted pages only, and only for a boolean", async () => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, arg: unknown) => unknown>();
  const native = {
    on: vi.fn(),
    handle: (channel: string, handler: (event: IpcMainInvokeEvent, arg: unknown) => unknown) =>
      handlers.set(channel, handler),
  };
  const trusted = {} as IpcMainInvokeEvent;
  const fake = fakeApi({});
  registerIpc({
    ipc: createShellIpc(native as unknown as IpcMain, (event) => event === trusted),
    loginItem: mac(fake.api),
  } as unknown as IpcOptions);
  const set = handlers.get(Channels.launchAtLoginSet)!;
  expect(() => set({} as IpcMainInvokeEvent, true)).toThrow("untrusted sender");
  expect(() => set(trusted, "yes")).toThrow("needs a boolean");
  expect(fake.api.setLoginItemSettings).not.toHaveBeenCalled();
  expect(await set(trusted, true)).toEqual({ enabled: true, needsApproval: false });
  expect(await handlers.get(Channels.launchAtLoginGet)!(trusted, undefined)).toEqual({
    enabled: true,
    needsApproval: false,
  });
});
