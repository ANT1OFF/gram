import { dialog, type BrowserWindow } from "electron";

import type { ShellLog } from "../core/log.ts";
import type { ShellProduct } from "../core/product.ts";
import { watchRenderer, type RendererEvents } from "../core/renderer-health.ts";
import { nodeTimers } from "../core/node-timers.ts";

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
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- WebContents overloads `on` per event, which one string-typed call can't name
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
    ...nodeTimers(),
    now: Date.now,
  });
}
