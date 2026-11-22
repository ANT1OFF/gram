import { readFileSync, writeFileSync } from "node:fs";

import type { DesktopNotification, DesktopWindowInfo, TitleBarTheme } from "@gram/contracts";
import {
  app,
  BrowserWindow,
  nativeImage,
  nativeTheme,
  Notification,
  type NativeImage,
  type Rectangle,
} from "electron";

import { Channels } from "../channels.ts";
import { overlayDotBitmap, parseStoredAppearance } from "../core/rules.ts";
import { windowArg } from "../window-arg.ts";
import { appWindows } from "./decision-windows.ts";

const isMac = process.platform === "darwin";
const isWindows = process.platform === "win32";
const isLinux = process.platform === "linux";

/** What every window needs from the shell that makes it. */
export interface WindowContext {
  /** The compiled preload. */
  readonly preloadPath: string;
  readonly title: string;
  /** Opens a link that left the app, through the shell's link trust. */
  readonly openLink: (url: string, window: BrowserWindow) => Promise<boolean>;
}

let theme: TitleBarTheme = { background: "#0b0b0b", foreground: "#f5f5f5", mode: "dark" };
let windowBackground = "#131313";
let appearancePath: string | undefined;
let vibrancyWanted = false;
let overlayDot: NativeImage | undefined;
const liveNotifications = new Set<Notification>();

const vibrancyActive = () =>
  (isMac || isWindows) && vibrancyWanted && !nativeTheme.prefersReducedTransparency;

function applyAppearance(win: BrowserWindow) {
  const glass = vibrancyActive();
  if (isMac) win.setVibrancy(glass ? "under-window" : null);
  if (isWindows) {
    win.setBackgroundMaterial(glass ? "mica" : "none");
    win.setTitleBarOverlay({ color: theme.background, symbolColor: theme.foreground });
  }
  win.setBackgroundColor(glass ? "#00000000" : windowBackground);
}

/**
 * Creates a window on `url`. Links that open a new window, or navigate away from the app's origin,
 * go through `context.openLink` instead. Without a `url` nothing loads: the window's renderer
 * process starts, but no page runs in it until the caller loads the app, and a window to `show`
 * stays hidden until that page has painted.
 */
