// "Open at login". The OS keeps the setting, not Gram: on macOS Electron registers the app itself
// with `SMAppService` (`mainAppService`), which lists it under its name and team in System Settings
// → General → Login Items and keeps it across signed updates, since the registration follows the
// bundle identifier and team rather than one build. On Windows it is the run key, given an argument
// so a login launch can tell itself apart. Nothing here registers or removes the item at startup,
// so an update never undoes the user's choice, and one removed in System Settings stays removed.

import type { LaunchAtLogin } from "@gram/contracts";

/** The argument a Windows login launch carries; macOS reports a login launch itself. */
export const LOGIN_ARG = "--launched-at-login";

/** macOS System Settings → General → Login Items. */
export const LOGIN_ITEMS_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.LoginItems-Settings.extension";

/** The slice of Electron's `app` this needs. */
export interface LoginItemApi {
  getLoginItemSettings(options?: { readonly args?: string[] }): {
    readonly openAtLogin: boolean;
    readonly wasOpenedAtLogin?: boolean;
    readonly status?: string;
  };
  setLoginItemSettings(settings: { readonly openAtLogin: boolean; readonly args?: string[] }): void;
}

export interface LoginItem {
  /** The setting; null where it isn't offered. */
  state(): LaunchAtLogin | null;
  /** Registers or removes the login item, and reads back what the OS kept. */
  set(enabled: boolean): LaunchAtLogin | null;
  /** Whether this process is a login launch, which starts with its windows hidden. */
  readonly launchedAtLogin: boolean;
  openSettings(): Promise<boolean>;
}

/**
 * The login item for an installed app on macOS or Windows. A development run would register the
 * bare Electron binary, and Linux has no API for it, so neither offers the setting; a login launch
 * there is never assumed.
 */
export function createLoginItem(deps: {
  readonly api: LoginItemApi;
  readonly platform: NodeJS.Platform;
  readonly packaged: boolean;
  readonly argv: readonly string[];
  readonly openExternal: (url: string) => Promise<void>;
}): LoginItem {
  const { api, platform } = deps;
  const supported = deps.packaged && (platform === "darwin" || platform === "win32");
  const args = platform === "win32" ? { args: [LOGIN_ARG] } : {};

  const state = (): LaunchAtLogin | null => {
    if (!supported) return null;
    const settings = api.getLoginItemSettings(args);
    const needsApproval = platform === "darwin" && settings.status === "requires-approval";
    // Registered but waiting for approval doesn't launch anything yet; the row says so.
    return { enabled: settings.openAtLogin || needsApproval, needsApproval };
  };

  let launchedAtLogin = false;
  if (supported) {
    launchedAtLogin =
      platform === "darwin"
        ? api.getLoginItemSettings().wasOpenedAtLogin === true
        : deps.argv.includes(LOGIN_ARG);
  }

  return {
    state,
    set(enabled) {
      if (!supported) return null;
      api.setLoginItemSettings({ openAtLogin: enabled, ...args });
      return state();
    },
    launchedAtLogin,
    async openSettings() {
      if (platform !== "darwin") return false;
      try {
        await deps.openExternal(LOGIN_ITEMS_SETTINGS_URL);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * Whether a launch starts with its windows hidden: a login launch with a way back. On macOS the
 * Dock icon (and the menu bar item, when shown) is one; on Windows a hidden window leaves the
 * taskbar, so only the tray icon is, and without it the windows show as usual.
 */
export const startsHidden = (
  platform: NodeJS.Platform,
  launchedAtLogin: boolean,
  keepInTray: boolean,
): boolean => launchedAtLogin && (platform === "darwin" || keepInTray);
