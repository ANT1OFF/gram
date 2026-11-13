import { Outlet } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { useAutoReviewFocus } from "@/components/review-room";
import { RightPanel, useShowPanelRequests } from "@/components/right-panel";
import { MenuBar } from "@/desktop/menu-bar";
import { useShortcut } from "@/keyboard/registry";
import { LaunchChecksBanner } from "@/launch-checks/banner";
import { cn } from "@/lib/utils";
import { useMotionLevel } from "@/motion";
import { OverviewRail } from "@/orchestration/overview-rail";
import { OverviewSidebar, useCarryOverviewFocus } from "@/orchestration/overview-sidebar";
import { ConnectionBanner } from "@/shell/connection-banner";
import { PhoneDrawer } from "@/shell/phone-drawer";
import { PhonePanelRow, PhoneWorkspaceRow } from "@/shell/phone-panels";
import { useWorkspacePlaces } from "@/shell/titlebar-path";
import { ReviewStrip } from "@/shell/review-strip";
import { ShellTitlebar } from "@/shell/shell-titlebar";
import { SideResizeHandle } from "@/shell/side-resize";
import { useShellLayout } from "@/shell/use-shell-layout";
import { useWorkspaceKeys } from "@/shell/workspace-switcher";
import { clampWidth, reviewSized, SIDEBAR_WIDTH, useLayoutStore } from "@/stores/layout";
import { UpdateNotice } from "@/updates/update-notice";
import { QuietLayer, ViewOutlet } from "@/views/view-frame";
import { useViewStore } from "@/views/view-store";

/**
 * Overview, chat or grid, right panel; either side hides and focus mode hides both. An expanded
 * panel takes the chat's column too.
 */
