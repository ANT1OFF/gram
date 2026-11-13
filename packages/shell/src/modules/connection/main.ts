// The connection module's main half: what each window says of its socket to the server, written to
// the shell's log, so a hung window can be told from a lost server (`createConnectionLog`). A
// window whose session the server refused is loaded onto the boot address again
// (`createSessionRenewal`).

import type { WebContents } from "electron";

import { Channels } from "../../channels.ts";
import type { ShellLog } from "../../core/log.ts";
import {
  createConnectionLog,
  createSessionRenewal,
  parseRendererConnection,
} from "../../core/renderer-health.ts";
import type { ShellIpc } from "../ipc.ts";

/** Logs each window's reports; `forget` a window when it closes. */
export function installConnection(
  ipc: ShellIpc,
  {
    log,
    windowIdFor,
    renewSession,
    now = Date.now,
  }: {
    readonly log: ShellLog;
    /** Which app window `sender` is; reports from any other page are dropped. */
    readonly windowIdFor: (sender: WebContents) => string | undefined;
    /**
     * Loads `sender`'s window onto the server's boot address; false when there is no server yet.
     * Without it, an expired session is only logged.
     */
    readonly renewSession?: (sender: WebContents) => boolean;
    readonly now?: () => number;
  },
): { forget(windowId: string): void } {
  const connections = createConnectionLog(log, now);
  const renewal = createSessionRenewal(log, now);
  ipc.on(Channels.connectionState, (event, input) => {
    const windowId = windowIdFor(event.sender);
    const connection = parseRendererConnection(input);
    if (windowId === undefined || connection === undefined) return;
    connections.report(windowId, connection);
    if (renewSession !== undefined)
      renewal.report(windowId, connection, () => renewSession(event.sender));
  });
  return {
    forget: (windowId) => {
      connections.forget(windowId);
      renewal.forget(windowId);
    },
  };
}
