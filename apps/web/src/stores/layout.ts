import {
  GRID_SHAPES,
  loopbackUrl,
  OVERVIEW_OPTIONAL_SECTIONS,
  previewFileFragment,
  previewFileKind,
  previewFileTarget,
  type GridPreset,
  type OverviewOptionalSection,
  type OverviewSidebar,
  type PanelKind,
  type PanelTab,
  type ThreadId,
  type ThreadSummary,
  type WorkspaceId,
} from "@gram/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export type RightPanelTab = PanelTab;

export interface WidthBounds {
  min: number;
  max: number;
  default: number;
}

export const SIDEBAR_WIDTH: WidthBounds = { min: 180, max: 520, default: 280 };
/**
 * `max` only bounds a stored width: the window decides how wide the panel shows, through
 * `panelBounds`.
 */
export const PANEL_WIDTH: WidthBounds = { min: 240, max: 4096, default: 352 };
/** The narrowest the chat (or grid) gets while the panel beside it is dragged wider. */
export const CHAT_MIN_WIDTH = 360;
/** The compact overview's rail: a tile per workspace. */
export const OVERVIEW_RAIL_WIDTH = 60;
/** From this wide an automatic overview is open; narrower, it is compact. */
export const OVERVIEW_OPEN_FROM = 1280;

/**
 * The overview as a window this wide shows it: the mode picked, or for automatic (`undefined`) open
 * from `OVERVIEW_OPEN_FROM` and compact below it.
 */
export const overviewShown = (
  mode: OverviewSidebar | undefined,
  windowWidth: number,
): OverviewSidebar => mode ?? (windowWidth >= OVERVIEW_OPEN_FROM ? "open" : "compact");

const PANEL_TABS: readonly RightPanelTab[] = [
  "diff",
  "pr",
  "files",
  "terminal",
  "preview",
  "connectors",
  "reviews",
  "notifications",
  "needsYou",
];

export const clampWidth = (width: number, bounds: WidthBounds): number =>
  Number.isFinite(width)
    ? Math.round(Math.min(bounds.max, Math.max(bounds.min, width)))
    : bounds.default;

/** The panel's bounds in a window this wide, beside an overview `sidebar` wide. */
export const panelBounds = (windowWidth: number, sidebar: number): WidthBounds => ({
  ...PANEL_WIDTH,
  max: Math.max(PANEL_WIDTH.min, Math.floor(windowWidth - sidebar - CHAT_MIN_WIDTH)),
});

/** What the shell knows of the window and route, kept beside the stored panels for the toggles. */
interface ShellContext {
  windowWidth: number;
  /** The route shows a thread, which the panel's thread tabs are about. */
  threadInView: boolean;
  /**
   * That thread has nothing to diff: no uncommitted change and nothing ahead of its base. Its
   * stored panel then stays closed on the Diff tab, which would say only that, until opened here.
   */
  threadQuiet?: boolean | undefined;
  /** Which page the route is, so `panelPeek` is cleared on leaving it; see `shellPage`. */
  page: string;
}

/** The page `pathname` is, for `ShellContext.page`: Settings is one page across its tabs. */
export const shellPage = (pathname: string): string =>
  pathname === "/settings" || pathname.startsWith("/settings/") ? "/settings" : pathname;

/** The inputs `fitShell` reads. */
export type ShellFitInput = Omit<ShellContext, "page"> &
  Pick<
    LayoutState,
    | "focusMode"
    | "sidebarWidth"
    | "sidebarPeek"
    | "overviewSidebar"
    | "panelOpen"
    | "panelWidth"
    | "panelExpanded"
    | "panelPeek"
    | "panelTab"
    | "reviewRequestsPlacement"
    | "openPrsPlacement"
  >;

/** How the shell lays the side panels out in the room it has. */
export interface ShellFit {
  /** `compact` is the overview's rail, `OVERVIEW_RAIL_WIDTH` wide. */
  sidebar: "full" | "compact" | "none";
  /** The sidebar's column; the stored width when there is room for it. */
  sidebarWidth: number;
  /** `side` beside the chat, `over` it (expanded), or not shown. */
  panel: "side" | "over" | "none";
  panelWidth: number;
  /** A side panel fits beside the chat at its narrowest. */
  panelRoom: boolean;
  /** The expanded sidebar fits beside the chat at its narrowest. */
  sidebarRoom: boolean;
}

/**
 * The side panels for a window this wide, keeping `CHAT_MIN_WIDTH` for the chat, grid, board or
 * Settings between them. Short of room, the panel narrows to its minimum, then the sidebar to its,
 * then the panel steps aside (it can still open over the chat) and last the sidebar steps aside.
 * Stored widths and flags are never changed, so a wider window gets them back.
 */
export function fitShell(input: ShellFitInput): ShellFit {
  const room = input.windowWidth - CHAT_MIN_WIDTH;
  const reviewsTab = input.panelTab === "reviews" && reviewsTabShown(input);
  // A thread's page shows the stored panel; any other only the one opened there, or Reviews.
  const open = input.threadInView
    ? input.panelPeek || (input.panelOpen && !quietDiff(input))
    : input.panelPeek || (reviewsTab && input.panelOpen);
  const sidebarRoom = SIDEBAR_WIDTH.min <= room;

  // The sidebar is the overview: open, its compact rail, or hidden, with automatic open on wide
  // windows and compact below. Short of room it steps aside, unless it was picked Open, which keeps
  // it beside the chat at its narrowest.
  const shown = overviewShown(input.overviewSidebar, input.windowWidth);
  let sidebar: ShellFit["sidebar"] =
    input.focusMode || shown === "hidden" ? "none" : shown === "compact" ? "compact" : "full";
  // Picked Open (or peeked), the overview stays at any width; picked Compact, while the rail fits.
  const keptOpen = input.sidebarPeek || input.overviewSidebar === "open";
  const keptCompact = input.overviewSidebar === "compact";
  const kept = keptOpen || keptCompact;
  // An explicitly shown overview can be narrower than its usual resize minimum. Otherwise its
  // 180 px floor steals the chat's reserved room (including the Glass pane's outer margins).
  const sidebarMin = kept ? Math.max(0, Math.min(SIDEBAR_WIDTH.min, room)) : SIDEBAR_WIDTH.min;
  const shrunkSidebar = (space: number) =>
    Math.max(sidebarMin, Math.min(input.sidebarWidth, space));
  // The rail too, shown over its room, gives way before the chat does.
  const railWidth = kept ? Math.max(0, Math.min(OVERVIEW_RAIL_WIDTH, room)) : OVERVIEW_RAIL_WIDTH;
  const fits = keptOpen || (keptCompact ? OVERVIEW_RAIL_WIDTH <= room : sidebarRoom);
  if (sidebar !== "none" && !fits) sidebar = "none";
  const panelRoom =
    (sidebar === "full" ? SIDEBAR_WIDTH.min : sidebar === "compact" ? OVERVIEW_RAIL_WIDTH : 0) +
      PANEL_WIDTH.min <=
    room;
  const panel: ShellFit["panel"] =
    input.focusMode || !open ? "none" : input.panelExpanded ? "over" : panelRoom ? "side" : "none";

  const sidebarWidth =
    sidebar === "none"
      ? 0
      : sidebar === "compact"
        ? railWidth
        : shrunkSidebar(panel === "side" ? room - PANEL_WIDTH.min : room);
  const beside = Math.max(0, input.windowWidth - sidebarWidth);
  const panelWidth =
    panel === "side"
      ? clampWidth(input.panelWidth, panelBounds(input.windowWidth, sidebarWidth))
      : panel === "over"
        ? beside
        : 0;
  return { sidebar, sidebarWidth, panel, panelWidth, panelRoom, sidebarRoom };
}