export function AppShell() {
  useShowPanelRequests();
  const setSidebarWidth = useLayoutStore((s) => s.setSidebarWidth);
  const setPanelWidth = useLayoutStore((s) => s.setPanelWidth);
  const setPanelExpanded = useLayoutStore((s) => s.setPanelExpanded);
  const setReviewWidth = useLayoutStore((s) => s.setReviewWidth);
  const setReviewFocus = useLayoutStore((s) => s.setReviewFocus);
  const reviewTab = useLayoutStore(reviewSized);
  const level = useMotionLevel();
  const [resizing, setResizing] = useState(false);
  const content = useRef<HTMLElement>(null);
  const quiet = useViewStore((s) => s.quiet);
  const board = useViewStore((s) => s.view === "board");
  const {
    fit,
    focusMode,
    settings,
    phone,
    panelLeft,
    hasThread,
    panelBarred,
    windowResizing,
    sidebarShown,
    panelShown,
    expanded,
    reviewFocus,
    left,
    right,
    bounds,
    chatWidth,
  } = useShellLayout();
  useWorkspaceKeys();
  // On a phone, a workspace's place (its orchestrator, Board, Memory) has the row of the three.
  const atPlace = useWorkspacePlaces(false)?.some((place) => place.current) === true;
  // Settings has no overview: entering or leaving it swaps nothing to carry.
  useCarryOverviewFocus(settings ? "none" : fit.sidebar);
  // A review that runs too narrow to read beside the conversation takes the window on its own.
  useAutoReviewFocus();

  // Settings, a new task and the board live in the chat's place, so going there brings it back.
  useEffect(() => {
    if (!hasThread) setPanelExpanded(false);
  }, [hasThread, setPanelExpanded]);

  useShortcut({
    id: "panel.restore",
    keys: "escape",
    label: "Restore expanded right panel or review",
    group: "App",
    // Ahead of Escape's unscoped uses, which belong to the chat hidden behind the panel.
    focusScope: () => expanded || reviewFocus,
    run: () => (reviewFocus ? setReviewFocus(false) : setPanelExpanded(false)),
  });

  // The Diff and PR tabs keep a width of their own, so a review dragged wide leaves the others be.
  const resizePanel = (width: number) => {
    setPanelExpanded(false);
    if (reviewTab) setReviewWidth(clampWidth(width, bounds));
    else setPanelWidth(clampWidth(width, bounds));
  };
  const chatCovered = expanded || reviewFocus;

  // The panel's column moves with `panel.side`; CSS `order` keeps the DOM, so nothing remounts.
  // Expanding keeps the template's shape so the column widths animate: the chat's track shrinks to
  // nothing while the chat keeps its width under the panel, so the transcript isn't laid out anew.
  return (
    <>
      {/* The keyboard's first stop: past the sidebar to the page. Seen only while it has focus. */}
      <a
        href="#content"
        data-testid="skip-to-content"
        className="fixed top-2 left-2 z-50 -translate-y-16 rounded-lg border border-edge bg-background px-3 py-2 text-body text-foreground shadow-overlay outline-none focus:translate-y-0 focus-visible:focus-ring"
        onClick={(event) => {
          event.preventDefault();
          content.current?.focus();
        }}
      >
        Skip to content
      </a>
      <div
        data-testid="app-shell"
        inert={quiet}
        data-focus-mode={focusMode}
        data-panel-side={panelLeft ? "left" : "right"}
        data-panel-expanded={expanded}
        data-review-focus={reviewFocus}
        className={cn(
          "relative grid h-dvh overflow-hidden",
          level === "full" &&
            !resizing &&
            !windowResizing &&
            "transition-[grid-template-columns] duration-(--dur-fast) ease-out",
        )}
        style={{
          gridTemplateColumns: panelLeft
            ? `${left}px ${right}px minmax(0,1fr)`
            : `${left}px minmax(0,1fr) ${right}px`,
        }}
      >
        <div className="group/side relative order-1 flex min-h-0 min-w-0 flex-col overflow-hidden">
          {sidebarShown && (fit.sidebar !== "compact" ? <OverviewSidebar /> : <OverviewRail />)}
          {fit.sidebar === "full" && (
            <SideResizeHandle
              side="left"
              label="Resize overview"
              width={left}
              bounds={SIDEBAR_WIDTH}
              onResize={setSidebarWidth}
              onActive={setResizing}
            />
          )}
        </div>
        <main
          id="content"
          ref={content}
          tabIndex={-1}
          inert={chatCovered}
          // Its own stacking context, so nothing layered inside the chat rises over the panel above it.
          className={cn(
            "isolate flex min-h-0 min-w-0 flex-col bg-thread outline-none",
            panelLeft ? "order-3" : "order-2",
          )}
          style={chatCovered ? { width: chatWidth } : undefined}
        >
          <ShellTitlebar
            sidebarShown={sidebarShown}
            // Settings' sections carry the pill where the overview does.
            needsYouPill={sidebarShown || settings}
            settings={settings}
            compactRail={fit.sidebar === "compact"}
            panelShown={panelShown}
            panelOffered={!panelBarred}
            panelLeft={panelLeft}
          />
          {phone && !panelShown && <PhoneWorkspaceRow />}
          {phone && hasThread && !panelBarred && !panelShown && !board && !atPlace && (
            <PhonePanelRow />
          )}
          <ConnectionBanner />
          <UpdateNotice />
          <LaunchChecksBanner />
          <ViewOutlet>
            <Outlet />
          </ViewOutlet>
        </main>
        {/* Over the inert chat, not in it, so its way back can be clicked. */}
        {reviewFocus && <ReviewStrip side={panelLeft ? "right" : "left"} />}
        <div
          className={cn(
            "group/side relative z-10 flex min-h-0 min-w-0 flex-col overflow-hidden",
            panelLeft ? "order-2" : "order-3",
          )}
        >
          {panelShown && (
            <>
              <RightPanel />
              <SideResizeHandle
                side={panelLeft ? "left" : "right"}
                label="Resize right panel"
                width={right}
                bounds={bounds}
                onResize={resizePanel}
                onActive={setResizing}
                onDoubleClick={() => setPanelExpanded(!expanded)}
                hint={`Drag to resize, double-click to ${expanded ? "restore" : "expand"}`}
              />
            </>
          )}
        </div>
      </div>
      {phone && <PhoneDrawer />}
      <QuietLayer />
      <MenuBar />
    </>
  );
}
