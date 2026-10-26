import { BrowserWindow } from "electron";

import { QUIT_NOW_TITLE, quitPage } from "./quit-page.ts";
import { quitDetail, type QuitProgress } from "./quit.ts";

/**
 * The small "Quitting Gram…" window a slow quit shows, with Quit Now. `show` opens it or
 * updates it; Quit Now calls `onForce`. It goes with the app's exit, so nothing closes it.
 */
export function createQuitWindow(options: {
  readonly colors: () => { readonly background: string; readonly foreground: string };
  readonly onForce: () => void;
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
    show(progress: QuitProgress) {
      detail = quitDetail(progress);
      if (win !== undefined) return render();
      const colors = options.colors();
      win = new BrowserWindow({
        width: 380,
        height: 124,
        show: false,
        frame: false,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        alwaysOnTop: true,
        center: true,
        title: "Quitting Gram",
        backgroundColor: colors.background,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      const contents = win.webContents;
      contents.on("page-title-updated", (event, title) => {
        event.preventDefault();
        if (title === QUIT_NOW_TITLE) options.onForce();
      });
      contents.on("did-finish-load", render);
      win.once("ready-to-show", () => win?.show());
      void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(quitPage(colors))}`);
    },
  };
}
