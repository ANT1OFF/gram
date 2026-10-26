// @vitest-environment happy-dom
import type { ThreadId } from "@gram/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import {
  CHAT_MIN_WIDTH,
  clampWidth,
  fitShell,
  OVERVIEW_RAIL_WIDTH,
  overviewShown,
  panelBounds,
  PANEL_WIDTH,
  sanitizeBoardFilters,
  OVERVIEW_FOLDED_BY_DEFAULT,
  overviewSectionFolded,
  sanitizeOverviewView,
  type OverviewSection,
  sanitizeSidePanels,
  SIDEBAR_WIDTH,
  useLayoutStore,
  type ShellFitInput,
} from "./layout";

const s = useLayoutStore.getState;
const A = "t-a" as ThreadId;
const B = "t-b" as ThreadId;

beforeEach(() =>
  useLayoutStore.setState({
    sidebarWidth: SIDEBAR_WIDTH.default,
    panelOpen: true,
    panelWidth: PANEL_WIDTH.default,
    panelTab: "diff",
    panelExpanded: false,
    focusMode: false,
    panelTargets: {},
    previewSuggestion: undefined,
    previewPages: {},
    panelPeek: false,
    sidebarPeek: false,
    windowWidth: 1440,
    threadInView: true,
    page: "/t/t-a",
    reviewRequestsPlacement: "sidebar",
    overviewSidebar: undefined,
    overviewBeforeHide: undefined,
    overviewFolded: [],
    overviewUnfolded: [],
    overviewHidden: [],
  }),
);

const fit = (overrides: Partial<ShellFitInput> = {}) => fitShell({ ...s(), ...overrides });

describe("fitShell", () => {
  it("lays out the stored widths when they fit beside the chat", () => {
    expect(fit()).toMatchObject({
      sidebar: "full",
      sidebarWidth: SIDEBAR_WIDTH.default,
      panel: "side",
      panelWidth: PANEL_WIDTH.default,
    });
  });

  it("narrows the panel, then an Open overview, so the chat keeps its minimum", () => {
    useLayoutStore.setState({ overviewSidebar: "open" });
    expect(fit({ windowWidth: 900 })).toMatchObject({
      sidebarWidth: 280,
      panelWidth: 900 - 280 - CHAT_MIN_WIDTH,
    });
    const narrow = fit({ windowWidth: 800 });
    expect(narrow).toMatchObject({ sidebar: "full", panel: "side" });
    expect(narrow.sidebarWidth + narrow.panelWidth).toBe(800 - CHAT_MIN_WIDTH);
    expect(narrow.panelWidth).toBeGreaterThanOrEqual(PANEL_WIDTH.min);
  });

  it("puts the panel aside, then the overview, when even their minimums don't fit", () => {
    useLayoutStore.setState({ overviewSidebar: "open" });
    expect(fit({ windowWidth: 700 })).toMatchObject({
      sidebar: "full",
      sidebarWidth: SIDEBAR_WIDTH.default,
      panel: "none",
      panelRoom: false,
    });
    expect(fit({ windowWidth: 500, overviewSidebar: undefined })).toMatchObject({
      sidebar: "none",
      panel: "none",
      sidebarRoom: false,
    });
    // An expanded panel still opens over the chat.
    expect(fit({ windowWidth: 700, panelExpanded: true })).toMatchObject({
      panel: "over",
      panelWidth: 700 - SIDEBAR_WIDTH.default,
    });
  });

  it("keeps the thread's panel off pages without a thread, except the Reviews tab", () => {
    expect(fit({ threadInView: false })).toMatchObject({ panel: "none" });
    expect(
      fit({ threadInView: false, panelTab: "reviews", reviewRequestsPlacement: "panel" }),
    ).toMatchObject({ panel: "side" });
    expect(fit({ threadInView: false, panelPeek: true })).toMatchObject({ panel: "side" });
  });
});

