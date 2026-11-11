import { Outlet } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { useAutoReviewFocus } from "@/components/review-room";
import { RightPanel, useShowPanelRequests } from "@/components/right-panel";
import { MenuBar } from "@/desktop/menu-bar";
import { InboxDock } from "@/inbox/inbox-view";
import { useInboxStore } from "@/inbox/inbox-store";
import { useShortcut } from "@/keyboard/registry";
import { LaunchChecksBanner } from "@/launch-checks/banner";
import { cn } from "@/lib/utils";
import { useMotionLevel } from "@/motion";
import { OverviewRail } from "@/orchestration/overview-rail";
import { HostedRail } from "@/embed/hosted-rail";
import { useEmbedShell } from "@/embed/store";
import { OverviewSidebar, useCarryOverviewFocus } from "@/orchestration/overview-sidebar";
import { ConnectionBanner } from "@/shell/connection-banner";
import { PhoneDrawer } from "@/shell/phone-drawer";
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
  const quiet = useViewStore((s) => s.quiet);
  const {
    fit,
    focusMode,
    settings,
    phone,
    panelLeft,
    hasThread,
    windowResizing,
    sidebarShown,
    panelShown,
    expanded,
    reviewFocus,
    left,
    right,
    bounds,
    chatWidth,
    dock,
  } = useShellLayout();
  useWorkspaceKeys();
  // Settings has no overview: entering or leaving it swaps nothing to carry.
  useCarryOverviewFocus(settings ? "none" : fit.sidebar);
  // Mounted by an app in front of Gram: its compact sidebar is the quiet strip that opens on hover.
  const hostedRail = useEmbedShell((s) => s.hosted);
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
      <div
        data-testid="app-shell"
        inert={quiet}
        data-focus-mode={focusMode}
        data-panel-side={panelLeft ? "left" : "right"}
        data-panel-expanded={expanded}
        data-review-focus={reviewFocus}
        data-inbox-docked={dock !== undefined}
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
          {sidebarShown &&
            (fit.sidebar !== "compact" ? (
              <OverviewSidebar />
            ) : hostedRail ? (
              <HostedRail />
            ) : (
              <OverviewRail />
            ))}
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
          inert={chatCovered}
          // Its own stacking context, so nothing layered inside the chat rises over the panel above it.
          className={cn(
            "isolate flex min-h-0 min-w-0 flex-col bg-thread",
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
            panelLeft={panelLeft}
          />
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
          {dock !== undefined && (
            <>
              <InboxDock />
              <SideResizeHandle
                side={panelLeft ? "left" : "right"}
                label="Resize Inbox"
                width={right}
                bounds={dock.bounds}
                onResize={(width) =>
                  useInboxStore.getState().setWidth(clampWidth(width, dock.bounds))
                }
                onActive={setResizing}
              />
            </>
          )}
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