/** The Diff tab of a thread with nothing to diff, where the stored panel stays closed. */
const quietDiff = (state: Pick<ShellFitInput, "threadInView" | "threadQuiet" | "panelTab">) =>
  state.threadInView && state.threadQuiet === true && state.panelTab === "diff";

/**
 * What shows a hidden panel in `state`: over the chat where it has no room beside it, and on a page
 * without a thread for that page alone, leaving the threads' stored `panelOpen` as it was.
 */
const showPanelPatch = (state: ShellFitInput): Partial<LayoutState> => {
  const { panelRoom } = fitShell(state);
  // On a thread with nothing to diff it shows for that thread alone, as on a page without one.
  return state.threadInView && !quietDiff(state)
    ? { focusMode: false, panelOpen: true, panelExpanded: !panelRoom }
    : { focusMode: false, panelPeek: true, panelExpanded: !panelRoom };
};

export type FocusDirection = "left" | "right" | "up" | "down";

/** What a scoped palette lists the commands of: a context menu's More… opens one. */
export type PaletteScope =
  | { readonly kind: "thread"; readonly threadId: ThreadId }
  | { readonly kind: "workspace"; readonly workspaceId: WorkspaceId };

export const GRID_PRESETS: readonly GridPreset[] = ["1", "2c", "3c", "2x2", "2x3", "3c2r"];

export const PRESET_LABELS: Record<GridPreset, string> = {
  "1": "1 pane",
  "2c": "2 columns",
  "3c": "3 columns",
  "2x2": "2×2",
  "2x3": "2 columns × 3 rows",
  "3c2r": "3 columns × 2 rows",
};

/** The smallest share of two neighbouring panes a divider leaves either of them. */
export const MIN_PANE_SHARE = 0.15;

export interface GridState {
  preset: GridPreset;
  /** One entry per pane, row by row; `null` is an empty pane. */
  panes: readonly (ThreadId | null)[];
  /** Relative column widths; even while absent. */
  colFr: readonly number[] | undefined;
  /** Relative row heights; even while absent. */
  rowFr: readonly number[] | undefined;
  /** Index of the pane that owns the keyboard; its thread is the route's thread. */
  focused: number;
  /** Shows only the focused pane. Local, not persisted. */
  maximized: boolean;
}

export const EMPTY_GRID: GridState = {
  preset: "1",
  panes: [null],
  colFr: undefined,
  rowFr: undefined,
  focused: 0,
  maximized: false,
};

export const paneCount = (preset: GridPreset): number =>
  GRID_SHAPES[preset].cols * GRID_SHAPES[preset].rows;

/** Growing adds empty panes; shrinking compacts the threads and keeps the focused one. */
export function withPreset(grid: GridState, preset: GridPreset): GridState {
  const count = paneCount(preset);
  const focusedThread = grid.panes[grid.focused] ?? null;
  let panes: (ThreadId | null)[];
  if (count >= grid.panes.length) {
    panes = [...grid.panes, ...Array.from({ length: count - grid.panes.length }, () => null)];
  } else {
    let threads = grid.panes.filter((id): id is ThreadId => id !== null);
    if (focusedThread && threads.indexOf(focusedThread) >= count) {
      threads = [focusedThread, ...threads.filter((id) => id !== focusedThread)];
    }
    panes = Array.from({ length: count }, (_, i): ThreadId | null => threads[i] ?? null);
  }
  const focused = focusedThread
    ? Math.max(0, panes.indexOf(focusedThread))
    : Math.min(grid.focused, count - 1);
  return { preset, panes, colFr: undefined, rowFr: undefined, focused, maximized: false };
}

function focusAt(grid: GridState, index: number): GridState {
  if (index < 0 || index >= grid.panes.length || index === grid.focused) return grid;
  return { ...grid, focused: index };
}

/** Puts `threadId` in pane `index` and focuses it; a thread already shown is focused where it is. */
export function assignPane(grid: GridState, index: number, threadId: ThreadId): GridState {
  if (index < 0 || index >= grid.panes.length) return grid;
  const existing = grid.panes.indexOf(threadId);
  if (existing !== -1) return focusAt(grid, existing);
  const panes = [...grid.panes];
  panes[index] = threadId;
  return { ...grid, panes, focused: index };
}

export const openThreadIn = (grid: GridState, threadId: ThreadId): GridState =>
  assignPane(grid, grid.focused, threadId);

const cellOf = (grid: GridState, index: number) => {
  const { cols } = GRID_SHAPES[grid.preset];
  return { row: Math.floor(index / cols), col: index % cols };
};

const occupiedPanes = (panes: readonly (ThreadId | null)[]): number[] =>
  panes.flatMap((id, i) => (id === null ? [] : [i]));

/**
 * Empties pane `index`. Closing the focused pane moves focus to the nearest pane with a thread: the
 * fewest steps across the grid, then the next pane in reading order, wrapping around.
 */
export function closePaneAt(grid: GridState, index: number): GridState {
  if (index < 0 || index >= grid.panes.length) return grid;
  const panes = [...grid.panes];
  panes[index] = null;
  if (index !== grid.focused) return { ...grid, panes };
  const at = cellOf(grid, index);
  const steps = (i: number) => {
    const cell = cellOf(grid, i);
    return Math.abs(cell.row - at.row) + Math.abs(cell.col - at.col);
  };
  const after = (i: number) => (i - index + panes.length) % panes.length;
  const nearest = occupiedPanes(panes).toSorted(
    (a, b) => steps(a) - steps(b) || after(a) - after(b),
  )[0];
  return { ...grid, panes, focused: nearest ?? index, maximized: false };
}

