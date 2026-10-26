import type { DesktopWindowInfo, GridLayout } from "@gram/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createWindowManager,
  DEFAULT_SIZE,
  fileWindowStore,
  nextWindowId,
  parseWindowRecords,
  placeBounds,
  windowName,
  type DisplayInfo,
  type ManagedWindow,
  type Rect,
  type WindowRecord,
} from "./window-manager.ts";

const PRIMARY: DisplayInfo = {
  id: 1,
  primary: true,
  workArea: { x: 0, y: 25, width: 1920, height: 1055 },
};
const SIDE: DisplayInfo = {
  id: 2,
  primary: false,
  workArea: { x: 1920, y: 0, width: 2560, height: 1440 },
};
const LAYOUT = { preset: "2c", panes: ["t-a", "t-b"], focused: 1 } as unknown as GridLayout;

class FakeWindow implements ManagedWindow {
  focusCount = 0;
  readonly shown: string[] = [];
  #placement: (() => void) | undefined;
  #focus: (() => void) | undefined;
  #closed: (() => void) | undefined;

  readonly info: DesktopWindowInfo;
  rect: Rect;
  maximized: boolean;
  display: number | undefined;

  constructor(info: DesktopWindowInfo, rect: Rect, maximized: boolean) {
    this.info = info;
    this.rect = rect;
    this.maximized = maximized;
    this.display = undefined;
  }

  bounds() {
    return this.rect;
  }
  displayId() {
    return this.display;
  }
  isMaximized() {
    return this.maximized;
  }
  focus() {
    this.focusCount++;
    this.#focus?.();
  }
  showThread(threadId: string) {
    this.shown.push(threadId);
  }
  onPlacementChange(callback: () => void) {
    this.#placement = callback;
  }
  onFocus(callback: () => void) {
    this.#focus = callback;
  }
  onClosed(callback: () => void) {
    this.#closed = callback;
  }
  move(rect: Rect, display: number) {
    this.rect = rect;
    this.display = display;
    this.#placement?.();
  }
  close() {
    this.#closed?.();
  }
}

