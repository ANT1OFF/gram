import type { ThreadId } from "@gram/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { currentWindow } from "@/desktop/window-identity";
import { panelOffered, useEmbedShell } from "@/embed/store";
import { isTouch } from "@/lib/use-phone";
import { focusPaneComposer } from "@/shell/pane-focus";
import { fitShell, routePanelRequests, useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";

// "Open beside" (⌘\, ⌘-click a worker, a plain click on a worker's link in its orchestrator's chat):
// one worker in the right panel's Thread tab, next to its orchestrator's chat, to read and steer
// while you talk. Its Thread view is the worker's own transcript and composer, so what you send
// there is you typing into the worker, by the same path and rules; Terminal and Changes only read.
// Opening it moves nothing to either thread and leaves the keyboard the orchestrator composer's;
// the panel's views take keys only once you click or tab into them.
// Each window keeps its own, as it keeps its own grid: a reload brings it back once the worker is
// checked to still be a worker of the orchestrator in view. None of it is synced between machines.

/**
 * The worker's own tools, in the pane's one row under its title: its conversation, its changes, its
 * pull request, its terminal (read only) and its files.
 */
/** The worker pane's own element, which a panel request checks the keys against. */
export const WORKER_PANE_TEST_ID = "beside-dock";

export type BesideTab = "thread" | "changes" | "pr" | "proof" | "terminal" | "files";

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
  /**
   * The worker last open in the pane: its row in the Workers list is drawn current, apart from the
   * keyboard's focus. Back keeps it; it clears when the pane closes.
   */
  readonly current: ThreadId | undefined;
  /**
   * `worker` is a finished worker whose worktree was cleaned up, open as its record: the server has
   * no thread for it, only what Gram kept, so it is never closed for being unknown.
   */
  readonly record: boolean;
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
  /**
   * The pane takes the keys once its worker is drawn (on its title), as when it opened from the
   * pane's own list, its switcher or ↑ ↓: Esc and ↑ ↓ work at once.
   */
  readonly takeKeys: boolean;
  /**
   * A link in the pane (its transcript's "View changes", a file, its PR) opened one of the worker's
   * tools while the keys were on it: once drawn, the keys go to that tool's tab if the link went
   * with the view it was in, so Esc and ↑ ↓ still work. Keys outside the pane are left alone.
   */
  readonly toolKeys: boolean;
  /** Back asked the list for its place: its scroll, and the keys on the current worker's row. */
  readonly returned: boolean;
  dock: (
    worker: ThreadId,
    options?: {
      readonly record?: boolean;
      /** Keep the tool it shows (↑ ↓ and the switcher), where the worker has it. */
      readonly keepTool?: boolean;
      readonly takeKeys?: boolean;
    },
  ) => void;
  close: () => void;
  /** Back to the Workers list: the worker leaves the pane, which stays as it stands. */
  back: () => void;
  setTab: (tab: BesideTab) => void;
  setShown: (shown: boolean) => void;
  setFocused: (focused: boolean) => void;
}

