// The tray module's main half, behind "Keep running in the tray" (`core/tray-mode.ts`), which on
// macOS is the menu bar item: its icon and menu of asks and workspaces (`core/tray-menu.ts`), the
// file that keeps the setting, the one-time notice, and the `keepInTray` and tray menu IPC.

import { readFileSync, writeFileSync } from "node:fs";

import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  Notification,
  Tray,
  type MenuItemConstructorOptions,
  type NativeImage,
  type WebContents,
} from "electron";
import { EMPTY_TRAY_MENU, type TrayAction, type TrayMenu } from "@gram/contracts/desktop-bridge";

import { Channels } from "../../channels.ts";
import type { ShellProduct } from "../../core/product.ts";
import {
  menuLabel,
  parseTrayMenu,
  trayAskCount,
  trayEntries,
  trayGlyphBitmap,
  type TrayEntry,
} from "../../core/tray-menu.ts";
import { DEFAULT_PREFS, parseTrayPrefs } from "../../core/tray-mode.ts";
import { focusWindow, showNotification } from "../../electron/windows.ts";
import type { ShellIpc } from "../ipc.ts";

const isMac = process.platform === "darwin";

/** The menu bar glyph as a template image, which macOS tints for light, dark and highlighted. */
const menuBarIcon = (): NativeImage => {
  const image = nativeImage.createFromBitmap(trayGlyphBitmap(32), {
    width: 32,
    height: 32,
    scaleFactor: 2,
  });
  image.setTemplateImage(true);
  return image;
};

/** The tray icon, the setting behind it, its menu, and its one-time notice. */
export function createTrayMode(options: {
  readonly product: ShellProduct;
  readonly path: string;
  /** Brings a window forward, or opens one. */
  readonly show: () => void;
  readonly quit: () => void;
}) {
  let prefs = DEFAULT_PREFS;
  let tray: Tray | undefined;
  let icon: NativeImage | undefined;
  /** Held so the notice isn't garbage-collected while it shows. */
  let notice: Notification | undefined;
  /** Each window's last menu; the newest from a live window is the one shown. */
  const menus = new Map<number, { contents: WebContents; menu: TrayMenu; at: number }>();
  let sent = 0;
  try {
    prefs = parseTrayPrefs(readFileSync(options.path, "utf8"));
  } catch {
    // No file before the setting is first changed.
  }

  const save = () => {
    try {
      writeFileSync(options.path, JSON.stringify(prefs));
    } catch (error) {
      // The setting lasts until the app quits, and the notice may show once more.
      process.stderr.write(`tray: couldn't save ${options.path}: ${String(error)}\n`);
    }
  };

  const newest = () => {
    let best: { contents: WebContents; menu: TrayMenu; at: number } | undefined;
    for (const entry of menus.values()) {
      if (entry.contents.isDestroyed()) continue;
      if (best === undefined || entry.at > best.at) best = entry;
    }
    return best;
  };

  /**
   * What the user picked goes back to `owner`, the window whose menu it was, captured when the menu
   * was built: never to a window that sent a menu since, which may not know its tokens. An answer
   * or Pause all goes without bringing the window forward; opening something does. With the owner
   * gone, an answer or Pause all is dropped and anything else brings a window back.
   */
  const pick = (owner: WebContents | undefined, action: TrayAction) => {
    const inPlace = action.kind === "answer" || action.kind === "pauseAll";
    if (owner === undefined || owner.isDestroyed()) {
      if (!inPlace) options.show();
      return;
    }
    if (!inPlace) {
      const win = BrowserWindow.fromWebContents(owner);
      if (win !== null) focusWindow(win);
    }
    owner.send(Channels.trayAction, action);
  };

  const toElectron = (
    entries: readonly TrayEntry[],
    owner: WebContents | undefined,
  ): MenuItemConstructorOptions[] =>
    entries.map((entry): MenuItemConstructorOptions => {
      if (entry.kind === "separator") return { type: "separator" };
      const { run, submenu } = entry;
      const label = menuLabel(entry.label, process.platform);
      if (submenu !== undefined) return { label, submenu: toElectron(submenu, owner) };
      if (run === undefined) return { label, enabled: false };
      const click =
        run === "show" ? options.show : run === "quit" ? options.quit : () => pick(owner, run);
      return { label, click };
    });

  const rebuild = () => {
    if (tray === undefined) return;
    const shown = newest();
    const menu = shown?.menu ?? EMPTY_TRAY_MENU;
    const { name } = options.product;
    const asks = trayAskCount(menu);
    tray.setContextMenu(
      Menu.buildFromTemplate(toElectron(trayEntries(menu, name), shown?.contents)),
    );
    tray.setToolTip(asks === 0 ? name : `${name} · ${asks} ${asks === 1 ? "ask" : "asks"}`);
    if (isMac) tray.setTitle(asks === 0 ? "" : String(asks), { fontType: "monospacedDigit" });
  };

  const showTray = async () => {
    if (tray !== undefined || !prefs.keepInTray) return;
    // On macOS a template glyph for the menu bar; elsewhere the executable's own icon, which
    // carries `icon.ico` on Windows.
    icon ??= isMac
      ? menuBarIcon()
      : await app
          .getFileIcon(process.execPath, { size: "small" })
          .catch(() => nativeImage.createEmpty());
    if (tray !== undefined || !prefs.keepInTray) return;
    tray = new Tray(icon);
    // macOS opens a menu bar item's menu on click; elsewhere a click brings the window back.
    if (!isMac) tray.on("click", options.show);
    rebuild();
  };

  const hideTray = () => {
    tray?.destroy();
    tray = undefined;
  };

  return {
    /** Shows the tray icon, if the setting is on; call once the app is ready. */
    start(): void {
      void showTray();
    },
    keepInTray: (): boolean => prefs.keepInTray,
    setKeepInTray(enabled: boolean): void {
      if (enabled === prefs.keepInTray) return;
      prefs = { ...prefs, keepInTray: enabled };
      save();
      if (enabled) void showTray();
      else hideTray();
    },
    /** A window's asks and workspaces; replaces what it sent before. */
    setMenu(contents: WebContents, input: unknown): void {
      const known = menus.has(contents.id);
      menus.set(contents.id, { contents, menu: parseTrayMenu(input), at: ++sent });
      if (!known) {
        // A window that closes takes its menu with it: nothing is left that could answer.
        contents.once("destroyed", () => {
          menus.delete(contents.id);
          rebuild();
        });
      }
      rebuild();
    },
    /** The last window has closed into the tray: says so, the first time. */
    closedToTray(): void {
      void showTray();
      if (prefs.noticeShown || !Notification.isSupported()) return;
      prefs = { ...prefs, noticeShown: true };
      save();
      notice = new Notification({
        title: `${options.product.name} is still running in the tray`,
        body: "Click its icon to bring the window back, or right-click it to quit.",
      });
      showNotification(notice);
    },
  };
}

/**
 * Serves `keepInTray`, telling every window when it changes so an open Settings page follows, and
 * takes each window's tray menu.
 */
export function installTray(ipc: ShellIpc, trayMode: ReturnType<typeof createTrayMode>): void {
  ipc.handle(Channels.keepInTrayGet, () => trayMode.keepInTray());
  ipc.handle(Channels.keepInTraySet, (enabled) => {
    trayMode.setKeepInTray(enabled === true);
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.webContents.isDestroyed()) {
        win.webContents.send(Channels.keepInTrayChanged, trayMode.keepInTray());
      }
    }
  });
  ipc.on(Channels.trayMenu, (event, input) => trayMode.setMenu(event.sender, input));
}