/**
 * Focuses the next (`1`) or previous (`-1`) pane in reading order, wrapping around. Panes with a
 * thread are the stops; with fewer than two of them, every pane is.
 */
export function cycleFocusIn(grid: GridState, delta: 1 | -1): GridState {
  if (grid.panes.length < 2) return grid;
  const occupied = occupiedPanes(grid.panes);
  const stops = occupied.length >= 2 ? occupied : grid.panes.map((_, i) => i);
  const onward = stops.filter((i) => (delta === 1 ? i > grid.focused : i < grid.focused));
  const next = delta === 1 ? (onward[0] ?? stops[0]) : (onward.at(-1) ?? stops.at(-1));
  return next === undefined ? grid : focusAt(grid, next);
}

/** Swaps the threads in panes `from` and `to`; focus follows the moved thread to `to`. */
export function swapPanes(grid: GridState, from: number, to: number): GridState {
  const count = grid.panes.length;
  if (from === to || from < 0 || to < 0 || from >= count || to >= count) return grid;
  const panes = [...grid.panes];
  panes[from] = grid.panes[to] ?? null;
  panes[to] = grid.panes[from] ?? null;
  return { ...grid, panes, focused: to };
}

export function moveFocusIn(grid: GridState, direction: FocusDirection): GridState {
  const { cols } = GRID_SHAPES[grid.preset];
  const rows = Math.ceil(grid.panes.length / cols);
  let row = Math.floor(grid.focused / cols);
  let col = grid.focused % cols;
  if (direction === "left") col = Math.max(0, col - 1);
  else if (direction === "right") col = Math.min(cols - 1, col + 1);
  else if (direction === "up") row = Math.max(0, row - 1);
  else row = Math.min(rows - 1, row + 1);
  return focusAt(grid, row * cols + col);
}

/** `⌘\`: a single pane splits into two columns beside `candidate`; a grid collapses to its focused pane. */
export function toggleSplitIn(grid: GridState, candidate: ThreadId | undefined): GridState {
  if (grid.preset !== "1") return withPreset(grid, "1");
  const split = withPreset(grid, "2c");
  if (!candidate || split.panes.includes(candidate)) return split;
  return { ...split, panes: [split.panes[0] ?? null, candidate] };
}

/** Moves the boundary after pane `index` so it takes `share` of the pair; the pair's total is kept. */
export function resizeFractions(fr: readonly number[], index: number, share: number): number[] {
  const next = [...fr];
  const a = fr[index];
  const b = fr[index + 1];
  if (a === undefined || b === undefined || !Number.isFinite(share)) return next;
  const pair = a + b;
  const first = pair * Math.min(1 - MIN_PANE_SHARE, Math.max(MIN_PANE_SHARE, share));
  next[index] = first;
  next[index + 1] = pair - first;
  return next;
}

/** The most recently active thread that isn't parked or already shown. */
export function splitCandidate(
  summaries: Iterable<ThreadSummary>,
  shown: readonly (ThreadId | null)[],
): ThreadId | undefined {
  return [...summaries]
    .filter((s) => !s.thread.parked && !shown.includes(s.thread.id))
    .toSorted((a, b) => b.thread.lastActivityAt - a.thread.lastActivityAt)[0]?.thread.id;
}

export interface SidePanels {
  /** The overview's width; synced with `Settings.sidebar.width`. */
  sidebarWidth: number;
  /** The right panel is shown; synced with `Settings.panel`, like its width and tab. */
  panelOpen: boolean;
  panelWidth: number;
  panelTab: RightPanelTab;
  /** Hides both side panels, leaving the chat or grid; synced with `Settings.layout.focusMode`. */
  focusMode: boolean;
  /**
   * The Orchestrator layout's overview sidebar as picked, `undefined` for automatic; synced with
   * `Settings.layout.overviewSidebar` (`overviewSidebarOf`).
   */
  overviewSidebar: OverviewSidebar | undefined;
}

const OVERVIEW_SIDEBAR_MODES: readonly OverviewSidebar[] = ["open", "compact", "hidden"];

/** Stored side-panel state; malformed values are dropped so the defaults apply. */
export function sanitizeSidePanels(raw: unknown): Partial<SidePanels> {
  const r = (raw ?? {}) as Record<string, unknown>;
  const flag = (key: keyof SidePanels) => (typeof r[key] === "boolean" ? { [key]: r[key] } : {});
  return {
    ...(typeof r["sidebarWidth"] === "number"
      ? { sidebarWidth: clampWidth(r["sidebarWidth"], SIDEBAR_WIDTH) }
      : {}),
    ...flag("panelOpen"),
    ...(typeof r["panelWidth"] === "number"
      ? { panelWidth: clampWidth(r["panelWidth"], PANEL_WIDTH) }
      : {}),
    ...(PANEL_TABS.includes(r["panelTab"] as RightPanelTab)
      ? { panelTab: r["panelTab"] as RightPanelTab }
      : {}),
    ...flag("focusMode"),
    ...(OVERVIEW_SIDEBAR_MODES.includes(r["overviewSidebar"] as OverviewSidebar)
      ? { overviewSidebar: r["overviewSidebar"] as OverviewSidebar }
      : {}),
  };
}

/** The overview sidebar's sections, each folded by clicking its title. */
export type OverviewSection = "orchestrators" | "solo" | "pullRequests" | "doneToday";

/** The sections that start folded: the things you check now and then. */
export const OVERVIEW_FOLDED_BY_DEFAULT: readonly OverviewSection[] = ["pullRequests", "doneToday"];

/** The overview sidebar as it was left: which sections are folded, and which show at all. */
export interface OverviewView {
  /** The sections open by default that were folded. */
  overviewFolded: readonly OverviewSection[];
  /** The sections folded by default (`OVERVIEW_FOLDED_BY_DEFAULT`) that were opened. */
  overviewUnfolded: readonly OverviewSection[];
  /** What the overview was before ⌘B hid it, which showing it again restores. */
  overviewBeforeHide: OverviewSidebar | undefined;
  /**
   * The optional sections turned off in Settings → General; synced with
   * `Settings.layout.overviewSections` (`overviewHiddenOf`).
   */
  overviewHidden: readonly OverviewOptionalSection[];
}

