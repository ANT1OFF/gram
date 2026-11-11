// Reloading windows onto a fresh server (a new port and token). Only the app's own windows load
// its page: a progress window ("Quitting Gram…", "Restarting to update…") is a page of its own,
// and navigating it would lose the line it shows, an update's retry among them. Electron stays
// out of this module, so tests drive it with fakes.

/** What a reload needs of a window. */
export interface ReloadableWindow {
  readonly webContents: { isDestroyed(): boolean };
  loadURL(url: string): Promise<void>;
}

/** Loads `url` in every window of `windows` still alive that isn't a progress window. */
export function reloadOnto<W extends ReloadableWindow>(
  url: string,
  windows: ReadonlyArray<W>,
  isProgress: (win: W) => boolean,
): void {
  for (const win of windows) {
    if (win.webContents.isDestroyed() || isProgress(win)) continue;
    void win.loadURL(url);
  }
}
