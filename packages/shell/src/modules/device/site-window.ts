import { createHash } from "node:crypto";
import { BrowserWindow, ipcMain, session as sessions, type WebContents } from "electron";
import type { SignedTurnGrant } from "@gram/contracts";
import { markDecisionWindow } from "../../electron/decision-windows.ts";
import { HOSTED_SITE_TURN_GRANT } from "./site-channel.ts";
import {
  fromSitePage,
  makeSiteGestures,
  type SiteGestures,
  siteThreadIdOf,
  staysIn,
} from "./site-gesture.ts";

/**
 * A hosted server's own site in a window of its own (`docs/design/personal-device.md`, "The
 * hosted site window"): the server's pages, signed in to there as in a browser, in a session
 * partition of that server's alone, with none of the app's bridge. Its preload gives the page one
 * call, a turn grant for the message the person is sending, which the main process answers only
 * for the server's own top page, right after the person pressed Enter or clicked in the window,
 * and only while this machine lends to the workspace the window was opened for.
 */

export interface SiteWindowsOptions {
  /** The preload that gives the page `window.gramHostedSite`, and nothing else. */
  readonly preload: string;
  readonly turnGrant: (
    origin: string,
    workspace: string,
    thread: string,
  ) => SignedTurnGrant | undefined;
  /** A link the site opens elsewhere, through the app's link-trust prompt. */
  readonly openLink: (url: string, from: BrowserWindow) => void;
}

interface Site {
  readonly origin: string;
  readonly workspace: string;
  readonly gestures: SiteGestures;
}

const partitionOf = (origin: string) =>
  `persist:gram-hosted-site-${createHash("sha256").update(origin).digest("hex").slice(0, 32)}`;

const DENY_ALL = () => false;

export const makeSiteWindows = (options: SiteWindowsOptions) => {
  const open = new Map<string, BrowserWindow>();
  const sites = new WeakMap<WebContents, Site>();
  const sealed = new Set<string>();

  const seal = (partition: string) => {
    if (sealed.has(partition)) return;
    sealed.add(partition);
    const kept = sessions.fromPartition(partition);
    kept.setPermissionRequestHandler((_contents, _permission, answer) => answer(false));
    kept.setPermissionCheckHandler(DENY_ALL);
    kept.setDevicePermissionHandler(DENY_ALL);
    kept.on("will-download", (event) => event.preventDefault());
  };

  ipcMain.handle(HOSTED_SITE_TURN_GRANT, (event, arg: unknown) => {
    const site = sites.get(event.sender);
    if (site === undefined) return null;
    const frame = event.senderFrame;
    if (
      !fromSitePage(
        { mainFrame: frame !== null && frame === event.sender.mainFrame, url: frame?.url },
        site.origin,
      )
    )
      return null;
    const threadId = siteThreadIdOf(arg);
    if (threadId === undefined || !site.gestures.take()) return null;
    return options.turnGrant(site.origin, site.workspace, threadId) ?? null;
  });

  return {
    /** Opens the window for `page`, a page of `origin`'s site for `workspace`, or brings it up. */
    open: (origin: string, workspace: string, page: string): void => {
      const key = `${origin} ${workspace}`;
      const there = open.get(key);
      if (there !== undefined && !there.isDestroyed()) {
        there.show();
        there.focus();
        return;
      }
      const partition = partitionOf(origin);
      seal(partition);
      const win = new BrowserWindow({
        width: 1280,
        height: 860,
        show: false,
        title: new URL(origin).host,
        webPreferences: {
          partition,
          preload: options.preload,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          nodeIntegrationInSubFrames: false,
          webSecurity: true,
          webviewTag: false,
          navigateOnDragDrop: false,
          safeDialogs: true,
          spellcheck: true,
        },
      });
      markDecisionWindow(win.webContents);
      const contents = win.webContents;
      const gestures = makeSiteGestures();
      sites.set(contents, { origin, workspace, gestures });
      contents.on("before-input-event", (_event, input) => gestures.input(input));
      contents.on("input-event", (_event, input) => {
        if (input.type === "mouseDown") gestures.pointer();
      });
      contents.setWindowOpenHandler(({ url }) => {
        options.openLink(url, win);
        return { action: "deny" };
      });
      const stay = (event: { preventDefault(): void; url: string }) => {
        if (staysIn(event.url, origin)) return;
        event.preventDefault();
        options.openLink(event.url, win);
      };
      contents.on("will-navigate", stay);
      contents.on("will-redirect", stay);
      contents.on("page-title-updated", (event, title) => {
        event.preventDefault();
        const host = (() => {
          try {
            return new URL(contents.getURL()).host;
          } catch {
            return new URL(origin).host;
          }
        })();
        win.setTitle(title.trim() === "" ? host : `${host}: ${title.slice(0, 120)}`);
      });
      win.once("ready-to-show", () => win.show());
      win.on("closed", () => {
        if (open.get(key) === win) open.delete(key);
      });
      open.set(key, win);
      void win.loadURL(page);
    },
    /** Closes the windows of a server, or of every server. */
    close: (origin?: string): void => {
      for (const [key, win] of open)
        if (origin === undefined || key.startsWith(`${origin} `)) {
          open.delete(key);
          if (!win.isDestroyed()) win.destroy();
        }
    },
  };
};

export type SiteWindows = ReturnType<typeof makeSiteWindows>;