const OVERVIEW_SECTIONS: readonly OverviewSection[] = [
  "orchestrators",
  "solo",
  "pullRequests",
  "doneToday",
];

type OverviewFolds = Pick<OverviewView, "overviewFolded" | "overviewUnfolded">;

/** Whether `section` is folded now: by default for the ones that start folded, else once folded. */
export const overviewSectionFolded = (view: OverviewFolds, section: OverviewSection): boolean =>
  OVERVIEW_FOLDED_BY_DEFAULT.includes(section)
    ? !view.overviewUnfolded.includes(section)
    : view.overviewFolded.includes(section);

/** The fold state with `section` folded (`fold`) or open. */
const overviewFoldPatch = (
  view: OverviewFolds,
  section: OverviewSection,
  fold: boolean,
): OverviewFolds => {
  const without = (list: readonly OverviewSection[]) => list.filter((each) => each !== section);
  if (OVERVIEW_FOLDED_BY_DEFAULT.includes(section)) {
    const rest = without(view.overviewUnfolded);
    return {
      overviewFolded: view.overviewFolded,
      overviewUnfolded: fold ? rest : [...rest, section],
    };
  }
  const rest = without(view.overviewFolded);
  return {
    overviewFolded: fold ? [...rest, section] : rest,
    overviewUnfolded: view.overviewUnfolded,
  };
};

/** Stored overview view state; unknown sections are dropped. */
export function sanitizeOverviewView(raw: unknown): Partial<OverviewView> {
  const r = (raw ?? {}) as Record<string, unknown>;
  const folded = r["overviewFolded"];
  const unfolded = r["overviewUnfolded"];
  const hidden = r["overviewHidden"];
  const before = r["overviewBeforeHide"] as OverviewSidebar;
  return {
    ...(Array.isArray(folded)
      ? {
          overviewFolded: OVERVIEW_SECTIONS.filter(
            (section) => folded.includes(section) && !OVERVIEW_FOLDED_BY_DEFAULT.includes(section),
          ),
        }
      : {}),
    ...(Array.isArray(unfolded)
      ? {
          overviewUnfolded: OVERVIEW_FOLDED_BY_DEFAULT.filter((section) =>
            unfolded.includes(section),
          ),
        }
      : {}),
    ...(Array.isArray(hidden)
      ? { overviewHidden: OVERVIEW_OPTIONAL_SECTIONS.filter((section) => hidden.includes(section)) }
      : {}),
    ...(before !== "hidden" && OVERVIEW_SIDEBAR_MODES.includes(before)
      ? { overviewBeforeHide: before }
      : {}),
  };
}

/** Where the "Review requests" list shows: the sidebar, the right panel's Reviews tab, or nowhere. */
export type ReviewRequestsPlacement = "sidebar" | "panel" | "hidden";

const REVIEW_REQUESTS_PLACEMENTS: readonly ReviewRequestsPlacement[] = [
  "sidebar",
  "panel",
  "hidden",
];

/** The right panel has its Reviews tab: one of the PR lists is placed there. */
export const reviewsTabShown = (
  s: Pick<ReviewRequestsView, "reviewRequestsPlacement" | "openPrsPlacement">,
): boolean => s.reviewRequestsPlacement === "panel" || s.openPrsPlacement === "panel";

/** The "Review requests" and "Open PRs" sections' stored view state, one set of fields each. */
export interface ReviewRequestsView {
  reviewRequestsPlacement: ReviewRequestsPlacement;
  /** The section is collapsed. */
  reviewRequestsCollapsed: boolean;
  /** Rows sit under a heading per repository instead of in one list. */
  reviewRequestsGrouped: boolean;
  /** Repositories (`owner/name`) whose group is collapsed. */
  reviewRequestsCollapsedRepos: readonly string[];
  openPrsPlacement: ReviewRequestsPlacement;
  openPrsCollapsed: boolean;
  openPrsGrouped: boolean;
  openPrsCollapsedRepos: readonly string[];
}

/** Stored PR-list view state; a field of the wrong type leaves its default in place. */
export function sanitizeReviewRequestsView(raw: unknown): Partial<ReviewRequestsView> {
  const r = (raw ?? {}) as Record<string, unknown>;
  const view = <P extends "reviewRequests" | "openPrs">(prefix: P) => {
    const collapsed = r[`${prefix}Collapsed`];
    const grouped = r[`${prefix}Grouped`];
    const repos = r[`${prefix}CollapsedRepos`];
    const placement = r[`${prefix}Placement`] as ReviewRequestsPlacement;
    return {
      ...(REVIEW_REQUESTS_PLACEMENTS.includes(placement)
        ? { [`${prefix}Placement`]: placement }
        : {}),
      ...(typeof collapsed === "boolean" ? { [`${prefix}Collapsed`]: collapsed } : {}),
      ...(typeof grouped === "boolean" ? { [`${prefix}Grouped`]: grouped } : {}),
      ...(Array.isArray(repos)
        ? { [`${prefix}CollapsedRepos`]: repos.filter((repo) => typeof repo === "string") }
        : {}),
    } as Partial<ReviewRequestsView>;
  };
  return { ...view("reviewRequests"), ...view("openPrs") };
}

/** The Board's folds, and the overview's folded orchestrators, as they were left. */
export interface WorkspacesView {
  /** Collapsed board groups, by `board:` keys, and folded orchestrators, by `overviewFoldKey`. */
  workspacesCollapsedNodes: readonly string[];
}

/** The fold key of an orchestrator's workers in the overview sidebar, listed while folded. */
export const overviewFoldKey = (workspaceId: string): string => `overview:${workspaceId}`;

/** Stored fold state; a field of the wrong type leaves its default in place. */
export function sanitizeWorkspacesView(raw: unknown): Partial<WorkspacesView> {
  const nodes = ((raw ?? {}) as Record<string, unknown>)["workspacesCollapsedNodes"];
  return Array.isArray(nodes)
    ? { workspacesCollapsedNodes: nodes.filter((node) => typeof node === "string") }
    : {};
}

/** What each workspace's board leaves out. */
export interface BoardFilters {
  /** Workspaces whose board shows archived workers; every other board hides them. */
  boardArchivedShown: readonly string[];
}

/** Stored board filters; a field of the wrong type leaves its default in place. */
export function sanitizeBoardFilters(raw: unknown): Partial<BoardFilters> {
  const shown = ((raw ?? {}) as Record<string, unknown>)["boardArchivedShown"];
  return Array.isArray(shown)
    ? { boardArchivedShown: shown.filter((id) => typeof id === "string") }
    : {};
}