describe("panel toggle", () => {
  it("opens the panel on a page without a thread for that page only", () => {
    s().togglePanel();
    expect(s().panelOpen).toBe(false);
    s().setShellContext({ windowWidth: 1440, threadInView: false, page: "/settings" });
    s().togglePanel();
    expect(s()).toMatchObject({ panelOpen: false, panelPeek: true });
    expect(fitShell(s()).panel).toBe("side");
    // Expanded there, it isn't left expanded behind the thread's hidden panel.
    s().setPanelExpanded(true);
    s().setShellContext({ windowWidth: 1440, threadInView: true, page: "/t/t-a" });
    expect(s()).toMatchObject({ panelPeek: false, panelExpanded: false });
    s().setShellContext({ windowWidth: 1440, threadInView: false, page: "/settings" });
    s().togglePanel();
    // Another page without a thread doesn't inherit it.
    s().setShellContext({ windowWidth: 1440, threadInView: false, page: "/new-task" });
    expect(fitShell(s()).panel).toBe("none");
    s().togglePanel();
    s().togglePanel();
    expect(s()).toMatchObject({ panelOpen: false, panelPeek: false });
    // The thread's panel stays as it was left there: hidden.
    s().setShellContext({ windowWidth: 1440, threadInView: true, page: "/t/t-a" });
    expect(fitShell(s()).panel).toBe("none");
  });

  it("reveals a panel asked for where it has no room, over the chat", () => {
    s().setShellContext({ windowWidth: 600, threadInView: false, page: "/w/x/board" });
    s().revealPanel("pr", { thread: true });
    expect(s()).toMatchObject({ panelTab: "pr", panelOpen: true, panelExpanded: true });
    s().setShellContext({ windowWidth: 600, threadInView: true, page: "/t/t-a" });
    expect(fitShell(s()).panel).toBe("over");
    // Asked for from a page's own expanded panel, it is the thread's once the route gets there.
    s().setShellContext({ windowWidth: 600, threadInView: false, page: "/settings" });
    s().togglePanel();
    expect(s()).toMatchObject({ panelPeek: true, panelExpanded: true });
    s().revealPanel("pr", { thread: true });
    s().setShellContext({ windowWidth: 600, threadInView: true, page: "/t/t-a" });
    expect(fitShell(s()).panel).toBe("over");
    s().setPanelExpanded(false);
    s().setReviewRequestsPlacement("panel");
    expect(s()).toMatchObject({ panelTab: "reviews", panelExpanded: true });
  });

  it("opens over the chat where a side panel has no room, and steps back aside", () => {
    s().setShellContext({ windowWidth: 600, threadInView: true, page: "/t/t-a" });
    expect(fitShell(s()).panel).toBe("none");
    s().togglePanel();
    expect(s()).toMatchObject({ panelOpen: true, panelExpanded: true });
    expect(fitShell(s()).panel).toBe("over");
    s().togglePanel();
    expect(s()).toMatchObject({ panelOpen: true, panelExpanded: false });
  });
});

