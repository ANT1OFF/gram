// Link trust wired to Electron: the shell's dialog asks before a link leaves the app, unless its
// host is trusted, and the hosts trusted from it are kept in a file. The decisions are the link
// gate's (`core/link-gate.ts`); this module only shows them and keeps the file.

import { readFileSync, renameSync, writeFileSync } from "node:fs";

import { BrowserWindow, clipboard, dialog, shell, type MessageBoxOptions } from "electron";

import { Channels } from "../channels.ts";
import { createLinkGate, type LinkGate } from "../core/link-gate.ts";

/** Set by `loadLinkTrust` before the first window; until then nothing opens. */
let gate: LinkGate<BrowserWindow> | undefined;

const BUTTONS = ["Open", "Copy Link", "Cancel"] as const;

/** Reads the trusted hosts from `path` and opens every link through the gate from here on. */
export function loadLinkTrust(path: string) {
  gate = createLinkGate<BrowserWindow>({
    load: () => {
      try {
        return (JSON.parse(readFileSync(path, "utf8")) as { hosts?: unknown }).hosts;
      } catch {
        // Missing or unreadable: nothing is trusted, so every link asks.
        return [];
      }
    },
    save: (hosts) => {
      try {
        writeFileSync(`${path}.tmp`, JSON.stringify({ hosts }));
        renameSync(`${path}.tmp`, path);
      } catch (error) {
        // The change holds until quit; the next launch asks again for what it couldn't save.
        process.stderr.write(`links: couldn't save the trusted hosts: ${String(error)}\n`);
      }
    },
    ask: async (prompt, window) => {
      const options: MessageBoxOptions = {
        type: "question",
        buttons: [...BUTTONS],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
        ...prompt,
      };
      const { response, checkboxChecked } =
        window === undefined || window.isDestroyed()
          ? await dialog.showMessageBox(options)
          : await dialog.showMessageBox(window, options);
      return {
        action: response === 0 ? "open" : response === 1 ? "copy" : "cancel",
        trust: checkboxChecked,
      };
    },
    open: (url) => shell.openExternal(url),
    copy: (text) => clipboard.writeText(text),
    changed: (hosts) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.webContents.isDestroyed()) {
          win.webContents.send(Channels.trustedLinksChanged, hosts);
        }
      }
    },
  });
}

/** Opens `url` in the default browser if its host is trusted or the user says so. */
export const openLink = (url: string, window?: BrowserWindow): Promise<boolean> =>
  gate?.open(url, window) ?? Promise.resolve(false);

export const trustedLinkHosts = (): readonly string[] => gate?.hosts() ?? [];

export const untrustLinkHost = (host: string) => gate?.remove(host);
