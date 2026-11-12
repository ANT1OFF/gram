import type { ThreadId } from "@gram/contracts";
import { useParams, useRouterState } from "@tanstack/react-router";
import { useLayoutEffect } from "react";

import { panelOffered, useEmbedShell } from "@/embed/store";
import { useInboxDock } from "@/inbox/inbox-dock";
import { usePhone } from "@/lib/use-phone";
import { useServerSettings } from "@/settings-sync/store";
import { useWindowWidth } from "@/shell/side-resize";
import {
  clampWidth,
  fitShell,
  panelBoundsFor,
  panelWidthFor,
  shellPage,
  useLayoutStore,
} from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";
import { useViewStore } from "@/views/view-store";

/**
 * The shell's columns, laid out from this render's window and route: the store's copy, which this
 * keeps current, is for the toggles.
 */
export function useShellLayout() {
  const focusMode = useLayoutStore((s) => s.focusMode);
  const sidebarWidth = useLayoutStore((s) => s.sidebarWidth);
  const sidebarPeek = useLayoutStore((s) => s.sidebarPeek);
  const overviewSidebar = useLayoutStore((s) => s.overviewSidebar);
  const panelOpen = useLayoutStore((s) => s.panelOpen);
  const panelWidth = useLayoutStore((s) => s.panelWidth);
  const panelExpanded = useLayoutStore((s) => s.panelExpanded);
  const panelPeek = useLayoutStore((s) => s.panelPeek);
  const panelTab = useLayoutStore((s) => s.panelTab);
  const reviewWidth = useLayoutStore((s) => s.reviewWidth);
  const reviewFocus = useLayoutStore((s) => s.reviewFocus);
  const reviewRequestsPlacement = useLayoutStore((s) => s.reviewRequestsPlacement);
  const openPrsPlacement = useLayoutStore((s) => s.openPrsPlacement);
  const setShellContext = useLayoutStore((s) => s.setShellContext);
  const panelLeft = useServerSettings((s) => s.settings?.panel.side === "left");
  const { width: windowWidth, resizing: windowResizing } = useWindowWidth();
  const threadId = useParams({ strict: false }).threadId as ThreadId | undefined;
  const hasThread = threadId !== undefined;
  // Nothing uncommitted and nothing ahead of its base: the Diff tab would say only that.
  const threadQuiet = useThreadsStore((s) => {
    const git = threadId === undefined ? undefined : s.byId[threadId]?.git;
    return git !== undefined && (!git.repo || (git.changedFiles === 0 && git.aheadBase === 0));
  });
  // The app in front of Gram may offer the panel on a thread in a repository alone: its git state
  // says, and until that arrives a worktree is one.
  const threadInRepo = useThreadsStore((s) => {
    const summary = threadId === undefined ? undefined : s.byId[threadId];
    return summary?.git?.repo ?? summary?.thread.checkout.kind === "worktree";
  });
  const panelBarred = !panelOffered(
    useEmbedShell((s) => s.panel),
    {
      threadInView: hasThread,
      threadInRepo,
    },
  );
  const board = useViewStore((s) => s.view === "board");
  const orchestrator = useThreadsStore(
    (s) => threadId !== undefined && s.byId[threadId]?.thread.role === "orchestrator",
  );
  // A grid of panes shares the chat's place among its threads, so it needs the room too.
  const grid = useLayoutStore((s) => s.grid.preset !== "1" && !s.grid.maximized);
  const chatBusy = board || orchestrator || grid;
  // The page on screen, not the one being loaded: a lazy route keeps the old page up until its code
  // arrives, and the shell around it changing first showed Settings' Back strip beside the thread.
  const page = useRouterState({
    select: (state) => shellPage((state.resolvedLocation ?? state.location).pathname),
  });

  // Settings is a place of its own: the overview steps aside (the title bar has Back and the
  // page's name), and its stored mode stays as it was for when Settings closes.
  const settings = page === "/settings";
  // A phone has no room beside the chat for the overview: it is the header's drawer instead.
  const phone = usePhone();
  const input = {
    windowWidth,
    threadInView: hasThread,
    threadQuiet,
    panelBarred,
    focusMode,
    sidebarWidth,
    sidebarPeek: settings || phone ? false : sidebarPeek,
    overviewSidebar: settings || phone ? "hidden" : overviewSidebar,
    panelOpen,
    panelWidth,
    panelExpanded,
    panelPeek,
    panelTab,
    chatBusy,
    reviewWidth,
    reviewFocus,
    reviewRequestsPlacement,
    openPrsPlacement,
  };
  const fit = fitShell(input);
  // The panel and sidebar as they'd be without the review's focus, which the chat keeps its width
  // under, so the transcript isn't laid out anew.
  const unfocused = fit.reviewFocus ? fitShell({ ...input, reviewFocus: false }) : fit;
  useLayoutEffect(() => {
    setShellContext({
      windowWidth,
      threadInView: hasThread,
      threadQuiet,
      panelBarred,
      page,
      chatBusy,
    });
  }, [windowWidth, hasThread, threadQuiet, panelBarred, page, chatBusy, setShellContext]);

  // The docked Inbox takes the panel's column while it is open, the panel waiting behind it as it
  // was; the chat keeps its width beside it.
  const dock = useInboxDock();
  const left = dock?.sidebarWidth ?? fit.sidebarWidth;
  // Beside a review the chat keeps more room, so the drag stops there too.
  const bounds = panelBoundsFor({ panelTab, chatBusy, windowWidth }, left);
  const shownWidth = clampWidth(
    panelWidthFor(
      { panelTab, panelWidth, reviewWidth, windowWidth, chatBusy },
      unfocused.sidebarWidth,
    ),
    panelBoundsFor({ panelTab, chatBusy, windowWidth }, unfocused.sidebarWidth),
  );
  const sidebar = dock?.sidebar ?? fit.sidebar;
  return {
    fit: dock === undefined ? fit : { ...fit, sidebar },
    focusMode,
    /** Settings is open: the title bar carries Back and its name, and no overview shows. */
    settings,
    phone,
    panelLeft,
    hasThread,
    /** The app in front of Gram offers no right panel here: neither it nor its toggle shows. */
    panelBarred,
    windowResizing,
    sidebarShown: sidebar !== "none",
    panelShown: dock === undefined && fit.panel !== "none",
    expanded: dock === undefined && fit.panel === "over",
    reviewFocus: dock === undefined && fit.reviewFocus,
    /** A review held too narrow to read beside the chat: the panel offers Focus review. */
    reviewCramped: dock === undefined && fit.reviewCramped,
    /** The docked Inbox, in the panel's column; undefined while it is closed or a dialog. */
    dock,
    left,
    right: dock?.width ?? fit.panelWidth,
    bounds,
    /** The panel's width beside the chat, outside an expanded panel or a review's focus. */
    shownWidth,
    /** The chat's width with the panel at `shownWidth`, kept while the panel takes its place. */
    chatWidth: Math.max(0, windowWidth - unfocused.sidebarWidth - shownWidth),
  };
}
