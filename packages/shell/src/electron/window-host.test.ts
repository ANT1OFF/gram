import { beforeEach, describe, expect, it, vi } from "vitest";

/** A BrowserWindow as far as the shell's window host and `createWindow` touch one. */
class FakeWindow {
  static all: FakeWindow[] = [];
  static nextId = 1;
  readonly loads: string[] = [];
  readonly events: string[] = [];
  readonly listeners = new Map<string, Array<() => void>>();
  destroyed = false;
  readonly webContents = {
    id: FakeWindow.nextId++,
    isDestroyed: () => this.destroyed,
    getURL: () => this.loads.at(-1) ?? "",
    on: () => {},
    setWindowOpenHandler: () => {},
  };
  constructor() {
    FakeWindow.all.push(this);
  }
  loadURL(url: string) {
    this.loads.push(url);
    this.events.push(`load ${url}`);
    return Promise.resolve();
  }
  maximize() {
    this.events.push("maximize");
  }
  isMinimized() {
    return false;
  }
  restore() {
    this.events.push("restore");
  }
  show() {
    this.events.push("show");
    for (const listener of this.listeners.get("show") ?? []) listener();
  }
  focus() {
    this.events.push("focus");
  }
  /** What Electron does once a loaded page has painted. */
  painted() {
    for (const listener of this.listeners.get("ready-to-show") ?? []) listener();
  }
  isDestroyed() {
    return this.destroyed;
  }
  on(event: string, listener: () => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }
  once(event: string, listener: () => void) {
    this.on(event, listener);
  }
  close() {
    this.destroyed = true;
    for (const listener of this.listeners.get("closed") ?? []) listener();
  }
}

vi.mock("electron", () => ({
  app: {},
  BrowserWindow: Object.assign(FakeWindow, { getAllWindows: () => FakeWindow.all }),
  nativeImage: {},
  nativeTheme: { themeSource: "system", prefersReducedTransparency: false },
  Notification: {},
  screen: {
    getPrimaryDisplay: () => ({ id: 1 }),
    getAllDisplays: () => [{ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }],
    getDisplayMatching: () => ({ id: 1 }),
  },
}));
/** `windows.json` as the last launch left it; undefined for none. */
const store = vi.hoisted(() => ({ saved: undefined as string | undefined }));
vi.mock("node:fs", () => ({
  readFileSync: () => {
    if (store.saved === undefined) throw new Error("no saved windows");
    return store.saved;
  },
  writeFileSync: () => {},
}));

const { createShellWindows } = await import("./window-host.ts");

const context = { preloadPath: "/invented/preload.js", title: "Gram", openLink: async () => false };

beforeEach(() => {
  FakeWindow.all = [];
  store.saved = undefined;
});

