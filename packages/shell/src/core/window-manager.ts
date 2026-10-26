import * as nodeFs from "node:fs";

import type { DesktopWindowInfo, GridLayout } from "@gram/contracts";

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DisplayInfo {
  readonly id: number;
  readonly workArea: Rect;
  readonly primary: boolean;
}

/** A window as `windows.json` keeps it between launches. */
export interface WindowRecord {
  readonly id: string;
  readonly bounds: Rect;
  readonly displayId?: number;
  readonly maximized?: boolean;
  /** The renderer's pane grid; the primary window's lives in `Settings.layout.grid` instead. */
  readonly layout?: GridLayout;
}

export interface WindowStore {
  load(): unknown;
  save(records: readonly WindowRecord[]): void;
  /** Update-only write with errors propagated; no renderer or fsync guarantee. */
  saveForUpdate?(records: readonly WindowRecord[]): void;
}

export interface ScreenPort {
  displays(): readonly DisplayInfo[];
}

/** The slice of a BrowserWindow the manager drives. */
export interface ManagedWindow {
  /** The normal (unmaximized) bounds. */
  bounds(): Rect;
  displayId(): number | undefined;
  isMaximized(): boolean;
  focus(): void;
  /** Asks the window's renderer to show `threadId`. */
  showThread(threadId: string): void;
  /** Called on move, resize, maximize and restore. */
  onPlacementChange(callback: () => void): void;
  onFocus(callback: () => void): void;
  onClosed(callback: () => void): void;
}

export interface WindowFactory {
  create(options: {
    readonly info: DesktopWindowInfo;
    readonly bounds: Rect;
    readonly maximized: boolean;
  }): ManagedWindow;
}

export interface WindowSummary {
  readonly id: string;
  readonly name: string;
  readonly focused: boolean;
}

export const DEFAULT_SIZE = { width: 1440, height: 900 } as const;
const CASCADE_OFFSET = 32;
const WINDOW_ID = /^w(\d{1,4})$/;

const idNumber = (id: string) => Number(WINDOW_ID.exec(id)?.[1] ?? 0);
const byId = (a: { readonly id: string }, b: { readonly id: string }) =>
  idNumber(a.id) - idNumber(b.id);

/** "Main" for the first window, "Window 2"… for the others. */
export const windowName = (id: string): string =>
  idNumber(id) <= 1 ? "Main" : `Window ${idNumber(id)}`;

/** The lowest free `wN`, so the next window after closing Window 2 is Window 2 again. */
export function nextWindowId(ids: Iterable<string>): string {
  const taken = new Set(ids);
  let n = 1;
  while (taken.has(`w${n}`)) n++;
  return `w${n}`;
}

const isRect = (value: unknown): value is Rect =>
  typeof value === "object" &&
  value !== null &&
  ["x", "y", "width", "height"].every((key) => Number.isFinite(Reflect.get(value, key)));

/** Saved windows in id order, dropping anything malformed or duplicated. */
export function parseWindowRecords(input: unknown): WindowRecord[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const records: WindowRecord[] = [];
  for (const item of input) {
    if (typeof item !== "object" || item === null) continue;
    const id: unknown = Reflect.get(item, "id");
    const bounds: unknown = Reflect.get(item, "bounds");
    if (typeof id !== "string" || !WINDOW_ID.test(id) || seen.has(id) || !isRect(bounds)) continue;
    seen.add(id);
    const displayId: unknown = Reflect.get(item, "displayId");
    const maximized: unknown = Reflect.get(item, "maximized");
    const layout: unknown = Reflect.get(item, "layout");
    records.push({
      id,
      bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      ...(typeof displayId === "number" ? { displayId } : {}),
      ...(maximized === true ? { maximized } : {}),
      ...(typeof layout === "object" && layout !== null ? { layout: layout as GridLayout } : {}),
    });
  }
  return records.toSorted(byId);
}

const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

const clampTo = (bounds: Rect, area: Rect): Rect => {
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  return {
    x: Math.min(Math.max(bounds.x, area.x), area.x + area.width - width),
    y: Math.min(Math.max(bounds.y, area.y), area.y + area.height - height),
    width,
    height,
  };
};

