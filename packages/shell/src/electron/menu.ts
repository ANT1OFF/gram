// The application menu. The stock UI turns its own ⌘W and ⌘⇧N handlers off whenever the shell is
// there, so the menu carries them. The user's keybindings and the development items come in as
// `MenuOptions`.

import {
  MENU_SHORTCUT_IDS,
  type DesktopMenuAction,
  type MenuShortcutId,
  type MenuShortcuts,
} from "@gram/contracts/desktop-bridge";
import type { MenuItemConstructorOptions } from "electron";

export interface MenuHandlers {
  /** Forwards a command to the focused window's renderer. */
  send(action: Exclude<DesktopMenuAction, "newWindow">): void;
  newWindow(): void;
  /** Brings a window listed in the Window menu forward. */
  focusWindow(windowId: string): void;
}

/** A window as the Window menu lists it. */
export interface MenuWindow {
  readonly id: string;
  readonly name: string;
  readonly focused: boolean;
}

const separator: MenuItemConstructorOptions = { type: "separator" };

/** The keyboard catalog's defaults for the menu shortcuts, until the renderer sends its bindings. */
export const MENU_SHORTCUT_DEFAULTS: Record<MenuShortcutId, string> = {
  "settings.open": "mod+,",
  "thread.new": "mod+n",
  "window.new": "mod+shift+n",
  "pane.close": "mod+w",
  "thread.close": "mod+alt+w",
  "palette.open": "mod+k",
  "overlay.shortcutsAnywhere": "mod+/",
};

const ACCELERATOR_KEYS: Readonly<Record<string, string>> = {
  enter: "Enter",
  escape: "Esc",
  tab: "Tab",
  space: "Space",
  backspace: "Backspace",
  arrowup: "Up",
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
};

/**
 * The Electron accelerator for a keyboard catalog keys string (`mod+shift+n` → `CmdOrCtrl+Shift+N`),
 * or `undefined` for a disabled shortcut or one without a modifier, which a menu mustn't grab.
 */
export function acceleratorFor(keys: string | null | undefined): string | undefined {
  if (!keys) return undefined;
  const parts = keys.toLowerCase().split("+");
  const key = parts.pop();
  if (!key) return undefined;
  const modifiers = [
    parts.includes("mod") && "CmdOrCtrl",
    parts.includes("ctrl") && "Ctrl",
    parts.includes("alt") && "Alt",
    parts.includes("shift") && "Shift",
  ].filter((modifier): modifier is string => typeof modifier === "string");
  if (modifiers.length === 0) return undefined;
  return [...modifiers, ACCELERATOR_KEYS[key] ?? key.toUpperCase()].join("+");
}

const KEYS_STRING = /^[a-z0-9+,./\\[\]=?-]{1,40}$/;

/** The menu shortcuts a renderer sent: known ids with a keys string or `null`, the rest dropped. */
export function parseMenuShortcuts(input: unknown): MenuShortcuts {
  if (typeof input !== "object" || input === null) return {};
  const parsed: Partial<Record<MenuShortcutId, string | null>> = {};
  for (const id of MENU_SHORTCUT_IDS) {
    const value: unknown = Reflect.get(input, id);
    if (value === null || (typeof value === "string" && KEYS_STRING.test(value))) {
      parsed[id] = value;
    }
  }
  return parsed;
}

export interface MenuOptions {
  /** Effective keys per menu shortcut, from the renderer's keybindings. */
  readonly shortcuts?: MenuShortcuts;
  /** Development builds: Reload and developer tools, which a packaged app leaves out so Ctrl+R reaches a shell. */
  readonly developer?: boolean;
}

/**
 * The application menu. ⌘W closes the focused pane (the window moves to ⇧⌘W) and ⌥⌘W asks to close
 * its thread, matching the renderer's `pane.close` and `thread.close`. The Window menu lists
 * `windows`, checking the focused one.
 */