export function createWindow({
  url,
  show,
  info,
  bounds,
  context,
}: {
  readonly url: string | undefined;
  readonly show: boolean;
  /** Who the window is, handed to its preload; absent for the smoke window. */
  readonly info?: DesktopWindowInfo;
  readonly bounds?: Rectangle;
  readonly context: WindowContext;
}): BrowserWindow {
  const win = new BrowserWindow({
    title: context.title,
    ...(bounds ?? { width: 1440, height: 900 }),
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: windowBackground,
    ...(isMac ? { titleBarStyle: "hiddenInset" as const } : {}),
    ...(isWindows
      ? {
          titleBarStyle: "hidden" as const,
          titleBarOverlay: { color: theme.background, symbolColor: theme.foreground, height: 40 },
        }
      : {}),
    ...(isLinux ? { autoHideMenuBar: true } : {}),
    webPreferences: {
      preload: context.preloadPath,
      additionalArguments: info === undefined ? [] : [windowArg(info)],
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  });

  if (show) {
    win.once("ready-to-show", () => {
      if (!win.isDestroyed()) win.show();
    });
  }
  if (vibrancyWanted) applyAppearance(win);
  if (isMac) {
    const sendFullScreen = (fullScreen: boolean) => () => {
      if (!win.isDestroyed()) win.webContents.send(Channels.windowFullScreenChanged, fullScreen);
    };
    win.on("enter-full-screen", sendFullScreen(true));
    win.on("leave-full-screen", sendFullScreen(false));
  }

  win.webContents.setWindowOpenHandler(({ url: target }) => {
    void context.openLink(target, win);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, target) => {
    if (win.isDestroyed()) return;
    const from = win.webContents.getURL() || url;
    if (from !== undefined && new URL(target).origin === new URL(from).origin) return;
    event.preventDefault();
    void context.openLink(target, win);
  });

  if (url !== undefined) void win.loadURL(url);
  return win;
}

/** Re-applies vibrancy when the OS reduced-transparency setting changes. */
export function watchSystemAppearance() {
  nativeTheme.on("updated", () => {
    for (const win of appWindows()) applyAppearance(win);
  });
}

/**
 * Seeds the window background and title bar from the theme saved at the last sync, so a light theme
 * doesn't open on a dark window before the page paints. Later syncs are saved back to `path`.
 */
export function loadStoredAppearance(path: string) {
  appearancePath = path;
  nativeTheme.themeSource = theme.mode;
  let text: string | undefined;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  const stored = parseStoredAppearance(text);
  if (!stored) return;
  theme = stored;
  windowBackground = stored.background;
  nativeTheme.themeSource = stored.mode;
}

export function setTitleBarTheme(next: TitleBarTheme) {
  const changed =
    next.background !== theme.background ||
    next.foreground !== theme.foreground ||
    next.mode !== theme.mode;
  theme = next;
  windowBackground = next.background;
  nativeTheme.themeSource = next.mode;
  for (const win of appWindows()) applyAppearance(win);
  if (!changed || appearancePath === undefined) return;
  try {
    writeFileSync(appearancePath, JSON.stringify(next));
  } catch (error) {
    process.stderr.write(`appearance: couldn't save the window theme: ${String(error)}\n`);
  }
}

/** The page background and text colour of the theme the renderer last synced. */
export const themeColors = () => ({ background: windowBackground, foreground: theme.foreground });

/** The background the windows open on, for a splash or a quit window that matches them. */
export const currentBackground = () => windowBackground;

export function setVibrancy(enabled: boolean) {
  vibrancyWanted = enabled;
  for (const win of appWindows()) applyAppearance(win);
}

export function setBadge(count: number) {
  if (!isWindows) {
    app.setBadgeCount(count);
    if (isLinux) {
      for (const win of appWindows()) win.flashFrame(count > 0 && !win.isFocused());
    }
    return;
  }
  overlayDot ??= nativeImage.createFromBitmap(overlayDotBitmap(16), { width: 16, height: 16 });
  for (const win of appWindows()) {
    win.setOverlayIcon(count > 0 ? overlayDot : null, count > 0 ? `${count} waiting` : "");
    win.flashFrame(count > 0 && !win.isFocused());
  }
}

export function focusWindow(win: BrowserWindow) {
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

let watcher: ((note: Notification, test: boolean) => void) | undefined;

/** Follows every notification the shell shows from now on, for Settings' notification row. */
export function watchNotifications(watch: (note: Notification, test: boolean) => void) {
  watcher = watch;
}

/** Shows `note`, telling the watcher first so it sees the OS's answer. */
export function showNotification(note: Notification, test = false) {
  watcher?.(note, test);
  note.show();
}

const liveById = new Map<string, Notification>();

const windowFor = (target: BrowserWindow | null) =>
  target && !target.isDestroyed() ? target : appWindows()[0];

/**
 * Shows a native notification; a click focuses `target` (or any window) and tells its renderer.
 * One with an `id` is an ask's: a click or Open comes back as `"open"`, and its `actions` (already
 * held to `parseNotification`'s rules) as their index, without bringing the window forward.
 */
export function notify(notification: DesktopNotification, target: BrowserWindow | null) {
  if (!Notification.isSupported()) return;
  const { id } = notification;
  const answers = isMac ? (notification.actions ?? []) : [];
  const note = new Notification({
    title: notification.title,
    body: notification.body,
    ...(notification.subtitle === undefined ? {} : { subtitle: notification.subtitle }),
    ...(id === undefined
      ? {}
      : {
          id: `gram-ask-${id}`,
          ...(isMac
            ? { actions: [...answers, "Open"].map((text) => ({ type: "button" as const, text })) }
            : {}),
        }),
  });
  if (id !== undefined) {
    withdrawNotification(id);
    liveById.set(id, note);
  }
  const forget = () => {
    liveNotifications.delete(note);
    if (id !== undefined && liveById.get(id) === note) liveById.delete(id);
  };
  liveNotifications.add(note);
  note.on("close", forget);
  const open = () => {
    forget();
    const win = windowFor(target);
    if (!win) return;
    focusWindow(win);
    if (id === undefined)
      win.webContents.send(Channels.notificationClick, notification.threadId ?? null);
    else win.webContents.send(Channels.notificationAction, { id, action: "open" });
  };
  note.on("click", open);
  if (id !== undefined) {
    note.on("action", (event) => {
      const index = event.actionIndex;
      if (index === answers.length) return open();
      if (!Number.isInteger(index) || index < 0 || index >= answers.length) return;
      forget();
      const win = windowFor(target);
      if (win) win.webContents.send(Channels.notificationAction, { id, action: index });
    });
  }
  showNotification(note);
}

/** Takes an ask's notification back, from the screen and from Notification Center. */
export function withdrawNotification(id: string) {
  const note = liveById.get(id);
  if (note === undefined) return;
  liveById.delete(id);
  liveNotifications.delete(note);
  note.close();
}

/**
 * A notification from the shell itself rather than the page, such as Settings' test
 * notification: a click runs `onClick`.
 */
export function notifyShell({
  title,
  body,
  onClick,
  test = false,
}: {
  readonly title: string;
  readonly body: string;
  /** Settings' test notification. */
  readonly test?: boolean;
  readonly onClick?: (() => void) | undefined;
}) {
  if (!Notification.isSupported()) return;
  const note = new Notification({ title, body });
  liveNotifications.add(note);
  note.on("close", () => liveNotifications.delete(note));
  note.on("click", () => {
    liveNotifications.delete(note);
    onClick?.();
  });
  showNotification(note, test);
}
