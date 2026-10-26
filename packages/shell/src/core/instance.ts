/** The window operations a second launch needs. */
export interface FocusableWindow {
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

/**
 * One running app per user: two servers on the same data dir
 * would race one SQLite file. A second launch quits, and the first surfaces a window instead.
 */
export const claimSingleInstance = (app: {
  requestSingleInstanceLock(): boolean;
  quit(): void;
}): boolean => {
  if (app.requestSingleInstanceLock()) return true;
  app.quit();
  return false;
};

/** Brings the first window forward, or opens one when every window was closed (macOS). */
export const surfaceWindow = (windows: ReadonlyArray<FocusableWindow>, open: () => void): void => {
  const win = windows[0];
  if (win === undefined) {
    open();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
};
