import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { expect, it, vi } from "vitest";
import { Channels } from "@gram/shell/channels";
import { isTrustedSenderUrl } from "@gram/shell/core";
import { createShellIpc } from "@gram/shell/modules/ipc";
import { installSmokeIpc } from "./smoke-ipc.ts";

const invokeEvent = (url: string) => ({ senderFrame: { url } }) as IpcMainInvokeEvent;

function register() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, arg: unknown) => unknown>();
  const ipcMain = {
    on: vi.fn(),
    handle: (channel: string, handler: (event: IpcMainInvokeEvent, arg: unknown) => unknown) => {
      if (handlers.has(channel)) throw new Error("duplicate handler");
      handlers.set(channel, handler);
    },
  };
  const origin = "http://127.0.0.1:51234";
  installSmokeIpc(
    createShellIpc(ipcMain as unknown as IpcMain, (e) =>
      isTrustedSenderUrl(e.senderFrame?.url, new Set([origin])),
    ),
    "0.10.0",
  );
  return {
    handlers,
    call: (channel: string, arg?: unknown) =>
      handlers.get(channel)!(invokeEvent(`${origin}/`), arg),
    untrusted: (channel: string) =>
      handlers.get(channel)!(invokeEvent("https://example.com/"), undefined),
  };
}

it("answers every update invoke exposed by the production preload, behind the sender check", () => {
  const { handlers, untrusted } = register();
  const preload = readFileSync(new URL("../preload/index.ts", import.meta.url), "utf8");
  const invokes = [...preload.matchAll(/ipcRenderer\.invoke\(Channels\.(updates\w+)/g)];
  expect(invokes).toHaveLength(9);
  for (const [, key] of invokes) {
    const channel = Channels[key as keyof typeof Channels];
    expect(handlers.has(channel), key).toBe(true);
    expect(() => untrusted(channel), key).toThrow("untrusted sender");
  }
  const trayPreload = readFileSync(
    new URL("../../../../packages/shell/src/modules/tray/preload.ts", import.meta.url),
    "utf8",
  );
  const trayInvokes = [...trayPreload.matchAll(/ipc\.invoke\(Channels\.(\w+)/g)];
  expect(trayInvokes).toHaveLength(2);
  for (const [, key] of trayInvokes) {
    const channel = Channels[key as keyof typeof Channels];
    expect(handlers.has(channel), key).toBe(true);
    expect(() => untrusted(channel), key).toThrow("untrusted sender");
  }
});

it("keeps smoke and normal startup exclusive, with smoke handlers installed before navigation", async () => {
  const main = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const startup = /void app\s*\.whenReady\(\)\s*\.then\(([\s\S]*?)\)\s*\.catch/.exec(main)?.[1];
  expect(startup).toBeDefined();
  // Execute the actual startup callback without importing Electron or starting its services.
  for (const primary of [true, false]) {
    for (const SMOKE of [true, false]) {
      const runSmoke = vi.fn();
      const runApp = vi.fn();
      const start = runInNewContext(`(${startup})`, {
        primary,
        SMOKE,
        runSmoke,
        runApp,
      }) as () => unknown;
      await start();
      expect(runSmoke).toHaveBeenCalledTimes(primary && SMOKE ? 1 : 0);
      expect(runApp).toHaveBeenCalledTimes(primary && !SMOKE ? 1 : 0);
    }
  }
  // There is one installation site, inside runSmoke, ahead of createWindow's navigation.
  expect(main.match(/\binstallSmokeIpc\(/g)).toHaveLength(1);
  const smoke = main.slice(
    main.indexOf("async function runSmoke()"),
    main.indexOf("const primary ="),
  );
  const install = smoke.indexOf("installSmokeIpc(");
  expect(install).toBeGreaterThan(-1);
  expect(install).toBeLessThan(smoke.indexOf("createWindow("));
});

it("answers startup reads without automatic checks or a signed updater", () => {
  const { call } = register();
  expect(call(Channels.updatesAutoCheck)).toBe(false);
  expect(call(Channels.updatesSource)).toEqual({ repo: null, visibility: "private" });
  expect(call(Channels.updatesNativeState)).toBeNull();
  expect(call(Channels.keepInTrayGet)).toBe(false);
  call(Channels.keepInTraySet, true);
  expect(call(Channels.keepInTrayGet)).toBe(false);
  expect(call(Channels.notificationStatusGet)).toEqual({ supported: false, last: null });
  expect(call(Channels.notificationStatusSettings)).toBe(false);
  expect(call(Channels.launchAtLoginGet)).toBeNull();
  expect(call(Channels.launchAtLoginSet, true)).toBeNull();
  expect(call(Channels.launchAtLoginGet)).toBeNull();
});

it("refuses all install paths and returns unavailable for manual checks", () => {
  const { call } = register();
  const intent = { channel: "stable", tag: "v99.0.0", downgrade: false };
  expect(call(Channels.updatesCheck, "stable")).toEqual({
    available: false,
    unavailable: true,
    unavailableMessage: "Updates are unavailable during a smoke run.",
    currentVersion: "0.10.0",
    canSelfInstall: false,
  });
  expect(call(Channels.updatesInstall, intent)).toEqual({
    updating: false,
    error: "Updates are unavailable during a smoke run.",
  });
  for (const channel of [
    Channels.updatesNativeCheck,
    Channels.updatesNativeDownload,
    Channels.updatesNativeInstall,
    Channels.updatesNativeDismiss,
  ]) {
    expect(call(channel, "99.0.0")).toBeNull();
  }
});
