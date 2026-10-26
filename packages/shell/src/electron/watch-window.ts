// The renderer watchdog wired to a real window (`core/renderer-health.ts` decides): a renderer that
// died is reloaded, one that hangs is offered a reload in a dialog, and a page that failed to load
// is tried again, each within a budget, and each logged without the page's URL or content.

import { dialog, type BrowserWindow } from "electron";

import type { ShellLog } from "../core/log.ts";
import type { ShellProduct } from "../core/product.ts";
import { watchRenderer, type RendererEvents } from "../core/renderer-health.ts";

/** Watches `win` until it closes. */
export function watchWindow(
  win: BrowserWindow,
  {
    windowId,
    log,
    product,
    reload,
  }: {
    readonly windowId: string;
    readonly log: ShellLog;
    readonly product: ShellProduct;
    /** Loads the app into the window again, on a fresh boot URL. */
    readonly reload: () => void;
  },
): void {
  const contents = win.webContents;
  const events: RendererEvents = {
    on: (event: string, listener: (...args: never[]) => void) =>
      contents.on(event as "unresponsive", listener),
  };
  watchRenderer(events, {
    windowId,
    log,
    reload,
    crash: () => contents.forcefullyCrashRenderer(),
    offerReload: async () =>
      (
        await dialog.showMessageBox(win, {
          type: "warning",
          message: `This ${product.name} window isn't responding`,
          detail:
            "Reload it to start the window again. Your threads are saved, but text you haven't " +
            "sent yet may be lost. Or wait for it to recover.",
          buttons: ["Reload", "Wait"],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        })
      ).response === 0,
    alive: () => !win.isDestroyed(),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout),
    now: Date.now,
  });
}
