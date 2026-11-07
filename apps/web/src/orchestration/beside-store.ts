import type { ThreadId } from "@gram/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { currentWindow } from "@/desktop/window-identity";
import { focusPaneComposer } from "@/shell/pane-focus";
import { fitShell, useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";

// "Open beside" (⌘\, ⌘-click a worker, a plain click on a worker's link in its orchestrator's chat):
// one worker in the right panel's Thread tab, next to its orchestrator's chat, to read and steer
// while you talk. Its Thread view is the worker's own transcript and composer, so what you send
// there is you typing into the worker, by the same path and rules; Terminal and Changes only read.
// Opening it moves nothing to either thread and leaves the keyboard the orchestrator composer's;
// the panel's views take keys only once you click or tab into them.
// Each window keeps its own, as it keeps its own grid: a reload brings it back once the worker is
// checked to still be a worker of the orchestrator in view. None of it is synced between machines.

export type BesideTab = "thread" | "terminal" | "changes";

/** How the right panel stood before the Thread tab opened it, which Close puts back. */
interface PanelBefore {
  readonly open: boolean;
  readonly peek: boolean;
  readonly expanded: boolean;
}

interface BesideState {
  /** The worker open beside the chat. */
  readonly worker: ThreadId | undefined;
  /** The last worker opened, which ⌘\ from the orchestrator brings back. */
  readonly last: ThreadId | undefined;
  readonly tab: BesideTab;
  /** The right panel shows the Thread tab, rather than another tab with the worker kept in reach. */
  readonly shown: boolean;
  /** Focus is in the Thread tab's view: its keys, not the chat's. */
  readonly focused: boolean;
  /** The panel as it was before opening, when opening showed it; `undefined` when it was showing. */
  readonly before: PanelBefore | undefined;
  /** The panel's width before opening widened it to `BESIDE_WIDTH`, which Close puts back. */
  readonly widenedFrom: number | undefined;
  /** `worker` came back from storage: it isn't shown until `checkRestored` keeps or drops it. */
  readonly restored: boolean;
  dock: (worker: ThreadId) => void;
  close: () => void;
  setTab: (tab: BesideTab) => void;
  setShown: (shown: boolean) => void;
  setFocused: (focused: boolean) => void;
}

const TABS: readonly BesideTab[] = ["thread", "terminal", "changes"];

/** The least a worker's conversation and composer open at, as wide as the read-only dock was. */
export const BESIDE_WIDTH = 480;

const storedId = (value: unknown): ThreadId | undefined =>
  typeof value === "string" && value !== "" ? (value as ThreadId) : undefined;

/** A stored dock, with anything malformed left out. The read-only dock's Log is the Thread view. */
const storedDock = (persisted: unknown) => {
  const value = typeof persisted === "object" && persisted !== null ? persisted : {};
  const worker = storedId(Reflect.get(value, "worker"));
  const tab: unknown = Reflect.get(value, "tab");
  const shown: unknown = Reflect.get(value, "shown");
  return {
    worker,
    last: storedId(Reflect.get(value, "last")),
    tab: TABS.find((each) => each === tab) ?? "thread",
    shown: worker !== undefined && shown !== false,
    restored: worker !== undefined,
  };
};

/**
 * Where this window keeps it: a desktop window in local storage under its own id, which the shell
 * brings back with the window at launch; a browser tab in its session storage, which a reload keeps
 * and a new tab doesn't share.
 */
const besideStorage = () => (window.gram ? localStorage : sessionStorage);

export const useBesideStore = create<BesideState>()(
  persist(
    (set) => ({
      worker: undefined,
      last: undefined,
      tab: "thread",
      shown: false,
      focused: false,
      before: undefined,
      widenedFrom: undefined,
      restored: false,
      dock: (worker) =>
        set((s) => ({
          worker,
          last: worker,
          shown: true,
          restored: false,
          // Another worker opens on its conversation.
          ...(s.worker === worker ? {} : { tab: "thread" as const, focused: false }),
        })),
      close: () =>
        set({
          worker: undefined,
          shown: false,
          focused: false,
          before: undefined,
          widenedFrom: undefined,
          restored: false,
        }),
      setTab: (tab) => set({ tab }),
      setShown: (shown) => set((s) => (s.shown === shown ? s : { shown, focused: false })),
      setFocused: (focused) => set((s) => (s.focused === focused ? s : { focused })),
    }),
    {
      name: typeof window === "undefined" ? "gram.beside" : `gram.beside.${currentWindow().id}`,
      version: 2,
      storage: createJSONStorage(besideStorage),
      // Version 1 was the read-only dock's, whose Log `storedDock` reads as the Thread view.
      migrate: (persisted) => persisted as BesideState,
      partialize: ({ worker, last, tab, shown }) => ({ worker, last, tab, shown }),
      merge: (persisted, current) => ({ ...current, ...storedDock(persisted) }),
    },
  ),
);

/** The worker the right panel's Thread tab shows now, if it does. */
export const besideShown = (s: Pick<BesideState, "worker" | "shown" | "restored">) =>
  s.worker !== undefined && s.shown && !s.restored ? s.worker : undefined;

/** Shows the right panel on the Thread tab however it fits, noting how it stood if it was hidden. */
function revealThreadTab() {
  const layout = useLayoutStore.getState();
  const hidden = fitShell(layout).panel === "none";
  if (hidden && useBesideStore.getState().before === undefined) {
    useBesideStore.setState({
      before: { open: layout.panelOpen, peek: layout.panelPeek, expanded: layout.panelExpanded },
    });
  }
  // A review in focus would cover the chat the worker is beside.
  if (layout.reviewFocus) layout.setReviewFocus(false);
  if (hidden) layout.revealPanel(undefined, { thread: true });
  // A conversation and its composer need more room than a file list: as wide as the old dock, at
  // least, until Close, unless the user drags it to another width meanwhile.
  if (layout.panelWidth < BESIDE_WIDTH && useBesideStore.getState().widenedFrom === undefined) {
    useBesideStore.setState({ widenedFrom: layout.panelWidth });
    layout.setPanelWidth(BESIDE_WIDTH);
  }
}

/**
 * Keeps one restored from storage only while its worker still exists and still reports to an
 * orchestrator in view (in a pane, or the route's thread), and drops it otherwise. Call it once the
 * thread list has loaded; one opened in this session is left alone.
 */
export function checkRestored(route: ThreadId | undefined) {
  const { worker, restored, shown } = useBesideStore.getState();
  if (!restored || worker === undefined) return;
  const orchestrator = orchestratorOf(worker);
  const inView =
    orchestrator !== undefined &&
    (orchestrator === route || useLayoutStore.getState().grid.panes.includes(orchestrator));
  if (!inView) {
    closeBeside();
    return;
  }
  useBesideStore.setState({ restored: false });
  if (shown) revealThreadTab();
}

/** The orchestrator `worker` reports to, while it is a worker. */
export const orchestratorOf = (worker: ThreadId): ThreadId | undefined =>
  useThreadsStore.getState().byId[worker]?.thread.spawnedBy?.threadId;

/**
 * Opens `worker` beside its orchestrator: the orchestrator takes the focused pane (where the worker
 * was, when it was there) and its composer the focus, and the worker shows in the right panel's
 * Thread tab. Nothing is sent to either thread. `open` brings a thread into the focused pane and its
 * route.
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
  revealThreadTab();
  focusPaneComposer(useLayoutStore.getState().grid.focused, { always: true });
  return true;
}

/**
 * Opens `worker` beside the chat it was linked from, which is already in view, leaving the focus
 * where it is (on the link). For a link to a worker of `orchestrator`; false for any other thread,
 * which the link then opens as it always has.
 */
export function openBesideFrom(orchestrator: ThreadId, worker: ThreadId): boolean {
  if (orchestratorOf(worker) !== orchestrator) return false;
  useBesideStore.getState().dock(worker);
  revealThreadTab();
  return true;
}

/**
 * Closes the Thread tab, putting the panel back as it stood when opening showed it, and leaves the
 * focus where it is: in the orchestrator's composer when that is where you type.
 */
export function closeBeside() {
  const { before, widenedFrom } = useBesideStore.getState();
  useBesideStore.getState().close();
  const layout = useLayoutStore.getState();
  if (widenedFrom !== undefined && layout.panelWidth === BESIDE_WIDTH) {
    layout.setPanelWidth(widenedFrom);
  }
  if (before !== undefined) {
    useLayoutStore.setState({
      panelOpen: before.open,
      panelPeek: before.peek,
      panelExpanded: before.expanded,
    });
  }
}

/**
 * What ⌘\ does here: close a worker open beside the chat, or show it again when the panel is on
 * another tab; open the focused worker beside its orchestrator; from an orchestrator, bring back the
 * worker last open beside it. `undefined` when none applies, so the key splits or unsplits the grid
 * as it always has.
 */
export function besideToggle(focused: ThreadId | undefined): "close" | ThreadId | undefined {
  const { worker, last, shown } = useBesideStore.getState();
  if (worker !== undefined) return shown ? "close" : worker;
  if (focused === undefined) return undefined;
  if (orchestratorOf(focused) !== undefined) return focused;
  if (last !== undefined && orchestratorOf(last) === focused) return last;
  return undefined;
}