describe("panel requests", () => {
  it("ignores a request for a thread other than the viewed one", () => {
    s().togglePanel();
    s().requestPanel({ threadId: B, panel: "files", target: "src/a.ts" }, A);
    s().requestPanel({ threadId: B, panel: "preview", target: "http://localhost:3000" }, A);
    s().requestPanel({ threadId: B, panel: "files" }, undefined);
    expect(s()).toMatchObject({
      panelTab: "diff",
      panelOpen: false,
      panelTargets: {},
      previewSuggestion: undefined,
    });
  });

  it("switches the tab, keeps the target and shows a hidden panel", () => {
    s().togglePanel();
    s().requestPanel({ threadId: A, panel: "files", target: "src/a.ts" }, A);
    expect(s()).toMatchObject({ panelTab: "files", panelOpen: true, focusMode: false });
    expect(s().panelTargets.files).toMatchObject({ threadId: A, target: "src/a.ts" });

    s().toggleFocusMode();
    s().requestPanel({ threadId: A, panel: "pr", target: "checks" }, A);
    expect(s()).toMatchObject({ panelTab: "pr", panelOpen: true, focusMode: false });
    expect(s().panelTargets).not.toHaveProperty("pr");
  });

  it("drops a stale target on a bare request and consumes only the matching request", () => {
    s().requestPanel({ threadId: A, panel: "diff", target: "a.ts" }, A);
    const first = s().panelTargets.diff!.id;
    s().requestPanel({ threadId: A, panel: "diff", target: "b.ts" }, A);
    s().consumePanelTarget("diff", first);
    expect(s().panelTargets.diff?.target).toBe("b.ts");
    s().consumePanelTarget("diff", s().panelTargets.diff!.id);
    expect(s().panelTargets.diff).toBeUndefined();

    s().requestPanel({ threadId: A, panel: "diff", target: "c.ts" }, A);
    s().requestPanel({ threadId: A, panel: "diff" }, A);
    expect(s().panelTargets.diff).toBeUndefined();
  });

  it("suggests only loopback preview URLs, without switching the tab", () => {
    s().togglePanel();
    s().requestPanel(
      { threadId: A, panel: "preview", target: "https://organization.example.invalid/" },
      A,
    );
    s().requestPanel({ threadId: A, panel: "preview" }, A);
    expect(s()).toMatchObject({ previewSuggestion: undefined, panelOpen: false });

    s().requestPanel({ threadId: A, panel: "preview", target: "http://localhost:5173/app" }, A);
    expect(s()).toMatchObject({ panelTab: "diff", panelOpen: true });
    expect(s().previewSuggestion).toMatchObject({ threadId: A, url: "http://localhost:5173/app" });
    s().dismissPreview();
    expect(s().previewSuggestion).toBeUndefined();
  });

  it("opens the Preview tab where there is one, and keeps its page per thread", () => {
    s().togglePanel();
    const pane = { previewPane: true };
    s().requestPanel(
      { threadId: A, panel: "preview", target: "https://organization.example.invalid/" },
      A,
      pane,
    );
    expect(s()).toMatchObject({ previewPages: {}, panelOpen: false });

    s().requestPanel({ threadId: A, panel: "preview", target: "http://127.0.0.1:5173/" }, A, pane);
    expect(s()).toMatchObject({
      panelTab: "preview",
      panelOpen: true,
      previewSuggestion: undefined,
    });
    const first = s().previewPages[A]!;
    expect(first.url).toBe("http://127.0.0.1:5173/");

    // Where the page went is kept for the thread, and a new request loads its URL again.
    s().notePreviewPage(A, { id: first.id, url: "http://127.0.0.1:5173/settings" });
    expect(s().previewPages[A]).toEqual({ id: first.id, url: "http://127.0.0.1:5173/settings" });
    s().openPreview(A, "http://127.0.0.1:5173/");
    expect(s().previewPages[A]!.id).toBeGreaterThan(first.id);
    // A note about a request that has since been replaced changes nothing.
    s().notePreviewPage(A, { id: first.id, url: "http://127.0.0.1:5173/old" });
    expect(s().previewPages[A]!.url).toBe("http://127.0.0.1:5173/");

    s().openPreview(B, "http://localhost:3000");
    expect(s().previewPages[B]!.url).toBe("http://localhost:3000/");
    s().openPreview(B, "http://intranet.example/");
    expect(s().previewPages[B]!.url).toBe("http://localhost:3000/");
  });

  it("takes on a page another window opened, but never over this window's own", () => {
    const id = s().adoptPreviewPage(A, "http://127.0.0.1:5173/");
    expect(s().previewPages[A]).toEqual({ id, url: "http://127.0.0.1:5173/" });
    expect(s().adoptPreviewPage(A, "http://127.0.0.1:9999/")).toBeUndefined();
    expect(s().previewPages[A]!.url).toBe("http://127.0.0.1:5173/");
    // Adopting shows nothing by itself: the tab was already being looked at.
    expect(s().panelTab).toBe("diff");
  });

  it("previews a Markdown or HTML file in the Preview tab, or in Files where there is none", () => {
    s().requestPanel({ threadId: A, panel: "preview", target: "/tmp/report/dashboard.html" }, A, {
      previewPane: true,
    });
    expect(s()).toMatchObject({ panelTab: "preview", panelOpen: true });
    expect(s().previewPages[A]).toMatchObject({ url: "", file: "/tmp/report/dashboard.html" });
    // A relative path, or a file that isn't a page, is no preview target.
    s().requestPanel({ threadId: B, panel: "preview", target: "docs/a.md" }, B, {
      previewPane: true,
    });
    s().requestPanel({ threadId: B, panel: "preview", target: "/tmp/a.ts" }, B, {
      previewPane: true,
    });
    expect(s().previewPages[B]).toBeUndefined();

    s().previewFile(B, "/repo/README.md", { previewPane: false });
    expect(s().panelTab).toBe("files");
    expect(s().panelTargets.files).toMatchObject({ threadId: B, target: "/repo/README.md" });
    expect(s().previewPages[B]).toBeUndefined();
  });
});

