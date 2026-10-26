// A shell's `window.gram`, composed from a base and the shell modules the app installs,
// so a module's bridge member comes with its main half and can't drift from
// it. A sandboxed preload can load nothing but `electron`: this file and every module's
// `preload.ts` import only types, and take `ipcRenderer` as a parameter.

import type { IpcRenderer, IpcRendererEvent } from "electron";

/** The renderer side of the app's IPC, as a module's preload half uses it. */
export interface PreloadIpc {
  invoke<T>(channel: string, arg?: unknown): Promise<T>;
  send(channel: string, arg?: unknown): void;
  /** Subscribes to `channel`; returns the unsubscribe function. */
  subscribe<T>(channel: string, callback: (value: T) => void): () => void;
  /** `subscribe`, with the `MessagePort`s main sent along. */
  subscribeWithPorts<T>(
    channel: string,
    callback: (value: T, ports: readonly MessagePort[]) => void,
  ): () => void;
}

/** `ipcRenderer` as a `PreloadIpc`. */
export function preloadIpc(ipcRenderer: IpcRenderer): PreloadIpc {
  return {
    invoke: (channel, arg) =>
      arg === undefined ? ipcRenderer.invoke(channel) : ipcRenderer.invoke(channel, arg),
    send: (channel, arg) =>
      arg === undefined ? ipcRenderer.send(channel) : ipcRenderer.send(channel, arg),
    subscribe: (channel, callback) => {
      const listener = (_event: IpcRendererEvent, value: unknown) => callback(value as never);
      ipcRenderer.on(channel, listener);
      return () => {
        ipcRenderer.removeListener(channel, listener);
      };
    },
    subscribeWithPorts: (channel, callback) => {
      const listener = (event: IpcRendererEvent, value: unknown) =>
        callback(value as never, event.ports);
      ipcRenderer.on(channel, listener);
      return () => {
        ipcRenderer.removeListener(channel, listener);
      };
    },
  };
}

type Merged<Parts extends readonly object[]> = Parts extends readonly [
  infer First extends object,
  ...infer Rest extends readonly object[],
]
  ? First & Merged<Rest>
  : unknown;

/**
 * The bridge: `base` with each module's members added. A member two parts both give is a bug, so
 * it throws rather than letting the later one win unseen.
 */
export function composeBridge<const Parts extends readonly object[]>(
  ...parts: Parts
): Merged<Parts> {
  const bridge: Record<string, unknown> = {};
  for (const part of parts) {
    for (const [key, value] of Object.entries(part)) {
      if (key in bridge) throw new Error(`window.gram: ${key} is given twice`);
      bridge[key] = value;
    }
  }
  return bridge as Merged<Parts>;
}

export { agentBrowsePreload } from "./modules/agent-browser/preload.ts";
export { connectionPreload } from "./modules/connection/preload.ts";
export { fontsPreload } from "./modules/fonts/preload.ts";
export { previewPreload } from "./modules/preview/preload.ts";
export { speechPreload } from "./modules/speech/preload.ts";
export { trayPreload } from "./modules/tray/preload.ts";
