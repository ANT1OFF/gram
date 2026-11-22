import { BrowserWindow, type WebContents } from "electron";

const decisionWindows = new WeakSet<WebContents>();

export const markDecisionWindow = (contents: WebContents): void => {
  decisionWindows.add(contents);
};

export const isDecisionWindow = (win: { readonly webContents: WebContents }): boolean =>
  decisionWindows.has(win.webContents);

/** Every window but the decision windows: the ones the app may reload, hide, theme and message. */
export const appWindows = (): Array<BrowserWindow> =>
  BrowserWindow.getAllWindows().filter((win) => !isDecisionWindow(win));

/** The focused window, unless it is a decision window. */
export const focusedAppWindow = (): BrowserWindow | null => {
  const win = BrowserWindow.getFocusedWindow();
  return win === null || isDecisionWindow(win) ? null : win;
};
