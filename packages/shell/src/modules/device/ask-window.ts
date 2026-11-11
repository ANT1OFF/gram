import { app, BrowserWindow, screen, type WebContents } from "electron";
import { type AskColors, askAnswerOf, askPage, type AskPageAnswer } from "./ask-page.ts";
import type { AskSurface } from "./ask-queue.ts";
import type { AskView } from "./ask-view.ts";

/**
 * The windows the main process owns for decisions: the ask, and later the lending sheet. Nothing
 * the app does to "all windows" may touch them (reload, hide, theme, vibrancy, notifications), so
 * those loops must ask `isDecisionWindow` first (done where the window is installed).
 */
const decisionWindows = new WeakSet<WebContents>();

export const isDecisionWindow = (win: { readonly webContents: WebContents }): boolean =>
  decisionWindows.has(win.webContents);

export interface AskWindowOptions {
  readonly colors: () => AskColors;
  readonly answered: (show: string, answer: AskPageAnswer) => void;
  /** The window that drew this show went: closed, crashed, hung, reloaded, or failed to load. */
  readonly gone: (show: string) => void;
  /** A session partition of the ask's own, never the app's: no cookies, storage or cache shared. */
  readonly partition?: string;
}

const WIDTH = 520;
const HEIGHT = 560;
const MARGIN = 24;

/** The corner of the screen farthest from the pointer, so the ask doesn't open under it. */
const awayFromPointer = (width = WIDTH, height = HEIGHT): { x: number; y: number } => {
  const pointer = screen.getCursorScreenPoint();
  const area = screen.getDisplayNearestPoint(pointer).workArea;
  const right = pointer.x < area.x + area.width / 2;
  const bottom = pointer.y < area.y + area.height / 2;
  return {
    x: Math.round(right ? area.x + Math.max(0, area.width - width - MARGIN) : area.x + MARGIN),
    y: Math.round(bottom ? area.y + Math.max(0, area.height - height - MARGIN) : area.y + MARGIN),
  };
};

/** The ask, drawn in a window of its own that never takes the person's focus. */
export const makeAskWindow = (options: AskWindowOptions): AskSurface => {
  let win: BrowserWindow | undefined;
  let loaded: Promise<void> | undefined;
  /** The show last drawn in each window, for when that window goes. */
  const drawn = new WeakMap<BrowserWindow, string>();
  // Once the app quits, no ask opens a window: each is refused.
  let quitting = false;
  app.once("before-quit", () => {
    quitting = true;
  });

  const open = (): { win: BrowserWindow; loaded: Promise<void> } => {
    if (quitting) throw new Error("The app is quitting.");
    if (win !== undefined && !win.isDestroyed() && loaded !== undefined) return { win, loaded };
    const colors = options.colors();
    const next = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      ...awayFromPointer(),
      show: false,
      resizable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      // A click on the ask while another app has focus reaches it, as on other systems; the
      // page still wants the pointer moved and pressed after its second.
      acceptFirstMouse: true,
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
    // A window that crashed, hung, reloaded or failed to load is closed whole, never reused:
    // its ask goes with it, and the next ask opens a fresh one.
    let finished = false;
    const end = () => {
      if (!next.isDestroyed()) next.destroy();
    };
    contents.on("render-process-gone", end);
    contents.on("unresponsive", end);
    contents.on("did-start-loading", () => {
      if (finished) end();
    });
    next.on("closed", () => {
      if (win === next) {
        win = undefined;
        loaded = undefined;
      }
      const show = drawn.get(next);
      if (show !== undefined) options.gone(show);
    });
    const ready = new Promise<void>((done, failed) => {
      contents.once("did-finish-load", () => {
        finished = true;
        done();
      });
      contents.once("did-fail-load", () => {
        failed(new Error("The ask didn't load."));
        end();
      });
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
      drawn.set(opened.win, show);
      await opened.win.webContents.executeJavaScript(
        `window.showAsk(${JSON.stringify(show)}, ${JSON.stringify(view)})`,
      );
      // Shown without taking focus from what the person is typing in, away from their pointer.
      if (!opened.win.isVisible()) {
        const [width, height] = opened.win.getSize();
        const { x, y } = awayFromPointer(width, height);
        opened.win.setPosition(x, y);
        opened.win.showInactive();
      }
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