/** How the Diff panel shows a patch: one column, or old and new side by side. */
export type DiffLayout = "unified" | "split";

/** The Diff panel's stored view: its layout and whether the file tree shows. */
export interface DiffView {
  diffLayout: DiffLayout;
  diffTreeShown: boolean;
}

function sanitizeDiffView(raw: unknown): Partial<DiffView> {
  const r = (raw ?? {}) as Record<string, unknown>;
  const layout = r["diffLayout"];
  return {
    ...(layout === "unified" || layout === "split" ? { diffLayout: layout } : {}),
    ...(typeof r["diffTreeShown"] === "boolean" ? { diffTreeShown: r["diffTreeShown"] } : {}),
  };
}

/** An agent's `ui.showPanel` request. */
interface PanelRequest {
  threadId: ThreadId;
  panel: PanelKind;
  target?: string;
  /** A `preview` page the agent already opened in the pane. */
  driven?: boolean;
}

/** The tabs whose panel acts on a request's `target`. */
type TargetedTab = "diff" | "files";

/** The PR panel's own two tabs, inside the right panel's `pr` tab. */
type PrPanelTab = "overview" | "review";

/** A request's `target` waiting for its panel to act on it; `id` tells repeated requests apart. */
export interface PanelTarget {
  id: number;
  threadId: ThreadId;
  target: string;
}

interface PreviewSuggestion {
  id: number;
  threadId: ThreadId;
  url: string;
}

/**
 * The page a thread's Preview tab shows: the last one asked for, or where its page went since. A
 * new `id` is a new request, which loads `url` again even when it is the page already showing.
 */
interface PreviewPage {
  id: number;
  /** The page's address; empty for a `file` until the server says where it loads from. */
  url: string;
  /** The thread's agent opened it in the pane (`browser_navigate`): shown as it is, never loaded. */
  driven?: boolean;
  /** A Markdown or HTML file the tab shows instead of a page on a port, by its path. */
  file?: string | undefined;
  /**
   * What follows an HTML file's served address: `?theme=dark` and `#board`, so a mock opens at a
   * direction in a theme. Its own request, never sent to the server.
   */
  at?: string | undefined;
}

let requestSeq = 0;

export interface LayoutState
  extends
    SidePanels,
    ReviewRequestsView,
    WorkspacesView,
    OverviewView,
    BoardFilters,
    DiffView,
    ShellContext {
  /** The right panel fills the space beside the sidebar, over the chat. Local, not persisted. */
  panelExpanded: boolean;
  /** The panel was opened on a page without a thread; until the route next changes. Local. */
  panelPeek: boolean;
  /** The overview was shown in a window too narrow for it beside the chat. Local. */
  sidebarPeek: boolean;
  grid: GridState;
  paletteOpen: boolean;
  /** Prefill for the palette input, e.g. `>` for actions. */
  paletteQuery: string;
  /** The thread or workspace the palette opened scoped to; local, not persisted. */
  paletteScope: PaletteScope | undefined;
  overlayOpen: boolean;
  /** The last request's target per tab, until that tab's panel consumes it. */
  panelTargets: Readonly<Partial<Record<TargetedTab, PanelTarget>>>;
  /** Shown as a notice in the right panel where there is no Preview tab; opened only on a click. */
  previewSuggestion: PreviewSuggestion | undefined;
  /** Each thread's Preview tab page, by thread id. Local, not persisted. */
  previewPages: Readonly<Record<string, PreviewPage>>;
  /** Held here, not in the panel, so a link can ask for the review before the panel has mounted. */
  prPanelTab: PrPanelTab;

  /** Moving the list to the right panel also opens the panel on its Reviews tab. */
  setReviewRequestsPlacement(placement: ReviewRequestsPlacement): void;
  toggleReviewRequestsCollapsed(): void;
  setReviewRequestsGrouped(grouped: boolean): void;
  toggleReviewRepoCollapsed(repo: string): void;
  /** Moving the list to the right panel also opens the panel on its Reviews tab. */
  setOpenPrsPlacement(placement: ReviewRequestsPlacement): void;
  toggleOpenPrsCollapsed(): void;
  setOpenPrsGrouped(grouped: boolean): void;
  toggleOpenPrsRepoCollapsed(repo: string): void;
  /** Folds or unfolds a board group or an overview orchestrator; `collapsed` forces a side. */
  toggleWorkspaceNode(key: string, collapsed?: boolean): void;
  /** Shows or hides the archived workers on one workspace's board. */
  toggleBoardArchived(workspaceId: string): void;
  setDiffLayout(layout: DiffLayout): void;
  toggleDiffTree(): void;
  openPalette(query?: string, scope?: PaletteScope): void;
  closePalette(): void;
  setOverlayOpen(open: boolean): void;
  setPreset(preset: GridPreset): void;
  /** Focuses the pane showing `threadId`, else loads it into the focused pane. */
  openThread(threadId: ThreadId): void;
  openInPane(threadId: ThreadId, index: number): void;
  closePane(index: number): void;
  focusPane(index: number): void;
  moveFocus(direction: FocusDirection): void;
  /** ⌘⇧] / ⌘⇧[: the next or previous pane with a thread, wrapping around. */
  cycleFocus(delta: 1 | -1): void;
  swapPanes(from: number, to: number): void;
  toggleMaximize(): void;
  toggleSplit(candidate: ThreadId | undefined): void;
  /** Ignored unless there's one positive fraction per column (or row). */
  setFractions(axis: "col" | "row", fr: readonly number[]): void;
  resetFractions(): void;
  /** Replaces the grid, e.g. when restoring the saved layout. */
  setGrid(grid: GridState): void;
  setSidebarWidth(width: number): void;
  setPanelWidth(width: number): void;
  setPanelTab(tab: RightPanelTab): void;
  setPrPanelTab(tab: PrPanelTab): void;
  setPanel(panel: { open: boolean; width: number; tab: RightPanelTab }): void;
  /** Hiding the panel, or either toggle below, restores it to its width first. */
  setPanelExpanded(expanded: boolean): void;
  setFocusMode(focusMode: boolean): void;
  /** The window and route the shell is laying out; clears `panelPeek` when the page changes. */
  setShellContext(context: ShellContext): void;
  /**
   * Shows the panel on `tab` however it fits, as an explicit request to see it does; `thread` says
   * the thread it is for is about to be in view.
   */
  revealPanel(tab?: RightPanelTab, options?: { thread?: boolean }): void;
  /**
   * Picks the overview sidebar's mode; `undefined` is automatic. Picking hidden, here or through
   * the settings, records what it was as `overviewBeforeHide`, which ⌘B shows again; any other pick
   * clears that.
   */
  setOverviewSidebar(mode: OverviewSidebar | undefined): void;
  /**
   * Hides or shows the overview sidebar: shown again, it is what it was before; in focus mode, it
   * leaves focus mode with it shown.
   */
  toggleOverview(): void;
  /** Folds or unfolds one of the overview's sections. */
  toggleOverviewSection(section: OverviewSection): void;
  /** Opens one of the overview's sections if it is folded. */
  unfoldOverviewSection(section: OverviewSection): void;
  /** Which optional sections the overview leaves out (Settings → General). */
  setOverviewHidden(hidden: readonly OverviewOptionalSection[]): void;
  /**
   * Hides or shows the right panel as `fitShell` lays it out; in focus mode, leaves it with the
   * panel shown. Shown where it has no room, it opens over the chat; shown or hidden on a page
   * without a thread, it leaves the thread pages' panel as it was.
   */
  togglePanel(): void;
  toggleFocusMode(): void;
  /**
   * Shows the requested panel, opening the right panel if it's hidden. Ignored unless the request is
   * for `viewedThreadId`; a `preview` request is ignored unless its target is a loopback URL, and
   * opens the Preview tab where `previewPane` says there is one, or suggests the page otherwise.
   */
  requestPanel(
    request: PanelRequest,
    viewedThreadId: ThreadId | undefined,
    options?: { previewPane?: boolean },
  ): void;
  /**
   * Loads `url` in `threadId`'s Preview tab and shows the tab; ignored unless `url` is a loopback
   * URL. `thread` says the thread is about to be in view, as for `revealPanel`.
   */
  openPreview(threadId: ThreadId, url: string, options?: { thread?: boolean }): void;
  /**
   * Shows `path`, a Markdown or HTML file, in `threadId`'s Preview tab where `previewPane` says
   * there is one, and in the Files panel's preview otherwise. An HTML page may be named with a
   * `#fragment` (a mock's board), and `theme` asks a mock page for one of its themes.
   */
  previewFile(
    threadId: ThreadId,
    path: string,
    options: { previewPane: boolean; thread?: boolean; theme?: "dark" | "light" | undefined },
  ): void;
  /** Where `threadId`'s page went since request `id`, so the tab comes back to it. */
  notePreviewPage(threadId: ThreadId, page: PreviewPage): void;
  /**
   * Takes on a page the shell already holds for `threadId`, opened in another window, as this
   * window's without loading it again; the new request's id, or `undefined` when there was one.
   */
  adoptPreviewPage(threadId: ThreadId, url: string, driven?: boolean): number | undefined;
  /** Clears the tab's target if it is still request `id`. */
  consumePanelTarget(tab: TargetedTab, id: number): void;
  dismissPreview(): void;
}

