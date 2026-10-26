/** The window manager over real BrowserWindows and displays. */

import type { GridLayout } from "@gram/contracts";
import { BrowserWindow, screen, type WebContents } from "electron";

import { Channels } from "../channels.ts";
import {
  createWindowManager,
  fileWindowStore,
  type ManagedWindow,
  type WindowManager,
} from "../core/window-manager.ts";
import { createWindow, focusWindow, type WindowContext } from "./windows.ts";

/** The window operations the IPC exposes; the sender's window is found from its web contents. */
export interface WindowIpc {
  open(options?: { readonly threadId?: string }): string;
  focus(windowId: string, threadId?: string): boolean;
  layoutFor(sender: WebContents): GridLayout | undefined;
  saveLayoutFor(sender: WebContents, layout: GridLayout): void;
  /** Which app window `sender` is; `undefined` for any other page. */
  windowIdFor(sender: WebContents): string | undefined;
}

/** A shell's windows: the manager, what the IPC asks of it, and a reload of them all. */
export interface ShellWindows extends WindowManager, WindowIpc {
  /** Loads `url()` into every window again: a fresh boot URL after a move or a restart. */
  reloadAll(): void;
  /**
   * Loads `url()` into each window made while it had none, so windows can be made, and their
   * renderers started, while the server still boots. Each loads once; a window made once there is
   * a URL loads it at once.
   */
  loadPending(): void;
  /**
   * Shows the windows a login launch restored hidden (`startHidden`); false when there are none.
   * Anything else that shows one (a notification, the Window menu) reveals it too.
   */
  revealHeld(): boolean;
}

/** A window made before there was a URL, until `loadPending` loads it. */
interface Unloaded {
  readonly maximized: boolean;
  /** Brought forward while it waited (the Window menu), so it is focused once it has loaded. */
  focus: boolean;
}

/** `pending(win)` is the window's wait for a URL; showing it then would show an empty window. */
function managed(win: BrowserWindow, pending: () => Unloaded | undefined): ManagedWindow {
  return {
    bounds: () => win.getNormalBounds(),
    displayId: () =>
      win.isDestroyed() ? undefined : screen.getDisplayMatching(win.getNormalBounds()).id,
    isMaximized: () => win.isMaximized(),
    focus: () => {
      const waiting = pending();
      if (waiting === undefined) focusWindow(win);
      else waiting.focus = true;
    },
    showThread: (threadId) => {
      if (!win.isDestroyed()) win.webContents.send(Channels.windowOpenThread, threadId);
    },
    onPlacementChange: (callback) => {
      win.on("move", callback);
      win.on("resize", callback);
      win.on("maximize", callback);
      win.on("unmaximize", callback);
    },
    onFocus: (callback) => {
      win.on("focus", callback);
    },
    onClosed: (callback) => {
      win.on("closed", callback);
    },
  };
}

/** The shell's windows over real BrowserWindows and displays, with placement saved at `storePath`. */
export function createShellWindows({
  url,
  storePath,
  context,
  onCreated,
  startHidden = false,
}: {
  /** A fresh boot URL for each window load; undefined until there is one (the server boots). */
  readonly url: () => string | undefined;
  readonly storePath: string;
  readonly context: WindowContext;
  /** Called with each app window as it is made, and its window id. */
  readonly onCreated?: (win: BrowserWindow, windowId: string) => void;
  /**
   * A login launch: the windows `restore` makes load, so their pages raise notifications and fill
   * the tray, but stay hidden until something brings one forward. Windows opened later show.
   */
  readonly startHidden?: boolean;
}): ShellWindows {
  const byContents = new Map<number, string>();
  /**
   * Windows made before there was a URL, which `loadPending` loads. Each is maximized and focused
   * only then: either would show it, and put an empty window on screen.
   */
  const unloaded = new Map<BrowserWindow, Unloaded>();
  /** Windows restored hidden, with whether each is maximized once it shows (maximizing shows it). */
  const held = new Map<BrowserWindow, { readonly maximized: boolean }>();
  let holding = startHidden;
  const manager = createWindowManager({
    factory: {
      create: ({ info, bounds, maximized }) => {
        const target = url();
        const hidden = holding;
        const win = createWindow({ url: target, show: !hidden, info, bounds, context });
        if (hidden) {
          held.set(win, { maximized });
          win.on("show", () => {
            const wait = held.get(win);
            if (wait === undefined) return;
            held.delete(win);
            if (wait.maximized) win.maximize();
          });
        }
        if (target === undefined)
          unloaded.set(win, { maximized: maximized && !hidden, focus: false });
        else if (maximized && !hidden) win.maximize();
        const contentsId = win.webContents.id;
        byContents.set(contentsId, info.id);
        win.once("closed", () => {
          byContents.delete(contentsId);
          unloaded.delete(win);
          held.delete(win);
        });
        onCreated?.(win, info.id);
        return managed(win, () => unloaded.get(win));
      },
    },
    screen: {
      displays: () => {
        const primary = screen.getPrimaryDisplay().id;
        return screen.getAllDisplays().map((display) => ({
          id: display.id,
          workArea: display.workArea,
          primary: display.id === primary,
        }));
      },
    },
    store: fileWindowStore(storePath),
  });
  const idOf = (sender: WebContents) => byContents.get(sender.id);

  return {
    ...manager,
    restore: () => {
      manager.restore();
      holding = false;
    },
    revealHeld: () => {
      if (held.size === 0) return false;
      for (const win of held.keys()) {
        const waiting = unloaded.get(win);
        // Still waiting for the boot: shown once it has loaded and painted.
        if (waiting === undefined) focusWindow(win);
        else waiting.focus = true;
      }
      return true;
    },
    layoutFor: (sender) => {
      const id = idOf(sender);
      return id === undefined ? undefined : manager.layoutOf(id);
    },
    saveLayoutFor: (sender, layout) => {
      const id = idOf(sender);
      if (id !== undefined) manager.setLayout(id, layout);
    },
    windowIdFor: idOf,
    reloadAll: () => {
      for (const win of BrowserWindow.getAllWindows()) {
        const target = url();
        if (target === undefined) return;
        if (byContents.has(win.webContents.id) && !win.webContents.isDestroyed()) {
          unloaded.delete(win);
          void win.loadURL(target);
        }
      }
    },
    loadPending: () => {
      for (const [win, { maximized, focus }] of unloaded) {
        const target = url();
        if (target === undefined) return;
        unloaded.delete(win);
        if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
        if (maximized) win.maximize();
        // After `createWindow`'s own listener has shown it.
        if (focus) {
          win.once("ready-to-show", () => {
            if (!win.isDestroyed()) focusWindow(win);
          });
        }
        void win.loadURL(target);
      }
    },
  };
}