describe("windows made while the server boots", () => {
  it("loads nothing until there is a boot URL, then loads each window once", () => {
    let bootUrl: string | undefined;
    let issued = 0;
    const windows = createShellWindows({
      url: () => (bootUrl === undefined ? undefined : `${bootUrl}${++issued}`),
      storePath: "/invented/windows.json",
      context,
    });
    windows.restore();
    windows.open();
    expect(FakeWindow.all).toHaveLength(2);
    expect(FakeWindow.all.flatMap((win) => win.loads)).toEqual([]);

    // Still booting: nothing to load yet, and nothing is dropped.
    windows.loadPending();
    expect(FakeWindow.all.flatMap((win) => win.loads)).toEqual([]);

    bootUrl = "http://127.0.0.1:4100/?boot=synthetic-";
    windows.loadPending();
    expect(FakeWindow.all.map((win) => win.loads)).toEqual([
      ["http://127.0.0.1:4100/?boot=synthetic-1"],
      ["http://127.0.0.1:4100/?boot=synthetic-2"],
    ]);

    // Loaded once: a second call, and windows made from now on, don't wait for it.
    windows.loadPending();
    windows.open();
    expect(FakeWindow.all.map((win) => win.loads)).toEqual([
      ["http://127.0.0.1:4100/?boot=synthetic-1"],
      ["http://127.0.0.1:4100/?boot=synthetic-2"],
      ["http://127.0.0.1:4100/?boot=synthetic-3"],
    ]);
  });

  it("skips a window closed before the boot", () => {
    let bootUrl: string | undefined;
    const windows = createShellWindows({
      url: () => bootUrl,
      storePath: "/invented/windows.json",
      context,
    });
    windows.restore();
    windows.open();
    FakeWindow.all[0]!.close();
    bootUrl = "http://127.0.0.1:4100/?boot=synthetic";
    windows.loadPending();
    expect(FakeWindow.all.map((win) => win.loads)).toEqual([[], [bootUrl]]);
  });

  it("maximizes a waiting window only when it loads, since maximizing shows it", () => {
    store.saved = JSON.stringify([
      { id: "w1", bounds: { x: 0, y: 0, width: 1200, height: 800 }, displayId: 1, maximized: true },
    ]);
    let bootUrl: string | undefined;
    const windows = createShellWindows({
      url: () => bootUrl,
      storePath: "/invented/windows.json",
      context,
    });
    windows.restore();
    expect(FakeWindow.all[0]!.events).toEqual([]);
    bootUrl = "http://127.0.0.1:4100/?boot=synthetic";
    windows.loadPending();
    expect(FakeWindow.all[0]!.events).toEqual(["maximize", `load ${bootUrl}`]);
  });

  it("doesn't show a waiting window brought forward from the Window menu, and focuses it once loaded", () => {
    let bootUrl: string | undefined;
    const windows = createShellWindows({
      url: () => bootUrl,
      storePath: "/invented/windows.json",
      context,
    });
    windows.restore();
    const [main] = FakeWindow.all;
    // The Window menu's Main, while the server still boots.
    expect(windows.focus("w1")).toBe(true);
    expect(main!.events).toEqual([]);

    bootUrl = "http://127.0.0.1:4100/?boot=synthetic";
    windows.loadPending();
    expect(main!.events).toEqual([`load ${bootUrl}`]);
    main!.painted();
    expect(main!.events).toEqual([`load ${bootUrl}`, "show", "show", "focus"]);

    // Loaded: brought forward at once.
    windows.focus("w1");
    expect(main!.events.slice(4)).toEqual(["show", "focus"]);
  });

  it("doesn't focus a loaded window that wasn't asked for while it waited", () => {
    let bootUrl: string | undefined;
    const windows = createShellWindows({
      url: () => bootUrl,
      storePath: "/invented/windows.json",
      context,
    });
    windows.restore();
    bootUrl = "http://127.0.0.1:4100/?boot=synthetic";
    windows.loadPending();
    FakeWindow.all[0]!.painted();
    expect(FakeWindow.all[0]!.events).toEqual([`load ${bootUrl}`, "show"]);
  });
});

describe("a login launch", () => {
  const boot = "http://127.0.0.1:4100/?boot=synthetic";

  it("loads the restored windows but shows none until one is brought forward", () => {
    store.saved = JSON.stringify([
      { id: "w1", bounds: { x: 0, y: 0, width: 1200, height: 800 }, displayId: 1, maximized: true },
      { id: "w2", bounds: { x: 40, y: 40, width: 1200, height: 800 }, displayId: 1 },
    ]);
    let bootUrl: string | undefined;
    const windows = createShellWindows({
      url: () => bootUrl,
      storePath: "/invented/windows.json",
      context,
      startHidden: true,
    });
    windows.restore();
    bootUrl = boot;
    windows.loadPending();
    for (const win of FakeWindow.all) win.painted();
    // Loaded, so the page can notify and fill the tray; never shown or maximized (which shows).
    expect(FakeWindow.all.map((win) => win.events)).toEqual([[`load ${boot}`], [`load ${boot}`]]);

    expect(windows.revealHeld()).toBe(true);
    expect(FakeWindow.all.map((win) => win.events)).toEqual([
      [`load ${boot}`, "show", "maximize", "focus"],
      [`load ${boot}`, "show", "focus"],
    ]);
    // Shown once: nothing is held any more.
    expect(windows.revealHeld()).toBe(false);
  });

  it("reveals a held window that something else showed, and shows windows opened later", () => {
    const windows = createShellWindows({
      url: () => boot,
      storePath: "/invented/windows.json",
      context,
      startHidden: true,
    });
    windows.restore();
    const [main] = FakeWindow.all;
    main!.painted();
    expect(main!.events).toEqual([`load ${boot}`]);
    // A notification's click focuses the window directly.
    main!.show();
    expect(windows.revealHeld()).toBe(false);

    windows.open();
    FakeWindow.all[1]!.painted();
    expect(FakeWindow.all[1]!.events).toEqual([`load ${boot}`, "show"]);
  });

  it("brought forward while the server still boots, shows once loaded", () => {
    let bootUrl: string | undefined;
    const windows = createShellWindows({
      url: () => bootUrl,
      storePath: "/invented/windows.json",
      context,
      startHidden: true,
    });
    windows.restore();
    const [main] = FakeWindow.all;
    expect(windows.revealHeld()).toBe(true);
    expect(main!.events).toEqual([]);
    bootUrl = boot;
    windows.loadPending();
    main!.painted();
    expect(main!.events).toEqual([`load ${boot}`, "show", "focus"]);
  });
});
