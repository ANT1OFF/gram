// How a shell module's main half registers its IPC: through the app's trust check, so a module
// never sees a message from a page outside the app (`isTrustedSenderUrl`), and never registers a
// channel of its own without it.

import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from "electron";

/** The app's IPC, every channel behind its trust check. */
export interface ShellIpc {
  /** A message from a trusted page; others are dropped. */
  on(channel: string, handler: (event: IpcMainEvent, arg: unknown) => void): void;
  /** A request from a trusted page; others are refused. */
  handle(channel: string, handler: (arg: unknown, event: IpcMainInvokeEvent) => unknown): void;
}

/** `ipcMain` behind `trusted`: what `registerIpc` in each app hands its modules. */
export function createShellIpc(
  ipcMain: IpcMain,
  trusted: (event: IpcMainEvent | IpcMainInvokeEvent) => boolean,
): ShellIpc {
  return {
    on: (channel, handler) =>
      ipcMain.on(channel, (event, arg: unknown) => {
        if (trusted(event)) handler(event, arg);
      }),
    handle: (channel, handler) =>
      ipcMain.handle(channel, (event, arg: unknown) => {
        if (!trusted(event)) throw new Error("untrusted sender");
        return handler(arg, event);
      }),
  };
}
