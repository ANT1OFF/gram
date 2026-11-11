import { BrowserWindow, type WebContents } from "electron";
import { type AskColors, askAnswerOf, askPage, type AskPageAnswer } from "./ask-page.ts";
import type { AskSurface } from "./ask-queue.ts";
import type { AskView } from "./ask-view.ts";

/**
 * The windows the main process owns for decisions: the ask, and later the lending sheet. Nothing
 * the app does to "all windows" may touch them (reload, hide, theme, vibrancy, notifications), so
 * those loops ask `isDecisionWindow` first.
 */
const decisionWindows = new WeakSet<WebContents>();

export const isDecisionWindow = (win: { readonly webContents: WebContents }): boolean =>
  decisionWindows.has(win.webContents);

export interface AskWindowOptions {
  readonly colors: () => AskColors;
  readonly answered: (show: string, answer: AskPageAnswer) => void;
  /** A session partition of the ask's own, never the app's: no cookies, storage or cache shared. */
  readonly partition?: string;
}

/** The ask, drawn in a window of its own that never takes the person's focus. */
export const makeAskWindow = (options: AskWindowOptions): AskSurface => {
  let win: BrowserWindow | undefined;
  let loaded: Promise<void> | undefined;

  const open = (): { win: BrowserWindow; loaded: Promise<void> } => {
    if (win !== undefined && !win.isDestroyed() && loaded !== undefined) return { win, loaded };
    const colors = options.colors();
    const next = new BrowserWindow({
      width: 520,
      height: 560,
      show: false,
      resizable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: false,
      title: "Gram is asking",
      backgroundColor: colors.background,
      webPreferences: {
        partition: options.partition ?? "gram-ask",
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
        devTools: false,
        javascript: true,
        images: false,
        webgl: false,
        navigateOnDragDrop: false,
        // The ask's own zoom, whatever the app's is.
        zoomFactor: 1,
      },
    });
    const contents = next.webContents;
    decisionWindows.add(contents);
    contents.setVisualZoomLevelLimits(1, 1).catch(() => undefined);
    contents.on("before-input-event", (event, input) => {
      // No zoom, no reload, no find: the page is drawn as it is.
      if (input.control || input.meta) event.preventDefault();
    });
    contents.on("will-navigate", (event) => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("page-title-updated", (event, title) => {
      event.preventDefault();
      const answer = askAnswerOf(title);
      if (answer !== undefined) options.answered(answer.show, answer.answer);
    });
    next.on("closed", () => {
      if (win === next) {
        win = undefined;
        loaded = undefined;
      }
    });
    const ready = new Promise<void>((done, failed) => {
      contents.once("did-finish-load", () => done());
      contents.once("did-fail-load", () => failed(new Error("The ask didn't load.")));
    });
    void next.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(askPage(colors))}`);
    win = next;
    loaded = ready;
    return { win: next, loaded: ready };
  };

  return {
    show: async (show, view: AskView) => {
      const opened = open();
      await opened.loaded;
      await opened.win.webContents.executeJavaScript(
        `window.showAsk(${JSON.stringify(show)}, ${JSON.stringify(view)})`,
      );
      // Shown without taking focus from what the person is typing in.
      if (!opened.win.isVisible()) opened.win.showInactive();
    },
    withdraw: (show, why) => {
      if (win === undefined || win.isDestroyed()) return;
      void win.webContents
        .executeJavaScript(`window.withdrawAsk(${JSON.stringify(show)}, ${JSON.stringify(why)})`)
        .catch(() => undefined);
    },
    hide: () => {
      if (win !== undefined && !win.isDestroyed()) win.hide();
    },
  };
};