const TABS: readonly BesideTab[] = ["thread", "changes", "pr", "proof", "terminal", "files"];

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
      current: undefined,
      record: false,
      tab: "thread",
      shown: false,
      focused: false,
      before: undefined,
      widenedFrom: undefined,
      restored: false,
      takeKeys: false,
      toolKeys: false,
      returned: false,
      dock: (worker, options) =>
        set((s) => ({
          worker,
          last: worker,
          current: worker,
          record: options?.record === true,
          shown: true,
          restored: false,
          takeKeys: options?.takeKeys === true,
          toolKeys: false,
          returned: false,
          // Another worker opens on its conversation, unless stepped to with the same tool.
          ...(s.worker === worker
            ? {}
            : options?.keepTool === true
              ? {}
              : { tab: "thread" as const, focused: false }),
        })),
      close: () =>
        set({
          worker: undefined,
          current: undefined,
          record: false,
          shown: false,
          focused: false,
          before: undefined,
          widenedFrom: undefined,
          restored: false,
          takeKeys: false,
          toolKeys: false,
          returned: false,
        }),
      back: () =>
        set({
          worker: undefined,
          record: false,
          shown: false,
          focused: false,
          takeKeys: false,
          toolKeys: false,
          returned: true,
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

/** Which of a worker's tools shows what a panel request for it asks. */
const TOOL_FOR: Partial<Record<string, BesideTab>> = {
  diff: "changes",
  pr: "pr",
  files: "files",
  terminal: "terminal",
};

// A link in the worker's own transcript ("View changes", a file, its PR) opens that worker's tool
// in the pane, where it is, rather than the orchestrator's tab behind it.
routePanelRequests((threadId, panel) => {
  const state = useBesideStore.getState();
  const tool = TOOL_FOR[panel];
  if (tool === undefined || besideShown(state) !== threadId) return false;
  // Read before the tool replaces the view the link was in, which takes the keys with it.
  const held = document.activeElement;
  const inPane =
    held instanceof Element && held.closest(`[data-testid="${WORKER_PANE_TEST_ID}"]`) !== null;
  useBesideStore.setState({ tab: tool, toolKeys: inPane });
  return true;
});

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
 * Gives the pane's Workers mode the room a worker's conversation needs, as opening one does: at
 * least `BESIDE_WIDTH`, until the pane closes or goes back to how it stood.
 */
export function widenForWorkers(): void {
  const layout = useLayoutStore.getState();
  if (layout.panelWidth < BESIDE_WIDTH && useBesideStore.getState().widenedFrom === undefined) {
    useBesideStore.setState({ widenedFrom: layout.panelWidth });
    layout.setPanelWidth(BESIDE_WIDTH);
  }
}

/** Puts back the width `widenForWorkers` or opening a worker took, unless dragged since. */
export function narrowFromWorkers(): void {
  const { widenedFrom } = useBesideStore.getState();
  if (widenedFrom === undefined) return;
  useBesideStore.setState({ widenedFrom: undefined });
  const layout = useLayoutStore.getState();
  if (layout.panelWidth === BESIDE_WIDTH) layout.setPanelWidth(widenedFrom);
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
  if (!inView || !besideOffered(orchestrator)) {
    closeBeside();
    return;
  }
  useBesideStore.setState({ restored: false });
  if (shown) revealThreadTab();
}

/**
 * Whether a worker can open in the pane beside `orchestrator`: the one check every way in goes
 * through (a row of the list, ⌘\, a chat link, the switcher, ↑ ↓, a record, a restore). Not on a
 * touch screen, which shows one thing at a time, and only where the pane is offered on the
 * orchestrator (an app in front of Gram may offer it on a coding thread alone).
 */
export function besideOffered(orchestrator: ThreadId | undefined): boolean {
  if (isTouch()) return false;
  const { panel } = useEmbedShell.getState();
  // Gram's own offers it everywhere.
  if (panel === "shown" || orchestrator === undefined) return true;
  const summary = useThreadsStore.getState().byId[orchestrator];
  if (summary === undefined) return true;
  return panelOffered(panel, {
    threadInView: true,
    threadInRepo: summary.git?.repo ?? summary.thread.checkout.kind === "worktree",
    orchestrator: summary.thread.role === "orchestrator",
  });
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
export function keepBeside(
  worker: ThreadId,
  open: (threadId: ThreadId) => void,
  options: { readonly keepFocus?: boolean; readonly keepTool?: boolean } = {},
): boolean {
  const orchestrator = orchestratorOf(worker);
  // A touch screen shows one thing at a time: the worker opens on its own, as any thread does.
  if (orchestrator === undefined || !besideOffered(orchestrator)) return false;
  const { grid, openInPane } = useLayoutStore.getState();
  if (grid.panes[grid.focused] === worker && !grid.panes.includes(orchestrator)) {
    openInPane(orchestrator, grid.focused);
  }
  open(orchestrator);
  // From the pane's own list the keys go into the pane, for ↑ ↓ and Esc.
  useBesideStore.getState().dock(worker, {
    takeKeys: options.keepFocus === true,
    keepTool: options.keepTool === true,
  });
  revealThreadTab();
  if (options.keepFocus !== true) {
    focusPaneComposer(useLayoutStore.getState().grid.focused, { always: true });
  }
  return true;
}

/**
 * Opens a finished worker whose worktree was cleaned up in the pane, as its record: read only,
 * beside the orchestrator already in view. The server has no thread for it, so it is not checked
 * against one.
 */
export function openRecordBeside(
  worker: ThreadId,
  options: { readonly keepTool?: boolean } = {},
): boolean {
  if (!besideOffered(undefined)) return false;
  useBesideStore
    .getState()
    .dock(worker, { record: true, takeKeys: true, keepTool: options.keepTool === true });
  revealThreadTab();
  return true;
}

/**
 * Back from a worker to the pane's Workers list, the pane left as it stands: the worker stays
 * current on the list, which puts back its place and the keys on that worker's row.
 */
export function backToWorkers(): void {
  useBesideStore.getState().back();
  useLayoutStore.getState().setPanelTab("workers");
}

/** Closes the pane: the worker in it, if any, and the panel itself, however it was opened. */
export function closePane(): void {
  closeBeside();
  narrowFromWorkers();
  const layout = useLayoutStore.getState();
  if (fitShell(layout).panel !== "none") layout.togglePanel();
}

/**
 * Opens `worker` beside the chat it was linked from, which is already in view, leaving the focus
 * where it is (on the link). For a link to a worker of `orchestrator`; false for any other thread,
 * which the link then opens as it always has.
 */
export function openBesideFrom(orchestrator: ThreadId, worker: ThreadId): boolean {
  if (orchestratorOf(worker) !== orchestrator || !besideOffered(orchestrator)) return false;
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
  // A touch screen opens nothing beside, but can still close what a wider window left there.
  if (isTouch()) return worker !== undefined && shown ? "close" : undefined;
  if (worker !== undefined) return shown ? "close" : worker;
  if (focused === undefined) return undefined;
  const orchestrator = orchestratorOf(focused);
  if (orchestrator !== undefined) return besideOffered(orchestrator) ? focused : undefined;
  if (last !== undefined && orchestratorOf(last) === focused) return last;
  return undefined;
}
