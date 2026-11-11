import { BrowserWindow } from "electron";

import { QUIT_NOW_TITLE, quitPage } from "./quit-page.ts";
import { quitDetail, type QuitProgress } from "./quit.ts";

/**
 * The small progress window a slow quit shows ("Quitting Gram…", with Quit Now), or an update's
 * stop ("Restarting to update…", without it: a quit then cancels the update instead). `show` opens
 * it or updates its line; Quit Now calls `onForce`. A quit's goes with the app's exit; `close`
 * takes down an update's that didn't end in one.
 */
export function createQuitWindow(options: {
  readonly colors: () => { readonly background: string; readonly foreground: string };
  readonly heading?: string;
  readonly onForce?: () => void;
  readonly title?: string;
}) {
  let win: BrowserWindow | undefined;
  let detail = "";
  const render = () => {
    if (win === undefined || win.isDestroyed()) return;
    void win.webContents
      .executeJavaScript(`window.setDetail(${JSON.stringify(detail)})`)
      // The page may not have loaded yet; `did-finish-load` renders it then.
      .catch(() => {});
  };
  return {
    show(progress: QuitProgress | string) {
      detail = typeof progress === "string" ? progress : quitDetail(progress);
      if (win !== undefined && !win.isDestroyed()) return render();
      const colors = options.colors();
      win = new BrowserWindow({
        width: 380,
        height: options.onForce === undefined ? 84 : 124,
        show: false,
        frame: false,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        alwaysOnTop: true,
        center: true,
        title: options.title ?? "Quitting Gram",
        backgroundColor: colors.background,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      const contents = win.webContents;
      contents.on("page-title-updated", (event, title) => {
        event.preventDefault();
        if (title === QUIT_NOW_TITLE) options.onForce?.();
      });
      contents.on("did-finish-load", render);
      const opened = win;
      win.once("ready-to-show", () => {
        if (!opened.isDestroyed()) opened.show();
      });
      const page = quitPage(colors, {
        ...(options.heading === undefined ? {} : { heading: options.heading }),
        quitNow: options.onForce !== undefined,
      });
      void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
    },
    /** Whether it is open, so a server report updates it only while it shows. */
    open: () => win !== undefined && !win.isDestroyed(),
    close() {
      if (win !== undefined && !win.isDestroyed()) win.destroy();
      win = undefined;
    },
  };
}
