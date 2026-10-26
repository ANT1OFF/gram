import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";

import { acceleratorFor, menuTemplate, parseMenuShortcuts, type MenuWindow } from "./menu.ts";

function flatten(items: readonly MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((item) => [
    item,
    ...(Array.isArray(item.submenu) ? flatten(item.submenu) : []),
  ]);
}

const handlers = () => ({ send: vi.fn(), newWindow: vi.fn(), focusWindow: vi.fn() });

function setup(platform: NodeJS.Platform, windows: readonly MenuWindow[] = []) {
  const { send, newWindow, focusWindow } = handlers();
  const items = flatten(menuTemplate(platform, { send, newWindow, focusWindow }, windows));
  const byAccelerator = (accelerator: string) => items.filter((i) => i.accelerator === accelerator);
  const click = (accelerator: string) =>
    (byAccelerator(accelerator)[0]?.click as (() => void) | undefined)?.();
  return { items, send, newWindow, focusWindow, byAccelerator, click };
}

describe.each(["darwin", "win32"] as const)("menuTemplate (%s)", (platform) => {
  it("binds the app shortcuts to renderer actions", () => {
    const { send, click } = setup(platform);
    for (const [accelerator, action] of [
      ["CmdOrCtrl+W", "closePane"],
      ["CmdOrCtrl+Alt+W", "closeThread"],
      ["CmdOrCtrl+N", "newThread"],
      ["CmdOrCtrl+K", "palette"],
      ["CmdOrCtrl+,", "settings"],
    ] as const) {
      send.mockClear();
      click(accelerator);
      expect(send, accelerator).toHaveBeenCalledWith(action);
    }
  });

  it("names ⌘W for the pane it closes, and offers Close All Threads", () => {
    const { items, byAccelerator, send } = setup(platform);
    expect(byAccelerator("CmdOrCtrl+W")[0]?.label).toBe("Close Pane");
    expect(byAccelerator("CmdOrCtrl+Alt+W")[0]?.label).toBe("Close Thread…");
    expect(byAccelerator("CmdOrCtrl+N")[0]?.label).toBe("New Task");
    const closeAll = items.find((i) => i.label === "Close All Threads…");
    (closeAll?.click as (() => void) | undefined)?.();
    expect(send).toHaveBeenCalledWith("closeAllThreads");
  });

  it("offers What's New, shortcuts, logs, diagnostics and issue reports in a Help menu", () => {
    const { items, send } = setup(platform);
    expect(items.find((i) => i.label === "Help")?.role).toBe("help");
    for (const [label, action] of [
      ["What's New", "whatsNew"],
      ["Keyboard Shortcuts", "shortcuts"],
      ["Open Logs Folder", "openLogsFolder"],
      ["Copy Diagnostics", "copyDiagnostics"],
      ["Report an Issue…", "reportIssue"],
    ] as const) {
      send.mockClear();
      (items.find((i) => i.label === label)?.click as (() => void) | undefined)?.();
      expect(send, label).toHaveBeenCalledWith(action);
    }
  });

  it("opens a new window in the shell rather than the renderer", () => {
    const { send, newWindow, click } = setup(platform);
    click("CmdOrCtrl+Shift+N");
    expect(newWindow).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });

  it("lists the windows, checking the focused one, and focuses one on click", () => {
    const { items, focusWindow, send } = setup(platform, [
      { id: "w1", name: "Main", focused: false },
      { id: "w2", name: "Window 2", focused: true },
    ]);
    const listed = items.filter((i) => i.type === "checkbox");
    expect(listed.map((i) => [i.label, i.checked])).toEqual([
      ["Main", false],
      ["Window 2", true],
    ]);
    (listed[0]?.click as (() => void) | undefined)?.();
    expect(focusWindow).toHaveBeenCalledWith("w1");
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps CmdOrCtrl+W off every role, so it can't close the window", () => {
    const { items, byAccelerator } = setup(platform);
    expect(byAccelerator("CmdOrCtrl+W")).toHaveLength(1);
    expect(byAccelerator("CmdOrCtrl+W")[0]?.role).toBeUndefined();
    expect(items.some((i) => i.role === "windowMenu" || i.role === "fileMenu")).toBe(false);
  });

  it("includes the standard edit and view roles, and reload and devtools only for development", () => {
    const roles = setup(platform).items.map((i) => i.role);
    expect(roles).toEqual(expect.arrayContaining(["editMenu", "togglefullscreen", "minimize"]));
    expect(roles).not.toContain("reload");
    expect(roles).not.toContain("forceReload");
    expect(roles).not.toContain("toggleDevTools");

    const developer = flatten(menuTemplate(platform, handlers(), [], { developer: true }));
    expect(developer.map((i) => i.role)).toEqual(
      expect.arrayContaining(["reload", "forceReload", "toggleDevTools"]),
    );
  });

  it("takes the user's keybindings for its accelerators, and drops a turned-off one", () => {
    const items = flatten(
      menuTemplate(platform, handlers(), [], {
        shortcuts: { "pane.close": "mod+shift+x", "thread.new": null, "palette.open": "mod+p" },
      }),
    );
    const byLabel = (label: string) => items.find((i) => i.label === label);
    expect(byLabel("Close Pane")?.accelerator).toBe("CmdOrCtrl+Shift+X");
    expect(byLabel("New Task")).not.toHaveProperty("accelerator");
    expect(byLabel("Command Palette")?.accelerator).toBe("CmdOrCtrl+P");
    expect(byLabel("Close Thread…")?.accelerator).toBe("CmdOrCtrl+Alt+W");
    expect(byLabel("Keyboard Shortcuts")?.accelerator).toBe("CmdOrCtrl+/");
  });

  it("leaves the zoom keys to the renderer, where a focused terminal gets them first", () => {
    const zoom = setup(platform).items.filter(
      (i) => i.role === "zoomIn" || i.role === "zoomOut" || i.role === "resetZoom",
    );
    expect(zoom).toHaveLength(3);
    for (const item of zoom) expect(item.registerAccelerator).toBe(false);
  });
});

