import type { ThreadId } from "@gram/contracts";
import { useLocation, useParams } from "@tanstack/react-router";
import { useLayoutEffect } from "react";

import { useServerSettings } from "@/settings-sync/store";
import { useWindowWidth } from "@/shell/side-resize";
import { clampWidth, fitShell, panelBounds, shellPage, useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";

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
  const page = useLocation({
    select: (location) => shellPage(location.pathname),
  });

  const fit = fitShell({
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
    reviewRequestsPlacement,
    openPrsPlacement,
  });
  useLayoutEffect(() => {
    setShellContext({ windowWidth, threadInView: hasThread, threadQuiet, page });
  }, [windowWidth, hasThread, threadQuiet, page, setShellContext]);

  const left = fit.sidebarWidth;
  const bounds = panelBounds(windowWidth, left);
  return {
    fit,
    focusMode,
    panelLeft,
    hasThread,
    windowResizing,
    sidebarShown: fit.sidebar !== "none",
    panelShown: fit.panel !== "none",
    expanded: fit.panel === "over",
    left,
    right: fit.panelWidth,
    bounds,
    shownWidth: clampWidth(panelWidth, bounds),
    beside: Math.max(0, windowWidth - left),
  };
}
