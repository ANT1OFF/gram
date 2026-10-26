// The agent browser module's main half: Settings → Agent may browse, the public hosts agents may
// open in the Preview pane without a card. Kept in a file of its own beside the trusted links,
// since trusting a link to open isn't trusting an agent on the site. The renderer can list and
// remove hosts; only an approval card's "Always for this host", answered in the server and sent
// here as a pane command, adds one.

import { readFileSync, renameSync, writeFileSync } from "node:fs";

import { BrowserWindow, nativeImage } from "electron";

import {
  paneRequestMessage,
  paneCancelMessage,
  type PaneResponseMessage,
  type PaneResult,
} from "@gram/contracts/link-trust";

import { Channels } from "../../channels.ts";
import { createBrowseHostList, type BrowseHostList } from "../../core/browse-rules.ts";
import type { ShellLog } from "../../core/log.ts";
import type { ShellIpc } from "../ipc.ts";
import type { AgentPanes } from "./pane.ts";

/** A recording frame's JPEG as BGRA pixels, through Chromium's own decoder. */
export const decodeFrame = (
  jpegBase64: string,
): { width: number; height: number; pixels: Uint8Array } | undefined => {
  const image = nativeImage.createFromBuffer(Buffer.from(jpegBase64, "base64"));
  if (image.isEmpty()) return undefined;
  const { width, height } = image.getSize();
  return { width, height, pixels: new Uint8Array(image.toBitmap()) };
};

/** Reads the list from `path`, serves `agentBrowse` and returns the list for the pane. */
export function installAgentBrowse(
  ipc: ShellIpc,
  options: { readonly path: string; readonly log: ShellLog },
): BrowseHostList {
  const { path, log } = options;
  const hosts = createBrowseHostList({
    load: () => {
      try {
        return (JSON.parse(readFileSync(path, "utf8")) as { hosts?: unknown }).hosts;
      } catch {
        // Missing or unreadable: no host is approved, so every public one asks.
        return [];
      }
    },
    save: (list) => {
      try {
        writeFileSync(`${path}.tmp`, JSON.stringify({ hosts: list }));
        renameSync(`${path}.tmp`, path);
      } catch (error) {
        // The change holds until quit; the next launch asks again for what it couldn't save.
        log.warn({ source: "agent-browse", error: String(error) }, "couldn't save the hosts");
      }
    },
    changed: (list) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.webContents.isDestroyed()) win.webContents.send(Channels.agentBrowseChanged, list);
      }
    },
  });
  ipc.handle(Channels.agentBrowseList, () => hosts.hosts());
  ipc.handle(Channels.agentBrowseRemove, (host) => {
    if (typeof host === "string") hosts.remove(host);
  });
  return hosts;
}

/**
 * Answers the desktop server's `pane.request` through `panes`, ignoring every other message; with
 * no panes yet, early in launch, the answer is that there is no pane.
 */
export function servePaneMessage(
  message: unknown,
  panes: AgentPanes | undefined,
  reply: (response: PaneResponseMessage) => void,
): void {
  const cancellation = paneCancelMessage(message);
  if (cancellation !== undefined) {
    panes?.cancel(cancellation.id);
    return;
  }
  const request = paneRequestMessage(message);
  if (request === undefined) return;
  const answer: Promise<PaneResult> =
    panes === undefined
      ? Promise.resolve({ ok: false, code: "noPane", message: "The Preview pane isn't ready yet." })
      : panes.serve(request.request, request.id);
  void answer.then((result) => reply({ type: "pane.response", id: request.id, result }));
}

export { createAgentPanes, type AgentPanes, type PaneViews } from "./pane.ts";