describe("acceleratorFor", () => {
  it("converts catalog keys to Electron accelerators", () => {
    expect(acceleratorFor("mod+shift+n")).toBe("CmdOrCtrl+Shift+N");
    expect(acceleratorFor("mod+alt+w")).toBe("CmdOrCtrl+Alt+W");
    expect(acceleratorFor("mod+,")).toBe("CmdOrCtrl+,");
    expect(acceleratorFor("mod+/")).toBe("CmdOrCtrl+/");
    expect(acceleratorFor("ctrl+shift+arrowleft")).toBe("Ctrl+Shift+Left");
    expect(acceleratorFor("mod+enter")).toBe("CmdOrCtrl+Enter");
  });

  it("gives no accelerator to a turned-off shortcut or a bare key", () => {
    expect(acceleratorFor(null)).toBeUndefined();
    expect(acceleratorFor(undefined)).toBeUndefined();
    expect(acceleratorFor("f2")).toBeUndefined();
    expect(acceleratorFor("?")).toBeUndefined();
  });
});

describe("parseMenuShortcuts", () => {
  it("keeps known ids with a keys string or null, and drops everything else", () => {
    expect(
      parseMenuShortcuts({
        "pane.close": "mod+shift+x",
        "thread.new": null,
        "palette.open": 7,
        "settings.open": "<script>",
        "not.a.menu.item": "mod+q",
      }),
    ).toEqual({ "pane.close": "mod+shift+x", "thread.new": null });
    expect(parseMenuShortcuts("mod+w")).toEqual({});
  });
});

it("puts Settings in the app menu on macOS and in File elsewhere", () => {
  const mac = menuTemplate("darwin", handlers());
  expect(mac[0]?.label).toBe("Gram");
  const win = menuTemplate("win32", handlers());
  expect(win[0]?.label).toBe("File");
  expect(flatten([win[0]!]).some((i) => i.accelerator === "CmdOrCtrl+,")).toBe(true);
});

/** Every item's label, or its role where it has none. */
const labels = (items: readonly MenuItemConstructorOptions[]) =>
  flatten(items).map((item) => item.label ?? item.role);

it("has Open Logs Folder and the standard Edit menu, and no menu of its own off macOS", () => {
  expect(menuTemplate("win32", handlers()).map((menu) => menu.label ?? menu.role)).toEqual([
    "File",
    "editMenu",
    "View",
    "Window",
    "Help",
  ]);
  for (const platform of ["darwin", "win32"] as const) {
    const items = menuTemplate(platform, handlers());
    expect(labels(items)).toContain("Open Logs Folder");
    expect(items.some((menu) => menu.role === "editMenu")).toBe(true);
  }
});
