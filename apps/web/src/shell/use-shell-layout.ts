import type { ThreadId } from "@gram/contracts";
import { useParams, useRouterState } from "@tanstack/react-router";
import { useLayoutEffect } from "react";

import { useWindowLights } from "@/desktop/window-lights";
import { panelOffered, useEmbedShell } from "@/embed/store";
import { usePhone } from "@/lib/use-phone";
import { useServerSettings } from "@/settings-sync/store";
import { useWindowWidth } from "@/shell/side-resize";
import {
  chatBarStart,
  clampWidth,
  fitShell,
  panelBoundsFor,
  panelWidthFor,
  shellPage,
  useLayoutStore,
} from "@/stores/layout";
import { useNavigationLayout } from "@/stores/navigation";
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
  const lightsInset = useWindowLights((s) => s.inset);
  const threadId = useParams({ strict: false }).threadId as ThreadId | undefined;
  const hasThread = threadId !== undefined;
  const threadQuiet = useThreadsStore((s) => {
    const git = threadId === undefined ? undefined : s.byId[threadId]?.git;
    return git !== undefined && (!git.repo || (git.changedFiles === 0 && git.aheadBase === 0));
  });
  const threadInRepo = useThreadsStore((s) => {
    const summary = threadId === undefined ? undefined : s.byId[threadId];
    return summary?.git?.repo ?? summary?.thread.checkout.kind === "worktree";
  });
  const orchestrator = useThreadsStore(
    (s) => threadId !== undefined && s.byId[threadId]?.thread.role === "orchestrator",
  );
  const panelBarred = !panelOffered(
    useEmbedShell((s) => s.panel),
    {
      threadInView: hasThread,
      threadInRepo,
      orchestrator,
    },
  );
  const board = useViewStore((s) => s.view === "board");
  const grid = useLayoutStore((s) => s.grid.preset !== "1" && !s.grid.maximized);
  const chatBusy = board || orchestrator || grid;
  const page = useRouterState({
    select: (state) => shellPage((state.resolvedLocation ?? state.location).pathname),
  });

  const settings = page === "/settings";
  const phone = usePhone();
  const nav = useNavigationLayout(phone);
  const navAway = nav.position !== "side" || nav.autoHide;
  const input = {
    windowWidth,
    threadInView: hasThread,
    threadQuiet,
    panelBarred,
    focusMode,
    sidebarWidth,
    sidebarPeek: settings || phone || navAway ? false : sidebarPeek,
    overviewSidebar: settings || phone || navAway ? "hidden" : overviewSidebar,
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
    lightsInset,
  };
  const fit = fitShell(input);
  const unfocused = fit.reviewFocus ? fitShell({ ...input, reviewFocus: false }) : fit;
  useLayoutEffect(() => {
    setShellContext({
      windowWidth,
      threadInView: hasThread,
      threadQuiet,
      panelBarred,
      page,
      chatBusy,
      lightsInset,
    });
  }, [
    windowWidth,
    hasThread,
    threadQuiet,
    panelBarred,
    page,
    chatBusy,
    lightsInset,
    setShellContext,
  ]);

  const left = fit.sidebarWidth;
  const chatStart = (sidebar: number) => chatBarStart(sidebar, lightsInset);
  const bounds = panelBoundsFor({ panelTab, chatBusy, windowWidth }, chatStart(left));
  const shownWidth = clampWidth(
    panelWidthFor(
      { panelTab, panelWidth, reviewWidth, windowWidth, chatBusy },
      unfocused.sidebarWidth,
    ),
    panelBoundsFor({ panelTab, chatBusy, windowWidth }, chatStart(unfocused.sidebarWidth)),
  );
  return {
    fit,
    /** Where the main navigation sits, and whether it hides when not in use. */
    nav,
    /** The auto-hidden sidebar's form, out of view at the window's left until it is wanted. */
    autoHidden: (settings || nav.position !== "side" || !nav.autoHide
      ? "none"
      : overviewSidebar === "compact"
        ? "compact"
        : "full") as "none" | "compact" | "full",
    focusMode,
    /** Settings is open: the title bar carries Back and its name, and no overview shows. */
    settings,
    phone,
    panelLeft,
    hasThread,
    /** The app in front of Gram offers no right panel here: neither it nor its toggle shows. */
    panelBarred,
    windowResizing,
    sidebarShown: fit.sidebar !== "none",
    panelShown: fit.panel !== "none",
    expanded: fit.panel === "over",
    reviewFocus: fit.reviewFocus,
    /** A review held too narrow to read beside the chat: the panel offers Focus review. */
    reviewCramped: fit.reviewCramped,
    left,
    right: fit.panelWidth,
    bounds,
    /** The panel's width beside the chat, outside an expanded panel or a review's focus. */
    shownWidth,
    /** The chat's width with the panel at `shownWidth`, kept while the panel takes its place. */
    chatWidth: Math.max(0, windowWidth - unfocused.sidebarWidth - shownWidth),
  };
}
