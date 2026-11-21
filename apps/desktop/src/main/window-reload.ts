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
