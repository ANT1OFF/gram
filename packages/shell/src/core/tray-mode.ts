// Closing the last window on Windows and Linux quits the app, as is their convention, unless the
// user turned on "Keep running in the tray". Then the app shows a tray icon with its asks and
// workspaces (`tray-menu.ts`), and the first time the last window closes into it, a notice says
// where the app went (an app that went on running with no sign of it looked as if it had
// vanished). macOS keeps its own convention, where the Dock holds a windowless app: the same
// setting there ("Show in menu bar") only shows the menu bar item, and closing changes nothing.

/** What `tray.json` keeps. */
export interface TrayPrefs {
  readonly keepInTray: boolean;
  /** Whether the "still running in the tray" notice has been shown. */
  readonly noticeShown: boolean;
}

export const DEFAULT_PREFS: TrayPrefs = { keepInTray: false, noticeShown: false };

/** The prefs in `text`; off, with no notice shown, for anything unreadable. */
export function parseTrayPrefs(text: string | undefined): TrayPrefs {
  if (text === undefined) return DEFAULT_PREFS;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_PREFS;
    return {
      keepInTray: Reflect.get(parsed, "keepInTray") === true,
      noticeShown: Reflect.get(parsed, "noticeShown") === true,
    };
  } catch {
    // Torn by a crash mid-write, or edited by hand: off is the platform's own behaviour.
    return DEFAULT_PREFS;
  }
}

/** Whether closing the last window can leave the app in the tray: everywhere but macOS. */
export const trayPlatform = (platform: NodeJS.Platform): boolean => platform !== "darwin";

/**
 * What closing the last window does: `stay` on macOS (the Dock holds the app), `tray` when the
 * user keeps it there, else `quit`.
 */
export function lastWindowClosed(
  platform: NodeJS.Platform,
  keepInTray: boolean,
): "stay" | "tray" | "quit" {
  if (!trayPlatform(platform)) return "stay";
  return keepInTray ? "tray" : "quit";
}