function setup(saved: unknown = [], displays: DisplayInfo[] = [PRIMARY, SIDE]) {
  const windows: FakeWindow[] = [];
  const saves: WindowRecord[][] = [];
  const manager = createWindowManager({
    factory: {
      create: ({ info, bounds, maximized }) => {
        const window = new FakeWindow(info, bounds, maximized);
        windows.push(window);
        return window;
      },
    },
    screen: { displays: () => displays },
    store: {
      load: () => saved,
      save: (records) => {
        saves.push([...records]);
      },
    },
    saveDelayMs: 100,
  });
  return { manager, windows, saves, lastSave: () => saves.at(-1) };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("window names and ids", () => {
  it("names the first window Main and hands out the lowest free id", () => {
    expect(windowName("w1")).toBe("Main");
    expect(windowName("w3")).toBe("Window 3");
    expect(nextWindowId([])).toBe("w1");
    expect(nextWindowId(["w1", "w3"])).toBe("w2");
  });
});

describe("placeBounds", () => {
  it("keeps a window on its display, clamped to the work area", () => {
    expect(placeBounds({ x: 2000, y: 100, width: 1200, height: 800 }, 2, [PRIMARY, SIDE])).toEqual({
      bounds: { x: 2000, y: 100, width: 1200, height: 800 },
      displayId: 2,
    });
    expect(placeBounds({ x: 1800, y: -50, width: 3000, height: 800 }, 2, [PRIMARY, SIDE])).toEqual({
      bounds: { x: 1920, y: 0, width: 2560, height: 800 },
      displayId: 2,
    });
  });

  it("centres on the primary display when the saved display is gone or the window is off it", () => {
    const expected = { bounds: { x: 360, y: 178, width: 1200, height: 750 }, displayId: 1 };
    expect(placeBounds({ x: 2000, y: 100, width: 1200, height: 750 }, 2, [PRIMARY])).toEqual(
      expected,
    );
    expect(placeBounds({ x: -5000, y: 100, width: 1200, height: 750 }, 1, [PRIMARY])).toEqual(
      expected,
    );
  });

  it("gives a new window the default size, clamped to a small screen", () => {
    const small: DisplayInfo = {
      id: 9,
      primary: true,
      workArea: { x: 0, y: 0, width: 1280, height: 800 },
    };
    expect(placeBounds(undefined, undefined, [small]).bounds).toEqual({
      x: 0,
      y: 0,
      width: 1280,
      height: 800,
    });
    expect(placeBounds(undefined, undefined, [PRIMARY]).bounds).toMatchObject(DEFAULT_SIZE);
  });
});

describe("parseWindowRecords", () => {
  it("drops malformed, duplicate and unknown ids, keeping id order", () => {
    const bounds = { x: 0, y: 0, width: 800, height: 600 };
    expect(
      parseWindowRecords([
        { id: "w2", bounds, displayId: 2, maximized: true, layout: LAYOUT },
        { id: "w1", bounds },
        { id: "w1", bounds: { x: 1 } },
        { id: "evil", bounds },
        "nope",
      ]),
    ).toEqual([
      { id: "w1", bounds },
      { id: "w2", bounds, displayId: 2, maximized: true, layout: LAYOUT },
    ]);
    expect(parseWindowRecords({ not: "a list" })).toEqual([]);
  });
});

describe("createWindowManager", () => {
  it("opens one primary Main window when nothing was saved", () => {
    const { manager, windows, lastSave } = setup();
    manager.restore();
    expect(windows.map((w) => w.info)).toEqual([{ id: "w1", name: "Main", primary: true }]);
    expect(windows[0]?.rect).toMatchObject(DEFAULT_SIZE);
    vi.advanceTimersByTime(100);
    expect(lastSave()?.map((r) => r.id)).toEqual(["w1"]);
  });

  it("restores saved windows on their displays, falling back to the primary one", () => {
    const saved = [
      { id: "w1", bounds: { x: 100, y: 100, width: 1000, height: 700 }, displayId: 1 },
      {
        id: "w2",
        bounds: { x: 2200, y: 200, width: 1000, height: 700 },
        displayId: 2,
        maximized: true,
        layout: LAYOUT,
      },
    ];
    const withSide = setup(saved);
    withSide.manager.restore();
    expect(withSide.windows.map((w) => [w.info.id, w.info.primary, w.rect.x, w.maximized])).toEqual(
      [
        ["w1", true, 100, false],
        ["w2", false, 2200, true],
      ],
    );
    expect(withSide.manager.layoutOf("w2")).toEqual(LAYOUT);

    const sideGone = setup(saved, [PRIMARY]);
    sideGone.manager.restore();
    expect(sideGone.windows[1]?.rect).toEqual({ x: 460, y: 203, width: 1000, height: 700 });
  });

  it("opens cascading windows handed a thread, lists them and focuses one", () => {
    const { manager, windows } = setup();
    manager.restore();
    expect(manager.open({ threadId: "t-a" })).toBe("w2");
    expect(windows[1]?.info).toEqual({
      id: "w2",
      name: "Window 2",
      primary: false,
      initialThreadId: "t-a",
    });
    expect(windows[1]?.rect.x).toBe((windows[0]?.rect.x ?? 0) + 32);
    expect(manager.list()).toEqual([
      { id: "w1", name: "Main", focused: false },
      { id: "w2", name: "Window 2", focused: true },
    ]);

    const changes = vi.fn();
    manager.onChange(changes);
    expect(manager.focus("w1", "t-b")).toBe(true);
    expect(windows[0]?.focusCount).toBe(1);
    expect(windows[0]?.shown).toEqual(["t-b"]);
    expect(manager.list()[0]?.focused).toBe(true);
    expect(changes).toHaveBeenCalled();
    expect(manager.focus("w9")).toBe(false);
  });

  it("saves placement and layout as windows move, and forgets a closed window", () => {
    const { manager, windows, lastSave } = setup();
    manager.restore();
    manager.open();
    windows[1]?.move({ x: 2100, y: 50, width: 900, height: 600 }, 2);
    manager.setLayout("w2", LAYOUT);
    vi.advanceTimersByTime(100);
    expect(lastSave()?.[1]).toEqual({
      id: "w2",
      bounds: { x: 2100, y: 50, width: 900, height: 600 },
      displayId: 2,
      layout: LAYOUT,
    });

    windows[1]?.close();
    expect(lastSave()?.map((r) => r.id)).toEqual(["w1"]);
    expect(manager.list().map((w) => w.id)).toEqual(["w1"]);
    expect(manager.open()).toBe("w2");
  });

  it("keeps every window's record when the app quits", () => {
    const { manager, windows, lastSave } = setup();
    manager.restore();
    manager.open();
    manager.markQuitting();
    for (const window of windows) window.close();
    expect(lastSave()?.map((r) => r.id)).toEqual(["w1", "w2"]);
    expect(manager.list()).toHaveLength(2);
  });
});

describe("fileWindowStore", () => {
  it("reads a missing or malformed file as nothing saved, and writes JSON", () => {
    const files = new Map<string, string>();
    const fs = {
      readFile: (path: string) => {
        const text = files.get(path);
        if (text === undefined) throw new Error("ENOENT");
        return text;
      },
      writeFile: (path: string, data: string) => {
        files.set(path, data);
      },
    };
    const store = fileWindowStore("/data/windows.json", fs);
    expect(store.load()).toEqual([]);
    files.set("/data/windows.json", "{nope");
    expect(store.load()).toEqual([]);
    const record = { id: "w1", bounds: { x: 1, y: 2, width: 3, height: 4 } };
    store.save([record]);
    expect(store.load()).toEqual([record]);
  });
});

it("propagates update window-write failure while ordinary placement persistence remains best effort", () => {
  const store = fileWindowStore("invented-windows.json", {
    readFile: () => "[]",
    writeFile: () => {
      throw new Error("invented disk failure");
    },
  });
  expect(() => store.save([])).not.toThrow();
  expect(() => store.saveForUpdate!([])).toThrow("invented disk failure");
});

it("keeps the checked update snapshot through direct app exit and restores ordinary close bookkeeping on cancellation", () => {
  const windows: FakeWindow[] = [];
  const writes: WindowRecord[][] = [];
  const store = fileWindowStore("invented-windows.json", {
    readFile: () => "[]",
    writeFile: (_path, text) => {
      writes.push(JSON.parse(text));
    },
  });
  const manager = createWindowManager({
    factory: {
      create: ({ info, bounds, maximized }) => {
        const window = new FakeWindow(info, bounds, maximized);
        windows.push(window);
        return window;
      },
    },
    screen: { displays: () => [PRIMARY] },
    store,
  });
  manager.restore();
  manager.flushForUpdate();
  expect(writes.at(-1)?.map((record) => record.id)).toEqual(["w1"]);
  windows[0]!.close(); // Direct app.exit closes are ignored after the checked snapshot.
  expect(writes.at(-1)?.map((record) => record.id)).toEqual(["w1"]);
  manager.cancelUpdateQuit();
  manager.open();
  windows[1]!.close();
  expect(manager.list().map((window) => window.id)).toEqual(["w1"]);
});