export function menuTemplate(
  platform: NodeJS.Platform,
  handlers: MenuHandlers,
  windows: readonly MenuWindow[] = [],
  { shortcuts = {}, developer = false }: MenuOptions = {},
): MenuItemConstructorOptions[] {
  const isMac = platform === "darwin";
  const accelerator = (id: MenuShortcutId): { accelerator?: string } => {
    const keys = shortcuts[id] === undefined ? MENU_SHORTCUT_DEFAULTS[id] : shortcuts[id];
    const converted = acceleratorFor(keys);
    return converted === undefined ? {} : { accelerator: converted };
  };
  const settings: MenuItemConstructorOptions = {
    label: isMac ? "Settings…" : "Settings",
    ...accelerator("settings.open"),
    click: () => handlers.send("settings"),
  };

  const appMenu: MenuItemConstructorOptions[] = isMac
    ? [
        {
          label: "Gram",
          submenu: [
            { role: "about" },
            separator,
            settings,
            separator,
            { role: "services" },
            separator,
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            separator,
            { role: "quit" },
          ],
        },
      ]
    : [];
  const fileExtras: MenuItemConstructorOptions[] = isMac
    ? []
    : [separator, settings, separator, { role: "quit" }];
  const windowExtras: MenuItemConstructorOptions[] = isMac
    ? [{ role: "zoom" }, separator, { role: "front" }]
    : [];
  const windowList: MenuItemConstructorOptions[] =
    windows.length === 0
      ? []
      : [
          separator,
          ...windows.map((window): MenuItemConstructorOptions => ({
            label: window.name,
            type: "checkbox",
            checked: window.focused,
            click: () => handlers.focusWindow(window.id),
          })),
        ];

  const developerItems: MenuItemConstructorOptions[] = developer
    ? [{ role: "reload" }, { role: "forceReload" }, { role: "toggleDevTools" }, separator]
    : [];
  // The zoom keys stay with the renderer, so a focused terminal can take them for its font first;
  // what it leaves, the renderer hands back as window zoom (`windowZoomStep`). The items keep
  // showing their keys. On macOS this used to be the menu's: its Zoom In accelerator is the US
  // chord, so ⌘⇧= never reached a focused terminal, while a Nordic ⌘+ (another key) did.
  const zoomAccelerator: Pick<MenuItemConstructorOptions, "registerAccelerator"> = {
    registerAccelerator: false,
  };

  return [
    ...appMenu,
    {
      label: "File",
      submenu: [
        {
          label: "New Task",
          ...accelerator("thread.new"),
          click: () => handlers.send("newThread"),
        },
        {
          label: "New Window",
          ...accelerator("window.new"),
          click: () => handlers.newWindow(),
        },
        separator,
        {
          label: "Close Pane",
          ...accelerator("pane.close"),
          click: () => handlers.send("closePane"),
        },
        {
          label: "Close Thread…",
          ...accelerator("thread.close"),
          click: () => handlers.send("closeThread"),
        },
        {
          label: "Close All Threads…",
          click: () => handlers.send("closeAllThreads"),
        },
        separator,
        { label: "Close Window", accelerator: "CmdOrCtrl+Shift+W", role: "close" },
        ...fileExtras,
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        {
          label: "Command Palette",
          ...accelerator("palette.open"),
          click: () => handlers.send("palette"),
        },
        separator,
        ...developerItems,
        { role: "resetZoom", ...zoomAccelerator },
        { role: "zoomIn", ...zoomAccelerator },
        { role: "zoomOut", ...zoomAccelerator },
        separator,
        { role: "togglefullscreen" },
      ],
    },
    {
      // Built by hand: the `windowMenu` role adds a Close item bound to CmdOrCtrl+W on Windows.
      label: "Window",
      role: "window",
      submenu: [{ role: "minimize" }, ...windowExtras, ...windowList],
    },
    {
      label: "Help",
      role: "help",
      submenu: [
        { label: "What's New", click: () => handlers.send("whatsNew") },
        {
          label: "Keyboard Shortcuts",
          ...accelerator("overlay.shortcutsAnywhere"),
          click: () => handlers.send("shortcuts"),
        },
        separator,
        { label: "Open Logs Folder", click: () => handlers.send("openLogsFolder") },
        { label: "Copy Diagnostics", click: () => handlers.send("copyDiagnostics") },
        separator,
        { label: "Report an Issue…", click: () => handlers.send("reportIssue") },
      ],
    },
  ];
}
