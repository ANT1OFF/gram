// The connection module's main half: what each window says of its socket to the server, written to
// the shell's log, so a hung window can be told from a lost server (`createConnectionLog`).

import type { WebContents } from "electron";

import { Channels } from "../../channels.ts";
import type { ShellLog } from "../../core/log.ts";
import { createConnectionLog, parseRendererConnection } from "../../core/renderer-health.ts";
import type { ShellIpc } from "../ipc.ts";

/** Logs each window's reports; `forget` a window when it closes. */
export function installConnection(
  ipc: ShellIpc,
  {
    log,
    windowIdFor,
    now = Date.now,
  }: {
    readonly log: ShellLog;
    /** Which app window `sender` is; reports from any other page are dropped. */
    readonly windowIdFor: (sender: WebContents) => string | undefined;
    readonly now?: () => number;
  },
): { forget(windowId: string): void } {
  const connections = createConnectionLog(log, now);
  ipc.on(Channels.connectionState, (event, input) => {
    const windowId = windowIdFor(event.sender);
    const connection = parseRendererConnection(input);
    if (windowId !== undefined && connection !== undefined)
      connections.report(windowId, connection);
  });
  return { forget: (windowId) => connections.forget(windowId) };
}