describe("side panels", () => {
  it("hides the overview and the right panel independently", () => {
    s().toggleOverview();
    s().togglePanel();
    expect(s()).toMatchObject({ overviewSidebar: "hidden", panelOpen: false, focusMode: false });
    s().toggleOverview();
    expect(s()).toMatchObject({ overviewSidebar: undefined, panelOpen: false });
  });

  it("focus mode keeps the sides' own state; a side toggle leaves focus mode with that side shown", () => {
    s().togglePanel();
    s().toggleOverview();
    s().toggleFocusMode();
    expect(s()).toMatchObject({ focusMode: true, overviewSidebar: "hidden", panelOpen: false });

    s().toggleOverview();
    expect(s()).toMatchObject({ focusMode: false, overviewSidebar: undefined, panelOpen: false });

    s().toggleFocusMode();
    s().togglePanel();
    expect(s()).toMatchObject({ focusMode: false, panelOpen: true });
  });

  it("clamps and rounds widths", () => {
    expect(clampWidth(90, SIDEBAR_WIDTH)).toBe(180);
    expect(clampWidth(1200.4, PANEL_WIDTH)).toBe(1200);
    expect(clampWidth(300.6, PANEL_WIDTH)).toBe(301);
    expect(clampWidth(Number.NaN, PANEL_WIDTH)).toBe(PANEL_WIDTH.default);
    s().setSidebarWidth(1000);
    expect(s().sidebarWidth).toBe(520);
  });

  it("lets the panel grow until the chat is at its narrowest, and never below its minimum", () => {
    const wide = panelBounds(1920, SIDEBAR_WIDTH.default);
    expect(wide.max).toBe(1920 - SIDEBAR_WIDTH.default - CHAT_MIN_WIDTH);
    expect(clampWidth(1400, wide)).toBe(wide.max);
    expect(clampWidth(1000, wide)).toBe(1000);
    // A width dragged in a wide window shows narrower in a small one, and the minimum still holds.
    expect(clampWidth(1000, panelBounds(1024, 48))).toBe(1024 - 48 - CHAT_MIN_WIDTH);
    expect(panelBounds(700, SIDEBAR_WIDTH.default).max).toBe(PANEL_WIDTH.min);
    expect(clampWidth(100, panelBounds(1920, 0))).toBe(PANEL_WIDTH.min);
  });

  it("an expanded panel goes back to its width when it, or everything, is hidden", () => {
    s().setPanelExpanded(true);
    s().setPanel({ open: true, width: 500, tab: "pr" });
    expect(s()).toMatchObject({ panelExpanded: true, panelWidth: 500 });
    s().togglePanel();
    expect(s()).toMatchObject({ panelExpanded: false, panelOpen: false, panelWidth: 500 });

    s().togglePanel();
    s().setPanelExpanded(true);
    s().toggleFocusMode();
    expect(s().panelExpanded).toBe(false);
    s().toggleFocusMode();
    s().setPanelExpanded(true);
    s().setPanel({ open: false, width: 500, tab: "pr" });
    expect(s().panelExpanded).toBe(false);
  });

  it("lays the overview out at the sidebar's width, unless hidden", () => {
    expect(fit()).toMatchObject({
      sidebar: "full",
      sidebarWidth: SIDEBAR_WIDTH.default,
      panel: "side",
    });
    expect(fit({ overviewSidebar: "open", sidebarWidth: 320 })).toMatchObject({
      sidebar: "full",
      sidebarWidth: 320,
    });
    expect(fit({ overviewSidebar: "hidden" })).toMatchObject({
      sidebar: "none",
      sidebarWidth: 0,
    });
    expect(fit({ focusMode: true })).toMatchObject({ sidebar: "none" });
    // Short of room it steps aside rather than folding to the strip, unless asked for.
    expect(fit({ windowWidth: 500 })).toMatchObject({
      sidebar: "none",
      sidebarRoom: false,
    });
    // Shown over its room there, an automatic one is compact, as below 1280 px.
    expect(fit({ windowWidth: 500, sidebarPeek: true })).toMatchObject({
      sidebar: "compact",
      sidebarWidth: OVERVIEW_RAIL_WIDTH,
    });
  });

  it("⌘B hides the overview, and shows it again as it was", () => {
    s().toggleOverview();
    expect(s().overviewSidebar).toBe("hidden");
    s().toggleOverview();
    expect(s().overviewSidebar).toBeUndefined();

    // An explicit Open comes back Open.
    s().setOverviewSidebar("open");
    s().toggleOverview();
    expect(s().overviewSidebar).toBe("hidden");
    s().toggleOverview();
    expect(s().overviewSidebar).toBe("open");

    // From focus mode it leaves focus mode with the overview shown, as it was.
    s().toggleOverview();
    s().toggleFocusMode();
    s().toggleOverview();
    expect(s()).toMatchObject({ focusMode: false, overviewSidebar: "open" });

    // Automatic, in a narrow window, it shows over its room, compact as automatic is there.
    s().setOverviewSidebar(undefined);
    useLayoutStore.setState({ windowWidth: 500 });
    expect(fit().sidebar).toBe("none");
    s().toggleOverview();
    expect(s().sidebarPeek).toBe(true);
    expect(fit().sidebar).toBe("compact");
    s().toggleOverview();
    expect(s()).toMatchObject({ overviewSidebar: "hidden", sidebarPeek: false });
  });

  it("⌘B after a Settings change shows the overview as Settings last had it", () => {
    useLayoutStore.setState({ overviewSidebar: "open" });
    s().toggleOverview();
    expect(s().overviewBeforeHide).toBe("open");
    // Picked Automatic, then Hidden, in Settings: the old Open is not what comes back.
    s().setOverviewSidebar(undefined);
    expect(s().overviewBeforeHide).toBeUndefined();
    s().setOverviewSidebar("hidden");
    s().toggleOverview();
    expect(s().overviewSidebar).toBeUndefined();

    // Hidden from Settings while Open, ⌘B brings Open back; the synced echo of Hidden keeps it.
    s().setOverviewSidebar("open");
    s().setOverviewSidebar("hidden");
    s().setOverviewSidebar("hidden");
    s().toggleOverview();
    expect(s().overviewSidebar).toBe("open");
  });

  it("lays out automatic open from 1280 px and compact below, the rail at its own width", () => {
    expect(overviewShown(undefined, 1280)).toBe("open");
    expect(overviewShown(undefined, 1279)).toBe("compact");
    expect(overviewShown("open", 900)).toBe("open");
    expect(overviewShown("compact", 1600)).toBe("compact");
    expect(overviewShown("hidden", 1600)).toBe("hidden");
    expect(fit({ windowWidth: 1440 })).toMatchObject({ sidebar: "full" });
    expect(fit({ windowWidth: 1100 })).toMatchObject({
      sidebar: "compact",
      sidebarWidth: OVERVIEW_RAIL_WIDTH,
      panel: "side",
      panelWidth: PANEL_WIDTH.default,
    });
    expect(fit({ windowWidth: 1600, overviewSidebar: "compact" })).toMatchObject({
      sidebar: "compact",
      sidebarWidth: OVERVIEW_RAIL_WIDTH,
    });
    expect(fit({ windowWidth: 1100, overviewSidebar: "open" })).toMatchObject({ sidebar: "full" });
    // Beside the rail the panel keeps its room where the open overview would leave it none: the
    // panel's room is the rail's, not the sidebar's.
    const narrow = CHAT_MIN_WIDTH + OVERVIEW_RAIL_WIDTH + PANEL_WIDTH.min;
    expect(fit({ windowWidth: narrow })).toMatchObject({
      sidebar: "compact",
      panel: "side",
      panelRoom: true,
      panelWidth: PANEL_WIDTH.min,
    });
    expect(fit({ windowWidth: narrow, overviewSidebar: "open" })).toMatchObject({
      sidebar: "full",
      panelRoom: false,
      panel: "none",
    });
    // At 1000 px the rail, a chat of at least its narrowest and the panel at its stored width.
    const at1000 = fit({ windowWidth: 1000 });
    expect(at1000).toMatchObject({ sidebar: "compact", panel: "side" });
    expect(1000 - at1000.sidebarWidth - at1000.panelWidth).toBeGreaterThanOrEqual(CHAT_MIN_WIDTH);
    // Extremely narrow, an automatic one steps aside as before; Open stays, and Compact stays while
    // the rail fits beside the chat at its narrowest.
    expect(fit({ windowWidth: 500 })).toMatchObject({ sidebar: "none" });
    expect(fit({ windowWidth: 500, overviewSidebar: "compact" })).toMatchObject({
      sidebar: "compact",
      sidebarWidth: OVERVIEW_RAIL_WIDTH,
    });
    const railFits = CHAT_MIN_WIDTH + OVERVIEW_RAIL_WIDTH;
    expect(fit({ windowWidth: railFits, overviewSidebar: "compact" })).toMatchObject({
      sidebar: "compact",
      sidebarWidth: OVERVIEW_RAIL_WIDTH,
    });
    expect(fit({ windowWidth: railFits - 1, overviewSidebar: "compact" })).toMatchObject({
      sidebar: "none",
      sidebarWidth: 0,
    });
    expect(fit({ windowWidth: 500, overviewSidebar: "open" })).toMatchObject({ sidebar: "full" });
    // Shown over its room there, the rail gives way before the chat does, as the open one does.
    const tight = CHAT_MIN_WIDTH + 40;
    expect(fit({ windowWidth: tight, sidebarPeek: true })).toMatchObject({
      sidebar: "compact",
      sidebarWidth: 40,
    });
  });

  it("⌘B hides a compact overview and shows it compact again", () => {
    useLayoutStore.setState({ windowWidth: 1100 });
    // Automatic, compact at this width.
    s().toggleOverview();
    expect(s()).toMatchObject({ overviewSidebar: "hidden", overviewBeforeHide: undefined });
    expect(fit().sidebar).toBe("none");
    s().toggleOverview();
    expect(s().overviewSidebar).toBeUndefined();
    expect(fit().sidebar).toBe("compact");
    // Picked Compact on a wide window: back Compact.
    useLayoutStore.setState({ windowWidth: 1440 });
    s().setOverviewSidebar("compact");
    s().toggleOverview();
    expect(s()).toMatchObject({ overviewSidebar: "hidden", overviewBeforeHide: "compact" });
    s().toggleOverview();
    expect(s()).toMatchObject({ overviewSidebar: "compact", overviewBeforeHide: undefined });
    expect(fit().sidebar).toBe("compact");
    // The Expand and Compact buttons pick the mode outright.
    s().setOverviewSidebar("open");
    expect(fit().sidebar).toBe("full");
  });

  it("records what the overview was when it is picked hidden, there or through the settings", () => {
    s().setOverviewSidebar("compact");
    s().setOverviewSidebar("hidden");
    expect(s()).toMatchObject({ overviewSidebar: "hidden", overviewBeforeHide: "compact" });
    // Hidden again (a sync echoing it back) keeps what it was.
    s().setOverviewSidebar("hidden");
    expect(s().overviewBeforeHide).toBe("compact");
    s().toggleOverview();
    expect(s()).toMatchObject({ overviewSidebar: "compact", overviewBeforeHide: undefined });
    // From automatic: shown again automatic.
    s().setOverviewSidebar(undefined);
    s().setOverviewSidebar("hidden");
    expect(s().overviewBeforeHide).toBeUndefined();
    // Any other pick clears it, so a later ⌘B never brings back a stale mode.
    s().setOverviewSidebar("open");
    s().setOverviewSidebar("hidden");
    expect(s().overviewBeforeHide).toBe("open");
    s().setOverviewSidebar("compact");
    expect(s().overviewBeforeHide).toBeUndefined();
  });

  it("keeps an Open overview beside the chat in a narrow window, the panel stepping aside first", () => {
    useLayoutStore.setState({ overviewSidebar: "open" });
    expect(fit({ windowWidth: 500 })).toMatchObject({ sidebar: "full", panel: "none" });
    for (const windowWidth of [500, 520, 540]) {
      const fitted = fit({ windowWidth, overviewSidebar: "open" });
      expect(fitted).toMatchObject({ sidebar: "full", panel: "none", panelWidth: 0 });
      expect(windowWidth - fitted.sidebarWidth).toBe(CHAT_MIN_WIDTH);
      // Automatic shown over its room is compact there (below 1280 px): the rail, the chat beside.
      const peeked = fit({ windowWidth, overviewSidebar: undefined, sidebarPeek: true });
      expect(peeked).toMatchObject({ sidebar: "compact", sidebarWidth: OVERVIEW_RAIL_WIDTH });
      expect(windowWidth - peeked.sidebarWidth).toBeGreaterThanOrEqual(CHAT_MIN_WIDTH);
    }
    expect(s().sidebarWidth).toBe(SIDEBAR_WIDTH.default);
    expect(fit({ windowWidth: 700 })).toMatchObject({
      sidebar: "full",
      sidebarWidth: SIDEBAR_WIDTH.default,
      panel: "none",
    });
    // Automatic steps aside there instead.
    expect(fit({ windowWidth: 500, overviewSidebar: undefined })).toMatchObject({
      sidebar: "none",
    });
  });

  it("folds the overview's sections and keeps only the ones it knows", () => {
    s().toggleOverviewSection("solo");
    s().toggleOverviewSection("orchestrators");
    expect(s().overviewFolded).toEqual(["solo", "orchestrators"]);
    s().toggleOverviewSection("solo");
    expect(s().overviewFolded).toEqual(["orchestrators"]);
    expect(sanitizeOverviewView({ overviewFolded: ["solo", "prs", 3] })).toEqual({
      overviewFolded: ["solo"],
    });
    expect(sanitizeOverviewView({ overviewFolded: "solo" })).toEqual({});
    expect(sanitizeOverviewView({ overviewBeforeHide: "open" })).toEqual({
      overviewBeforeHide: "open",
    });
    expect(sanitizeOverviewView({ overviewBeforeHide: "hidden" })).toEqual({});
  });

  it("starts Pull requests and Done today folded, and remembers them opened", () => {
    const folded = (section: OverviewSection) => overviewSectionFolded(s(), section);
    expect(OVERVIEW_FOLDED_BY_DEFAULT).toEqual(["pullRequests", "doneToday"]);
    expect(folded("pullRequests")).toBe(true);
    expect(folded("doneToday")).toBe(true);
    expect(folded("solo")).toBe(false);
    s().toggleOverviewSection("pullRequests");
    expect(folded("pullRequests")).toBe(false);
    expect(s().overviewUnfolded).toEqual(["pullRequests"]);
    expect(s().overviewFolded).toEqual([]);
    s().toggleOverviewSection("pullRequests");
    expect(folded("pullRequests")).toBe(true);
    expect(s().overviewUnfolded).toEqual([]);

    // ⌘J opens a folded section, and leaves an open one open.
    s().toggleOverviewSection("orchestrators");
    s().unfoldOverviewSection("orchestrators");
    expect(folded("orchestrators")).toBe(false);
    s().unfoldOverviewSection("orchestrators");
    expect(folded("orchestrators")).toBe(false);
    s().unfoldOverviewSection("doneToday");
    expect(folded("doneToday")).toBe(false);

    // A default-folded section is never kept among the folded ones, nor the reverse.
    expect(
      sanitizeOverviewView({
        overviewFolded: ["doneToday", "solo"],
        overviewUnfolded: ["solo", "pullRequests", "x"],
      }),
    ).toEqual({ overviewFolded: ["solo"], overviewUnfolded: ["pullRequests"] });
  });

  it("keeps the sections Settings turns off in the column's order", () => {
    s().setOverviewHidden(["usage", "solo"]);
    expect(s().overviewHidden).toEqual(["solo", "usage"]);
    const before = s().overviewHidden;
    s().setOverviewHidden(["solo", "usage"]);
    expect(s().overviewHidden).toBe(before);
    s().setOverviewHidden([]);
    expect(s().overviewHidden).toEqual([]);
    expect(sanitizeOverviewView({ overviewHidden: ["doneToday", "orchestrators", 1] })).toEqual({
      overviewHidden: ["doneToday"],
    });
  });

  it("restores stored side panels and drops malformed values", () => {
    expect(
      sanitizeSidePanels({
        sidebarWidth: 10,
        panelOpen: "no",
        panelTab: "files",
        focusMode: 1,
      }),
    ).toEqual({ sidebarWidth: 180, panelTab: "files" });
    expect(sanitizeSidePanels({ overviewSidebar: "hidden" })).toEqual({
      overviewSidebar: "hidden",
    });
    expect(sanitizeSidePanels({ overviewSidebar: "wide" })).toEqual({});
    expect(sanitizeSidePanels({ panelTab: "logs" })).toEqual({});
    expect(sanitizeSidePanels(undefined)).toEqual({});
  });

  it("remembers per workspace which boards show their archived workers", () => {
    useLayoutStore.setState({ boardArchivedShown: [] });
    s().toggleBoardArchived("w-1");
    s().toggleBoardArchived("w-2");
    s().toggleBoardArchived("w-1");
    expect(s().boardArchivedShown).toEqual(["w-2"]);
    expect(sanitizeBoardFilters({ boardArchivedShown: ["w-1", 2] })).toEqual({
      boardArchivedShown: ["w-1"],
    });
    expect(sanitizeBoardFilters({ boardArchivedShown: "w-1" })).toEqual({});
    expect(sanitizeBoardFilters(undefined)).toEqual({});
  });
});
