/** This window as the placement markers see it. */
export interface AppWindow {
  readonly id: string;
  /** "Main", "Window 2"… */
  readonly name: string;
  /** The primary window keeps its grid in `Settings.layout.grid`; others start empty. */
  readonly primary: boolean;
  /** A thread handed to this window when it opened. */
  readonly initialThreadId?: string;
}

const TAB_KEY = "gram.window";

const randomId = () => `tab-${Math.random().toString(36).slice(2, 10)}`;

/**
 * A browser tab: remembered per tab in sessionStorage. A tab opened by "Open in new window" carries
 * `?window=<id>&name=<name>&open=<threadId>`; any other tab is a primary "Main".
 */
export function browserWindow(storage: Storage, search: string): AppWindow {
  const params = new URLSearchParams(search);
  const id = params.get("window");
  if (id) {
    const name = params.get("name") || "New window";
    storage.setItem(TAB_KEY, JSON.stringify({ id, name, primary: false }));
    const open = params.get("open");
    return { id, name, primary: false, ...(open ? { initialThreadId: open } : {}) };
  }
  try {
    const saved = JSON.parse(storage.getItem(TAB_KEY) ?? "null") as Partial<AppWindow> | null;
    if (saved && typeof saved.id === "string" && typeof saved.name === "string") {
      return { id: saved.id, name: saved.name, primary: saved.primary === true };
    }
  } catch {
    // A malformed record starts the tab over.
  }
  const fresh: AppWindow = { id: randomId(), name: "Main", primary: true };
  storage.setItem(TAB_KEY, JSON.stringify(fresh));
  return fresh;
}

let current: AppWindow | undefined;

/** This window: the desktop shell's own, else this browser tab's. */
export function currentWindow(): AppWindow {
  if (current) return current;
  const desktop = typeof window === "undefined" ? undefined : window.gram?.window;
  current = desktop
    ? {
        id: desktop.id,
        name: desktop.name,
        primary: desktop.primary,
        ...(desktop.initialThreadId ? { initialThreadId: desktop.initialThreadId } : {}),
      }
    : browserWindow(window.sessionStorage, window.location.search);
  return current;
}

/** Forgets the cached window, for tests. */
export function resetCurrentWindow() {
  current = undefined;
}