/**
 * Where a window goes: its saved bounds on its display when that display is still attached and the
 * window overlaps its work area (clamped to fit), else centred on the primary display.
 */
export function placeBounds(
  bounds: Rect | undefined,
  displayId: number | undefined,
  displays: readonly DisplayInfo[],
): { readonly bounds: Rect; readonly displayId: number | undefined } {
  const primary = displays.find((d) => d.primary) ?? displays[0];
  const home = displays.find((d) => d.id === displayId);
  if (bounds && home && overlaps(bounds, home.workArea)) {
    return { bounds: clampTo(bounds, home.workArea), displayId: home.id };
  }
  if (!primary) return { bounds: bounds ?? { x: 0, y: 0, ...DEFAULT_SIZE }, displayId };
  const area = primary.workArea;
  const width = Math.min(bounds?.width ?? DEFAULT_SIZE.width, area.width);
  const height = Math.min(bounds?.height ?? DEFAULT_SIZE.height, area.height);
  return {
    bounds: {
      x: area.x + Math.round((area.width - width) / 2),
      y: area.y + Math.round((area.height - height) / 2),
      width,
      height,
    },
    displayId: primary.id,
  };
}

/** A new window offset from `from`, on the display `from` is centred on. */
function cascade(from: Rect | undefined, displays: readonly DisplayInfo[]) {
  if (!from) return placeBounds(undefined, undefined, displays);
  const centre = { x: from.x + from.width / 2, y: from.y + from.height / 2, width: 1, height: 1 };
  const display = displays.find((d) => overlaps(centre, d.workArea));
  return placeBounds(
    { ...from, x: from.x + CASCADE_OFFSET, y: from.y + CASCADE_OFFSET },
    display?.id,
    displays,
  );
}

export interface WindowManager {
  /** Reopens the saved windows, or one Main window. */
  restore(): void;
  /** Opens a window, showing `threadId` when given; returns its id. */
  open(options?: { readonly threadId?: string }): string;
  /** Brings a window forward, showing `threadId` there; false when it's gone. */
  focus(windowId: string, threadId?: string): boolean;
  list(): WindowSummary[];
  layoutOf(windowId: string): GridLayout | undefined;
  setLayout(windowId: string, layout: GridLayout): void;
  /** Keeps every open window's record while the app quits, so they come back at launch. */
  markQuitting(): void;
  flushForUpdate(): void;
  /** Resumes ordinary window-close bookkeeping when an update is cancelled. */
  cancelUpdateQuit(): void;
  /** Called when windows open, close or change focus; returns the unsubscribe function. */
  onChange(callback: () => void): () => void;
}

interface LiveWindow {
  readonly window: ManagedWindow;
  record: WindowRecord;
}

/**
 * Which windows exist and where they sit. Placement is saved (debounced) as windows move, and a
 * window closed by the user is forgotten; windows open when the app quits restore at launch.
 */
