import { readFileSync, renameSync, writeFileSync } from "node:fs";

import { nativeImage } from "electron";

import { Channels } from "../../channels.ts";
import { createBrowseHostList, type BrowseHostList } from "../../core/browse-rules.ts";
import type { ShellLog } from "../../core/log.ts";
import type { ShellIpc } from "../ipc.ts";
import { appWindows } from "../../electron/decision-windows.ts";
import { fieldsOf } from "@gram/contracts";

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
        return fieldsOf(JSON.parse(readFileSync(path, "utf8"))).get("hosts");
      } catch {
        return [];
      }
    },
    save: (list) => {
      try {
        writeFileSync(`${path}.tmp`, JSON.stringify({ hosts: list }));
        renameSync(`${path}.tmp`, path);
      } catch (error) {
        log.warn({ source: "agent-browse", error: String(error) }, "couldn't save the hosts");
      }
    },
    changed: (list) => {
      for (const win of appWindows()) {
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

export { createAgentPanes, type AgentPanes, type PaneViews } from "./pane.ts";
export { servePaneMessage } from "./serve.ts";
