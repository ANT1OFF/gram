import type { ThreadId } from "@gram/contracts";
import { useLocation, useParams } from "@tanstack/react-router";
import { useLayoutEffect } from "react";

import { useServerSettings } from "@/settings-sync/store";
import { useWindowWidth } from "@/shell/side-resize";
import {
  clampWidth,
  fitShell,
  panelBounds,
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
  const board = useViewStore((s) => s.view === "board");
  const orchestrator = useThreadsStore(
    (s) => threadId !== undefined && s.byId[threadId]?.thread.role === "orchestrator",
  );
  // A grid of panes shares the chat's place among its threads, so it needs the room too.
  const grid = useLayoutStore((s) => s.grid.preset !== "1" && !s.grid.maximized);
  const chatBusy = board || orchestrator || grid;
  const page = useLocation({
    select: (location) => shellPage(location.pathname),
  });

  const input = {
    windowWidth,
    threadInView: hasThread,
    threadQuiet,
    focusMode,
    sidebarWidth,
    sidebarPeek,
    overviewSidebar,
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
    setShellContext({ windowWidth, threadInView: hasThread, threadQuiet, page, chatBusy });
  }, [windowWidth, hasThread, threadQuiet, page, chatBusy, setShellContext]);

  const left = fit.sidebarWidth;
  const bounds = panelBounds(windowWidth, left);
  const shownWidth = clampWidth(
    panelWidthFor(
      { panelTab, panelWidth, reviewWidth, windowWidth, chatBusy },
      unfocused.sidebarWidth,
    ),
    panelBounds(windowWidth, unfocused.sidebarWidth),
  );
  return {
    fit,
    focusMode,
    panelLeft,
    hasThread,
    windowResizing,
    sidebarShown: fit.sidebar !== "none",
    panelShown: fit.panel !== "none",
    expanded: fit.panel === "over",
    reviewFocus: fit.reviewFocus,
    left,
    right: fit.panelWidth,
    bounds,
    /** The panel's width beside the chat, outside an expanded panel or a review's focus. */
    shownWidth,
    /** The chat's width with the panel at `shownWidth`, kept while the panel takes its place. */
    chatWidth: Math.max(0, windowWidth - unfocused.sidebarWidth - shownWidth),
  };
}
