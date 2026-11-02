// "Open at login". The OS keeps the setting, not Gram: on macOS Electron registers the app itself
// with `SMAppService` (`mainAppService`), which lists it under its name and team in System Settings
// → General → Login Items and keeps it across signed updates, since the registration follows the
// bundle identifier and team rather than one build. On Windows it is the run key, given an argument
// so a login launch can tell itself apart. Nothing here registers or removes the item at startup,
// so an update never undoes the user's choice, and one removed in System Settings stays removed.
// Linux has no API for it: there it is an XDG autostart entry (`~/.config/autostart/gram.desktop`)
// that Gram writes and removes itself, which GNOME, KDE and the other XDG desktops run at login and
// list in their own autostart settings.

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { LaunchAtLogin } from "@gram/contracts";

/** The argument a Windows or Linux login launch carries; macOS reports a login launch itself. */
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

/** Linux's login item: an XDG autostart entry, and what it launches. */
export interface Autostart {
  /** The executable to start: the AppImage itself (`$APPIMAGE`), else the installed binary. */
  readonly exec: string;
  /** The entry's text; undefined when there is none. */
  read(): string | undefined;
  write(text: string): void;
  remove(): void;
}

/**
 * One argument of a desktop entry's `Exec` key, as the Desktop Entry spec reads it back. `%` is
 * doubled everywhere, since field codes start with it. Anything beyond plain path characters is
 * double-quoted, with `"`, `` ` ``, `$` and `\` backslash-escaped inside; the key is also a string
 * value, whose own escapes are undone first, so every backslash is then doubled once more.
 */
export const desktopExecArg = (arg: string): string => {
  // A line break would end the key, and the line after it could be any key at all.
  // oxlint-disable-next-line no-control-regex -- control characters are what this refuses
  if (/[\u0000-\u001f\u007f]/.test(arg))
    throw new Error("the app's path can't be started at login");
  const percent = arg.replaceAll("%", "%%");
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(percent)) return percent;
  return `"${percent.replace(/(["`$\\])/g, "\\$1")}"`.replaceAll("\\", "\\\\");
};

/** What marks an autostart entry as Gram's own, so Gram never rewrites or removes anyone else's. */
const GRAM_ENTRY_MARK = "X-Gram-Autostart=true";

/** The autostart entry that starts `exec` at login, marked as a login launch. */
export const autostartEntry = (exec: string): string =>
  [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Gram",
    "Comment=Starts Gram when you log in",
    `Exec=${desktopExecArg(exec)} ${LOGIN_ARG}`,
    "Icon=gram",
    "Terminal=false",
    "X-GNOME-Autostart-enabled=true",
    GRAM_ENTRY_MARK,
    "",
  ].join("\n");

/** Whether `text` is an entry Gram wrote: marked, or (before the mark) Gram's name and argument. */
export const isGramEntry = (text: string): boolean =>
  text.split(/\r?\n/).includes(GRAM_ENTRY_MARK) ||
  (/^Name=Gram\s*$/m.test(text) && new RegExp(`^Exec=.* ${LOGIN_ARG}\\s*$`, "m").test(text));

const execLine = (text: string): string | undefined => /^Exec=.*$/m.exec(text)?.[0];

/** Why turning the setting on or off leaves a `gram.desktop` that isn't Gram's alone. */
export const FOREIGN_ENTRY_MESSAGE =
  "~/.config/autostart/gram.desktop isn't one Gram wrote, so Gram leaves it alone. Change or remove it in your desktop's autostart settings.";

/** Whether an autostart entry runs at login: there, and not hidden or switched off by the desktop. */
export const autostartEnabled = (text: string | undefined): boolean =>
  text !== undefined &&
  /^\[Desktop Entry\]/m.test(text) &&
  !/^Hidden\s*=\s*true\s*$/im.test(text) &&
  !/^X-GNOME-Autostart-enabled\s*=\s*false\s*$/im.test(text);

/**
 * The autostart entry at `path`, read and written synchronously in main. A write goes to a temp
 * file beside it, renamed over it, so a crash leaves the old entry or the new one, never half of
 * one; the temp name doesn't end in `.desktop`, so no desktop runs it.
 */
export const fileAutostart = (path: string, exec: string): Autostart => ({
  exec,
  read: () => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  },
  write: (text) => {
    mkdirSync(dirname(path), { recursive: true });
    const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    try {
      writeFileSync(temp, text, { flag: "wx", mode: 0o644 });
      renameSync(temp, path);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
  },
  remove: () => rmSync(path, { force: true }),
});

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
 * The login item for an installed app on macOS or Windows, or the autostart entry on Linux. A
 * development run would register the bare Electron binary, so it doesn't offer the setting, and
 * neither does Linux without an `autostart`; a login launch there is never assumed.
 */
export function createLoginItem(deps: {
  readonly api: LoginItemApi;
  readonly platform: NodeJS.Platform;
  readonly packaged: boolean;
  readonly argv: readonly string[];
  readonly openExternal: (url: string) => Promise<void>;
  /** Linux's autostart entry; absent elsewhere. */
  readonly autostart?: Autostart;
}): LoginItem {
  const { api, platform } = deps;
  const autostart = platform === "linux" ? deps.autostart : undefined;
  const supported =
    deps.packaged && (platform === "darwin" || platform === "win32" || autostart !== undefined);
  const args = platform === "win32" ? { args: [LOGIN_ARG] } : {};

  // An entry Gram wrote for another executable (a versioned AppImage since replaced, or one moved)
  // would start nothing at login while Settings said on: at launch it is pointed at this one. Only
  // an entry that is on and Gram's own; failing that, the next set() writes it.
  if (supported && autostart !== undefined) {
    try {
      const text = autostart.read();
      const fresh = autostartEntry(autostart.exec);
      if (
        text !== undefined &&
        isGramEntry(text) &&
        autostartEnabled(text) &&
        execLine(text) !== execLine(fresh)
      ) {
        autostart.write(fresh);
      }
    } catch {
      // A path that can't go in an entry, or a folder that can't be written: left as it is.
    }
  }

  const state = (): LaunchAtLogin | null => {
    if (!supported) return null;
    if (autostart !== undefined) {
      return { enabled: autostartEnabled(autostart.read()), needsApproval: false };
    }
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
      if (autostart !== undefined) {
        const text = autostart.read();
        if (text !== undefined && !isGramEntry(text)) throw new Error(FOREIGN_ENTRY_MESSAGE);
        if (enabled) autostart.write(autostartEntry(autostart.exec));
        else if (text !== undefined) autostart.remove();
      } else {
        api.setLoginItemSettings({ openAtLogin: enabled, ...args });
      }
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
 * Dock icon (and the menu bar item, when shown) is one; on Windows and Linux a hidden window leaves
 * the taskbar, so only the tray icon is, and without it the windows show as usual.
 */
export const startsHidden = (
  platform: NodeJS.Platform,
  launchedAtLogin: boolean,
  keepInTray: boolean,
): boolean => launchedAtLogin && (platform === "darwin" || keepInTray);
