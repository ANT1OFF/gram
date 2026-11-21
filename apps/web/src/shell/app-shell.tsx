import { Outlet } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useRef, useState } from "react";

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
import { useToastDock } from "@/shell/toast-dock";
import { useShellLayout } from "@/shell/use-shell-layout";
import { useWorkspaceKeys } from "@/shell/workspace-switcher";
import {
  clampWidth,
  OVERVIEW_RAIL_WIDTH,
  reviewSized,
  SIDEBAR_WIDTH,
  useLayoutStore,
} from "@/stores/layout";
import { UpdateNotice } from "@/updates/update-notice";
import { QuietLayer, ViewOutlet } from "@/views/view-frame";
import { useViewStore } from "@/views/view-store";

const loadNavAway = () => import("@/shell/nav-away");
const DockRow = lazy(() => loadNavAway().then((m) => ({ default: m.DockRow })));
const AutoHideDock = lazy(() => loadNavAway().then((m) => ({ default: m.AutoHideDock })));
const DockSheet = lazy(() => loadNavAway().then((m) => ({ default: m.DockSheet })));
const AutoHideSidebar = lazy(() => loadNavAway().then((m) => ({ default: m.AutoHideSidebar })));

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
    nav,
    autoHidden,
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
  const atPlace = useWorkspacePlaces(false)?.some((place) => place.current) === true;
  useCarryOverviewFocus(settings ? "none" : fit.sidebar);
  useAutoReviewFocus();

  useEffect(() => {
    if (!hasThread) setPanelExpanded(false);
  }, [hasThread, setPanelExpanded]);

  useShortcut({
    id: "panel.restore",
    keys: "escape",
    label: "Restore expanded right panel or review",
    group: "App",
    focusScope: () => expanded || reviewFocus,
    run: () => (reviewFocus ? setReviewFocus(false) : setPanelExpanded(false)),
  });

  const resizePanel = (width: number) => {
    setPanelExpanded(false);
    if (reviewTab) setReviewWidth(clampWidth(width, bounds));
    else setPanelWidth(clampWidth(width, bounds));
  };
  const chatCovered = expanded || reviewFocus;
  const setToastDock = useToastDock((s) => s.setNode);
  const dock = nav.position === "side" ? undefined : nav.position;
  const navAway = dock !== undefined ? "dock" : autoHidden !== "none" ? "sidebar" : undefined;
  const sidebarWidth = useLayoutStore((s) => s.sidebarWidth);

  const grid = (
    <div
      data-testid="app-shell"
      data-nav={dock === undefined ? undefined : "dock"}
      data-nav-auto-hide={nav.autoHide && !phone ? "" : undefined}
      inert={quiet}
      data-focus-mode={focusMode}
      data-panel-side={panelLeft ? "left" : "right"}
      data-panel-expanded={expanded}
      data-review-focus={reviewFocus}
      className={cn(
        "relative grid overflow-hidden",
        dock !== undefined && !nav.autoHide ? "min-h-0 flex-1" : "h-dvh",
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
        className={cn(
          "relative isolate flex min-h-0 min-w-0 flex-col bg-thread outline-none",
          panelLeft ? "order-3" : "order-2",
        )}
        style={chatCovered ? { width: chatWidth } : undefined}
      >
        <ShellTitlebar
          sidebarShown={sidebarShown}
          navAway={navAway}
          needsYouPill={sidebarShown || settings || navAway !== undefined}
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
        {!chatCovered && (
          <div
            ref={setToastDock}
            data-testid="toast-dock"
            className="pointer-events-none absolute top-(--titlebar-height) right-3 z-30 w-80 max-w-[calc(100%-1.5rem)]"
          />
        )}
      </main>
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
  );

  return (
    <>
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
      {dock !== undefined && !nav.autoHide ? (
        <div data-testid="nav-docked" className="flex h-dvh flex-col bg-background">
          {dock === "top" && (
            <Suspense fallback={null}>
              <DockRow edge="top" inert={quiet} />
            </Suspense>
          )}
          {grid}
          {dock === "bottom" && (
            <Suspense fallback={null}>
              <DockRow edge="bottom" inert={quiet} />
            </Suspense>
          )}
        </div>
      ) : (
        grid
      )}
      {(dock !== undefined || autoHidden !== "none") && (
        <Suspense fallback={null}>
          {dock !== undefined && nav.autoHide && <AutoHideDock edge={dock} inert={quiet} />}
          {dock !== undefined && <DockSheet edge={dock} />}
          {autoHidden !== "none" && (
            <AutoHideSidebar
              compact={autoHidden === "compact"}
              width={autoHidden === "full" ? sidebarWidth : OVERVIEW_RAIL_WIDTH}
              inert={quiet}
            />
          )}
        </Suspense>
      )}
      {phone && <PhoneDrawer />}
      <QuietLayer />
      <MenuBar />
    </>
  );
}