export const useLayoutStore = create<LayoutState>()(
  persist(
    (set, get) => {
      const update = (fn: (grid: GridState) => GridState) => set((s) => ({ grid: fn(s.grid) }));

      return {
        reviewRequestsPlacement: "sidebar",
        reviewRequestsCollapsed: false,
        reviewRequestsGrouped: true,
        reviewRequestsCollapsedRepos: [],
        openPrsPlacement: "sidebar",
        openPrsCollapsed: false,
        openPrsGrouped: true,
        openPrsCollapsedRepos: [],
        workspacesCollapsedNodes: [],
        overviewFolded: [],
        overviewUnfolded: [],
        overviewHidden: [],
        boardArchivedShown: [],
        diffLayout: "unified",
        diffTreeShown: true,
        grid: EMPTY_GRID,
        paletteOpen: false,
        paletteQuery: "",
        paletteScope: undefined,
        overlayOpen: false,
        panelTargets: {},
        previewSuggestion: undefined,
        previewPages: {},
        prPanelTab: "overview",
        sidebarWidth: SIDEBAR_WIDTH.default,
        overviewSidebar: undefined,
        panelOpen: true,
        panelWidth: PANEL_WIDTH.default,
        panelTab: "diff",
        panelExpanded: false,
        panelPeek: false,
        sidebarPeek: false,
        focusMode: false,
        windowWidth: typeof window === "undefined" ? 0 : window.innerWidth,
        threadInView: false,
        threadQuiet: false,
        page: "",
        overviewBeforeHide: undefined,

        setReviewRequestsPlacement: (reviewRequestsPlacement) => {
          if (reviewRequestsPlacement === "panel") {
            set({ reviewRequestsPlacement, panelOpen: true });
            get().revealPanel("reviews");
            return;
          }
          set((s) => ({
            reviewRequestsPlacement,
            ...(s.panelTab === "reviews" && s.openPrsPlacement !== "panel"
              ? { panelTab: "diff" as const }
              : {}),
          }));
        },
        toggleReviewRequestsCollapsed: () =>
          set((s) => ({ reviewRequestsCollapsed: !s.reviewRequestsCollapsed })),
        setReviewRequestsGrouped: (reviewRequestsGrouped) => set({ reviewRequestsGrouped }),
        toggleReviewRepoCollapsed: (repo) =>
          set((s) => ({
            reviewRequestsCollapsedRepos: s.reviewRequestsCollapsedRepos.includes(repo)
              ? s.reviewRequestsCollapsedRepos.filter((r) => r !== repo)
              : [...s.reviewRequestsCollapsedRepos, repo],
          })),
        setOpenPrsPlacement: (openPrsPlacement) => {
          if (openPrsPlacement === "panel") {
            set({ openPrsPlacement, panelOpen: true });
            get().revealPanel("reviews");
            return;
          }
          set((s) => ({
            openPrsPlacement,
            ...(s.panelTab === "reviews" && s.reviewRequestsPlacement !== "panel"
              ? { panelTab: "diff" as const }
              : {}),
          }));
        },
        toggleOpenPrsCollapsed: () => set((s) => ({ openPrsCollapsed: !s.openPrsCollapsed })),
        setOpenPrsGrouped: (openPrsGrouped) => set({ openPrsGrouped }),
        toggleOpenPrsRepoCollapsed: (repo) =>
          set((s) => ({
            openPrsCollapsedRepos: s.openPrsCollapsedRepos.includes(repo)
              ? s.openPrsCollapsedRepos.filter((r) => r !== repo)
              : [...s.openPrsCollapsedRepos, repo],
          })),
        toggleWorkspaceNode: (key, collapsed) =>
          set((s) => {
            const was = s.workspacesCollapsedNodes.includes(key);
            if ((collapsed ?? !was) === was) return {};
            return {
              workspacesCollapsedNodes: was
                ? s.workspacesCollapsedNodes.filter((node) => node !== key)
                : [...s.workspacesCollapsedNodes, key],
            };
          }),
        toggleBoardArchived: (workspaceId) =>
          set((s) => ({
            boardArchivedShown: s.boardArchivedShown.includes(workspaceId)
              ? s.boardArchivedShown.filter((id) => id !== workspaceId)
              : [...s.boardArchivedShown, workspaceId],
          })),
        setDiffLayout: (diffLayout) => set({ diffLayout }),
        toggleDiffTree: () => set((s) => ({ diffTreeShown: !s.diffTreeShown })),
        openPalette: (query = "", scope) =>
          set({ paletteOpen: true, paletteQuery: query, paletteScope: scope }),
        closePalette: () => set({ paletteOpen: false, paletteQuery: "", paletteScope: undefined }),
        setOverlayOpen: (overlayOpen) => set({ overlayOpen }),
        setPreset: (preset) => update((grid) => withPreset(grid, preset)),
        openThread: (threadId) => update((grid) => openThreadIn(grid, threadId)),
        openInPane: (threadId, index) => update((grid) => assignPane(grid, index, threadId)),
        closePane: (index) => update((grid) => closePaneAt(grid, index)),
        focusPane: (index) => update((grid) => focusAt(grid, index)),
        moveFocus: (direction) => update((grid) => moveFocusIn(grid, direction)),
        cycleFocus: (delta) => update((grid) => cycleFocusIn(grid, delta)),
        swapPanes: (from, to) => update((grid) => swapPanes(grid, from, to)),
        toggleMaximize: () =>
          update((grid) =>
            grid.panes.length > 1 ? { ...grid, maximized: !grid.maximized } : grid,
          ),
        toggleSplit: (candidate) => update((grid) => toggleSplitIn(grid, candidate)),
        setFractions: (axis, fr) =>
          update((grid) => {
            const { cols, rows } = GRID_SHAPES[grid.preset];
            const valid =
              fr.length === (axis === "col" ? cols : rows) &&
              fr.every((f) => Number.isFinite(f) && f > 0);
            if (!valid) return grid;
            return axis === "col" ? { ...grid, colFr: [...fr] } : { ...grid, rowFr: [...fr] };
          }),
        resetFractions: () =>
          update((grid) =>
            grid.colFr === undefined && grid.rowFr === undefined
              ? grid
              : { ...grid, colFr: undefined, rowFr: undefined },
          ),
        setGrid: (grid) => set({ grid }),
        setSidebarWidth: (width) => set({ sidebarWidth: clampWidth(width, SIDEBAR_WIDTH) }),
        setPanelWidth: (width) => set({ panelWidth: clampWidth(width, PANEL_WIDTH) }),
        setPanelTab: (panelTab) =>
          set((s) => ({
            panelTab,
            // A tab picked in an open panel keeps it open, Diff on a quiet thread included.
            ...(quietDiff({ ...s, panelTab }) && fitShell(s).panel !== "none"
              ? { panelPeek: true }
              : {}),
          })),
        setPrPanelTab: (prPanelTab) => set({ prPanelTab }),
        setPanel: ({ open, width, tab }) =>
          set((s) => ({
            panelOpen: open,
            panelWidth: clampWidth(width, PANEL_WIDTH),
            panelTab: tab,
            panelExpanded: open && s.panelExpanded,
          })),
        setPanelExpanded: (panelExpanded) => set({ panelExpanded }),
        setFocusMode: (focusMode) =>
          set((s) => ({ focusMode, panelExpanded: !focusMode && s.panelExpanded })),
        setShellContext: ({ windowWidth, threadInView, threadQuiet, page }) =>
          set((s) =>
            s.windowWidth === windowWidth &&
            s.threadInView === threadInView &&
            s.threadQuiet === threadQuiet &&
            s.page === page
              ? {}
              : {
                  windowWidth,
                  threadInView,
                  threadQuiet,
                  page,
                  // A panel opened on the page left goes with it, expanded or not.
                  ...(s.page === page
                    ? {}
                    : { panelPeek: false, ...(s.panelPeek ? { panelExpanded: false } : {}) }),
                },
          ),
        revealPanel: (tab, options) =>
          set((s) => {
            const patch = {
              focusMode: false,
              ...(tab === undefined ? {} : { panelTab: tab }),
            };
            if (options?.thread) {
              // The thread's own panel now, so leaving this page doesn't take it away again.
              const next = {
                ...s,
                ...patch,
                threadInView: true,
                panelOpen: true,
                panelPeek: quietDiff({ ...s, ...patch }),
              };
              return {
                ...patch,
                panelOpen: true,
                // Asked for on a thread with nothing to diff, it shows there too.
                panelPeek: quietDiff({ ...s, ...patch }),
                panelExpanded: s.panelExpanded || !fitShell(next).panelRoom,
              };
            }
            const next = { ...s, ...patch };
            return fitShell(next).panel === "none" ? { ...patch, ...showPanelPatch(next) } : patch;
          }),
        setOverviewSidebar: (overviewSidebar) =>
          set((s) =>
            overviewSidebar !== "hidden"
              ? { overviewSidebar, overviewBeforeHide: undefined }
              : s.overviewSidebar === "hidden"
                ? {}
                : { overviewSidebar, overviewBeforeHide: s.overviewSidebar },
          ),
        toggleOverview: () =>
          set((s) => {
            // Shown again, it is what it was before it was hidden.
            const shown = s.overviewSidebar === "hidden" ? s.overviewBeforeHide : s.overviewSidebar;
            const fit = fitShell({ ...s, focusMode: false });
            if (s.focusMode) {
              const room = fitShell({ ...s, focusMode: false, overviewSidebar: shown });
              return {
                focusMode: false,
                overviewSidebar: shown,
                overviewBeforeHide: undefined,
                sidebarPeek: room.sidebar === "none",
              };
            }
            // Open or compact, it hides.
            if (fit.sidebar !== "none") {
              return {
                overviewSidebar: "hidden",
                overviewBeforeHide: s.overviewSidebar,
                sidebarPeek: false,
              };
            }
            // Shown in a window too narrow for it beside the chat, it shows at its narrowest.
            const room = fitShell({ ...s, overviewSidebar: shown });
            return {
              overviewSidebar: shown,
              overviewBeforeHide: undefined,
              sidebarPeek: room.sidebar === "none",
            };
          }),
        toggleOverviewSection: (section) =>
          set((s) => overviewFoldPatch(s, section, !overviewSectionFolded(s, section))),
        unfoldOverviewSection: (section) =>
          set((s) =>
            overviewSectionFolded(s, section) ? overviewFoldPatch(s, section, false) : {},
          ),
        setOverviewHidden: (hidden) =>
          set((s) => {
            const next = OVERVIEW_OPTIONAL_SECTIONS.filter((section) => hidden.includes(section));
            const same =
              next.length === s.overviewHidden.length &&
              next.every((section, i) => s.overviewHidden[i] === section);
            return same ? {} : { overviewHidden: next };
          }),
        togglePanel: () =>
          set((s) => {
            if (s.focusMode) return showPanelPatch({ ...s, focusMode: false });
            const fit = fitShell(s);
            if (fit.panel === "none") return showPanelPatch(s);
            if (s.panelPeek && (!s.threadInView || quietDiff(s))) {
              return { panelPeek: false, panelExpanded: false };
            }
            if (fit.panel === "over" && !fit.panelRoom) return { panelExpanded: false };
            return { panelOpen: false, panelPeek: false, panelExpanded: false };
          }),
        toggleFocusMode: () => set((s) => ({ focusMode: !s.focusMode, panelExpanded: false })),
        requestPanel: ({ threadId, panel, target, driven }, viewedThreadId, options) => {
          if (threadId !== viewedThreadId) return;
          const id = ++requestSeq;
          if (panel === "preview" && driven === true) {
            // Already in the pane, possibly on a public host the user allowed the agent.
            if (options?.previewPane !== true || target === undefined) return;
            set((s) => ({
              previewPages: { ...s.previewPages, [threadId]: { id, url: target, driven: true } },
            }));
            get().revealPanel("preview");
            return;
          }
          if (panel === "preview") {
            const url = target === undefined ? undefined : loopbackUrl(target);
            const file = target === undefined ? undefined : previewFileTarget(target);
            if (!url && file !== undefined) {
              get().previewFile(threadId, file, { previewPane: options?.previewPane === true });
              return;
            }
            if (!url) return;
            if (options?.previewPane === true) {
              get().openPreview(threadId, url);
              return;
            }
            set({ previewSuggestion: { id, threadId, url } });
          } else {
            get().setPanelTab(panel);
            if (panel === "diff" || panel === "files") {
              set((s) => {
                const { [panel]: _previous, ...rest } = s.panelTargets;
                return {
                  panelTargets:
                    target === undefined ? rest : { ...rest, [panel]: { id, threadId, target } },
                };
              });
            }
          }
          get().revealPanel();
        },
        consumePanelTarget: (tab, id) =>
          set((s) => {
            if (s.panelTargets[tab]?.id !== id) return {};
            const { [tab]: _consumed, ...rest } = s.panelTargets;
            return { panelTargets: rest };
          }),
        dismissPreview: () => set({ previewSuggestion: undefined }),
        openPreview: (threadId, raw, options) => {
          const url = loopbackUrl(raw);
          if (url === undefined) return;
          set((s) => ({
            previewPages: { ...s.previewPages, [threadId]: { id: ++requestSeq, url } },
            previewSuggestion:
              s.previewSuggestion?.threadId === threadId ? undefined : s.previewSuggestion,
          }));
          get().revealPanel("preview", options);
        },
        adoptPreviewPage: (threadId, url, driven) => {
          if (get().previewPages[threadId] !== undefined) return undefined;
          const id = ++requestSeq;
          set((s) => ({
            previewPages: {
              ...s.previewPages,
              [threadId]: { id, url, ...(driven === true ? { driven } : {}) },
            },
          }));
          return id;
        },
        previewFile: (threadId, target, { previewPane, thread, theme }) => {
          const id = ++requestSeq;
          const { path, fragment } = previewFileFragment(target);
          if (previewPane) {
            const at =
              previewFileKind(path) !== "html"
                ? ""
                : `${theme === undefined ? "" : `?theme=${theme}`}${fragment === undefined ? "" : `#${encodeURIComponent(fragment)}`}`;
            set((s) => ({
              previewPages: {
                ...s.previewPages,
                [threadId]: { id, url: "", file: path, ...(at === "" ? {} : { at }) },
              },
            }));
            get().revealPanel("preview", thread === undefined ? undefined : { thread });
            return;
          }
          set((s) => ({
            panelTargets: { ...s.panelTargets, files: { id, threadId, target: path } },
          }));
          get().revealPanel("files", thread === undefined ? undefined : { thread });
        },
        notePreviewPage: (threadId, page) =>
          set((s) => {
            const current = s.previewPages[threadId];
            if (current?.id !== page.id || current.url === page.url) return {};
            return { previewPages: { ...s.previewPages, [threadId]: page } };
          }),
      };
    },
    {
      // A first-paint cache only: the server's settings win at start.
      name: "gram.layout",
      version: 1,
      storage: createJSONStorage(() => window.localStorage),
      partialize: ({
        sidebarWidth,
        panelOpen,
        panelWidth,
        panelTab,
        focusMode,
        overviewSidebar,
        overviewBeforeHide,
        overviewFolded,
        overviewUnfolded,
        overviewHidden,
        reviewRequestsPlacement,
        reviewRequestsCollapsed,
        reviewRequestsGrouped,
        reviewRequestsCollapsedRepos,
        openPrsPlacement,
        openPrsCollapsed,
        openPrsGrouped,
        openPrsCollapsedRepos,
        workspacesCollapsedNodes,
        boardArchivedShown,
        diffLayout,
        diffTreeShown,
      }) => ({
        sidebarWidth,
        panelOpen,
        panelWidth,
        panelTab,
        focusMode,
        overviewSidebar,
        overviewBeforeHide,
        overviewFolded,
        overviewUnfolded,
        overviewHidden,
        reviewRequestsPlacement,
        reviewRequestsCollapsed,
        reviewRequestsGrouped,
        reviewRequestsCollapsedRepos,
        openPrsPlacement,
        openPrsCollapsed,
        openPrsGrouped,
        openPrsCollapsedRepos,
        workspacesCollapsedNodes,
        boardArchivedShown,
        diffLayout,
        diffTreeShown,
      }),
      merge: (persisted, current) => ({
        ...current,
        ...sanitizeSidePanels(persisted),
        ...sanitizeReviewRequestsView(persisted),
        ...sanitizeWorkspacesView(persisted),
        ...sanitizeOverviewView(persisted),
        ...sanitizeBoardFilters(persisted),
        ...sanitizeDiffView(persisted),
      }),
    },
  ),
);
