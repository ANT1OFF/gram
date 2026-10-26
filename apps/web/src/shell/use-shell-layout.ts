import { useLocation, useParams } from "@tanstack/react-router";
import { useLayoutEffect } from "react";

import { useServerSettings } from "@/settings-sync/store";
import { useWindowWidth } from "@/shell/side-resize";
import { clampWidth, fitShell, panelBounds, shellPage, useLayoutStore } from "@/stores/layout";

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
  const hasThread = useParams({ strict: false }).threadId !== undefined;
  const page = useLocation({
    select: (location) => shellPage(location.pathname),
  });

  const fit = fitShell({
    windowWidth,
    threadInView: hasThread,
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
    setShellContext({ windowWidth, threadInView: hasThread, page });
  }, [windowWidth, hasThread, page, setShellContext]);

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
