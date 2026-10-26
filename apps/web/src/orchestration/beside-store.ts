import type { ThreadId } from "@gram/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { currentWindow } from "@/desktop/window-identity";
import { focusPaneComposer } from "@/shell/pane-focus";
import { useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";

// "Keep beside" (⌘\): one worker docked next to its orchestrator's chat, to watch its log, its last
// command or its changes while you talk. The dock only reads: it has no composer, takes no keys and
// never takes focus, so docking a worker can't hold it or take typing from the orchestrator.
// Each window keeps its own dock, as it keeps its own grid: a reload brings it back once the worker
// is checked to still be a worker of the orchestrator in view.

export type BesideTab = "log" | "terminal" | "changes";

interface BesideState {
  /** The worker docked beside the chat. */
  readonly worker: ThreadId | undefined;
  /** The last worker docked, which ⌘\ from the orchestrator brings back. */
  readonly last: ThreadId | undefined;
  readonly tab: BesideTab;
  /** `worker` came back from storage: it isn't shown until `checkRestored` keeps or drops it. */
  readonly restored: boolean;
  dock: (worker: ThreadId) => void;
  close: () => void;
  setTab: (tab: BesideTab) => void;
}

const TABS: readonly BesideTab[] = ["log", "terminal", "changes"];

const storedId = (value: unknown): ThreadId | undefined =>
  typeof value === "string" && value !== "" ? (value as ThreadId) : undefined;

/** A stored dock, with anything malformed left out. */
const storedDock = (persisted: unknown) => {
  const value = typeof persisted === "object" && persisted !== null ? persisted : {};
  const worker = storedId(Reflect.get(value, "worker"));
  const tab: unknown = Reflect.get(value, "tab");
  return {
    worker,
    last: storedId(Reflect.get(value, "last")),
    tab: TABS.find((each) => each === tab) ?? "log",
    restored: worker !== undefined,
  };
};

/**
 * Where this window keeps its dock: a desktop window in local storage under its own id, which the
 * shell brings back with the window at launch; a browser tab in its session storage, which a reload
 * keeps and a new tab doesn't share.
 */
const besideStorage = () => (window.gram ? localStorage : sessionStorage);

export const useBesideStore = create<BesideState>()(
  persist(
    (set) => ({
      worker: undefined,
      last: undefined,
      tab: "log",
      restored: false,
      dock: (worker) => set({ worker, last: worker, restored: false }),
      close: () => set({ worker: undefined, restored: false }),
      setTab: (tab) => set({ tab }),
    }),
    {
      name: typeof window === "undefined" ? "gram.beside" : `gram.beside.${currentWindow().id}`,
      version: 1,
      storage: createJSONStorage(besideStorage),
      partialize: ({ worker, last, tab }) => ({ worker, last, tab }),
      merge: (persisted, current) => ({ ...current, ...storedDock(persisted) }),
    },
  ),
);

/**
 * Keeps a dock restored from storage only while its worker still exists and still reports to an
 * orchestrator in view (in a pane, or the route's thread), and drops it otherwise. Call it once the
 * thread list has loaded; a dock docked in this session is left alone.
 */
export function checkRestored(route: ThreadId | undefined) {
  const { worker, restored } = useBesideStore.getState();
  if (!restored || worker === undefined) return;
  const orchestrator = orchestratorOf(worker);
  const inView =
    orchestrator !== undefined &&
    (orchestrator === route || useLayoutStore.getState().grid.panes.includes(orchestrator));
  if (inView) useBesideStore.setState({ restored: false });
  else closeBeside();
}

/** The orchestrator `worker` reports to, while it is a worker. */
const orchestratorOf = (worker: ThreadId): ThreadId | undefined =>
  useThreadsStore.getState().byId[worker]?.thread.spawnedBy?.threadId;

/**
 * Docks `worker` beside its orchestrator: the orchestrator takes the focused pane (where the worker
 * was, when it was there) and its composer the focus, and the worker shows in the dock. Nothing is
 * sent to either thread. `open` brings a thread into the focused pane and its route.
 */
export function keepBeside(worker: ThreadId, open: (threadId: ThreadId) => void): boolean {
  const orchestrator = orchestratorOf(worker);
  if (orchestrator === undefined) return false;
  const { grid, openInPane } = useLayoutStore.getState();
  if (grid.panes[grid.focused] === worker && !grid.panes.includes(orchestrator)) {
    openInPane(orchestrator, grid.focused);
  }
  open(orchestrator);
  useBesideStore.getState().dock(worker);
  focusPaneComposer(useLayoutStore.getState().grid.focused, { always: true });
  return true;
}

/** Undocks, leaving focus where it is: in the orchestrator's composer when that is where you type. */
export const closeBeside = () => useBesideStore.getState().close();

/**
 * What ⌘\ does here: undock a docked worker; dock the focused worker beside its orchestrator; from
 * an orchestrator, bring back the worker last docked beside it. `undefined` when none applies, so
 * the key splits or unsplits the grid as it always has.
 */
export function besideToggle(focused: ThreadId | undefined): "close" | ThreadId | undefined {
  const { worker, last } = useBesideStore.getState();
  if (worker !== undefined) return "close";
  if (focused === undefined) return undefined;
  if (orchestratorOf(focused) !== undefined) return focused;
  if (last !== undefined && orchestratorOf(last) === focused) return last;
  return undefined;
}