export function createWindowManager({
  factory,
  screen,
  store,
  saveDelayMs = 500,
}: {
  readonly factory: WindowFactory;
  readonly screen: ScreenPort;
  readonly store: WindowStore;
  readonly saveDelayMs?: number;
}): WindowManager {
  const live = new Map<string, LiveWindow>();
  const listeners = new Set<() => void>();
  let focused: string | undefined;
  let quitting = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const save = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    store.save([...live.values()].map((entry) => entry.record).toSorted(byId));
  };
  const scheduleSave = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(save, saveDelayMs);
  };
  const changed = () => {
    for (const listener of listeners) listener();
  };

  const spawn = (
    placement: { readonly bounds: Rect; readonly displayId: number | undefined },
    id: string,
    options: { maximized?: boolean; layout?: GridLayout; threadId?: string } = {},
  ): string => {
    const info: DesktopWindowInfo = {
      id,
      name: windowName(id),
      primary: id === "w1",
      ...(options.threadId === undefined ? {} : { initialThreadId: options.threadId }),
    };
    const window = factory.create({
      info,
      bounds: placement.bounds,
      maximized: options.maximized === true,
    });
    const entry: LiveWindow = {
      window,
      record: {
        id,
        bounds: placement.bounds,
        ...(placement.displayId === undefined ? {} : { displayId: placement.displayId }),
        ...(options.maximized === true ? { maximized: true } : {}),
        ...(options.layout === undefined ? {} : { layout: options.layout }),
      },
    };
    live.set(id, entry);
    focused = id;

    window.onPlacementChange(() => {
      const { layout } = entry.record;
      const displayId = window.displayId();
      entry.record = {
        id,
        bounds: window.bounds(),
        ...(displayId === undefined ? {} : { displayId }),
        ...(window.isMaximized() ? { maximized: true } : {}),
        ...(layout === undefined ? {} : { layout }),
      };
      scheduleSave();
    });
    window.onFocus(() => {
      if (focused === id) return;
      focused = id;
      changed();
    });
    window.onClosed(() => {
      if (quitting) return;
      live.delete(id);
      if (focused === id) focused = undefined;
      save();
      changed();
    });
    scheduleSave();
    changed();
    return id;
  };

  return {
    restore: () => {
      const displays = screen.displays();
      const records = parseWindowRecords(store.load()).filter((r) => !live.has(r.id));
      if (records.length === 0 && live.size === 0) {
        spawn(placeBounds(undefined, undefined, displays), "w1");
        return;
      }
      for (const record of records) {
        spawn(placeBounds(record.bounds, record.displayId, displays), record.id, {
          ...(record.maximized === true ? { maximized: true } : {}),
          ...(record.layout === undefined ? {} : { layout: record.layout }),
        });
      }
    },
    open: (options = {}) => {
      const from =
        (focused === undefined ? undefined : live.get(focused)) ?? [...live.values()].at(-1);
      return spawn(
        cascade(from?.record.bounds, screen.displays()),
        nextWindowId(live.keys()),
        options.threadId === undefined ? {} : { threadId: options.threadId },
      );
    },
    focus: (windowId, threadId) => {
      const entry = live.get(windowId);
      if (!entry) return false;
      entry.window.focus();
      if (threadId !== undefined) entry.window.showThread(threadId);
      return true;
    },
    list: () =>
      [...live.keys()]
        .toSorted((a, b) => idNumber(a) - idNumber(b))
        .map((id) => ({ id, name: windowName(id), focused: id === focused })),
    layoutOf: (windowId) => live.get(windowId)?.record.layout,
    setLayout: (windowId, layout) => {
      const entry = live.get(windowId);
      if (!entry) return;
      entry.record = { ...entry.record, layout };
      scheduleSave();
    },
    flushForUpdate: () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (!store.saveForUpdate)
        throw new Error("Window persistence cannot confirm an update flush");
      store.saveForUpdate([...live.values()].map((entry) => entry.record).toSorted(byId));
      // app.exit closes windows without before-quit; preserve this successfully written snapshot.
      quitting = true;
    },
    cancelUpdateQuit: () => {
      quitting = false;
    },
    markQuitting: () => {
      quitting = true;
      save();
    },
    onChange: (callback) => {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
  };
}

export interface StoreFs {
  readFile(path: string): string;
  writeFile(path: string, data: string): void;
}

const nodeStoreFs: StoreFs = {
  readFile: (path) => nodeFs.readFileSync(path, "utf8"),
  writeFile: (path, data) => nodeFs.writeFileSync(path, data),
};

/** `windows.json`: a missing or malformed file reads as no saved windows. */
export function fileWindowStore(path: string, fs: StoreFs = nodeStoreFs): WindowStore {
  return {
    load: () => {
      try {
        return JSON.parse(fs.readFile(path)) as unknown;
      } catch {
        return [];
      }
    },
    saveForUpdate: (records) => fs.writeFile(path, `${JSON.stringify(records, null, 2)}\n`),
    save: (records) => {
      try {
        fs.writeFile(path, `${JSON.stringify(records, null, 2)}\n`);
      } catch {
        // Losing a placement only means the window opens centred next launch.
      }
    },
  };
}
