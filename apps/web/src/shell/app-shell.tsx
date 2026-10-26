import { Outlet } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { RightPanel, useShowPanelRequests } from "@/components/right-panel";
import { MenuBar } from "@/desktop/menu-bar";
import { useShortcut } from "@/keyboard/registry";
import { LaunchChecksBanner } from "@/launch-checks/banner";
import { cn } from "@/lib/utils";
import { useMotionLevel } from "@/motion";
import { OverviewRail } from "@/orchestration/overview-rail";
import { OverviewSidebar, useCarryOverviewFocus } from "@/orchestration/overview-sidebar";
import { ConnectionBanner } from "@/shell/connection-banner";
import { ShellTitlebar } from "@/shell/shell-titlebar";
import { SideResizeHandle } from "@/shell/side-resize";
import { useShellLayout } from "@/shell/use-shell-layout";
import { useWorkspaceKeys } from "@/shell/workspace-switcher";
import { clampWidth, SIDEBAR_WIDTH, useLayoutStore } from "@/stores/layout";
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
  const level = useMotionLevel();
  const [resizing, setResizing] = useState(false);
  const quiet = useViewStore((s) => s.quiet);
  const {
    fit,
    focusMode,
    panelLeft,
    hasThread,
    windowResizing,
    sidebarShown,
    panelShown,
    expanded,
    left,
    right,
    bounds,
    shownWidth,
    beside,
  } = useShellLayout();
  useWorkspaceKeys();
  useCarryOverviewFocus(fit.sidebar);

  // Settings, a new task and the board live in the chat's place, so going there brings it back.
  useEffect(() => {
    if (!hasThread) setPanelExpanded(false);
  }, [hasThread, setPanelExpanded]);

  useShortcut({
    id: "panel.restore",
    keys: "escape",
    label: "Restore expanded right panel",
    group: "App",
    // Ahead of Escape's unscoped uses, which belong to the chat hidden behind the panel.
    focusScope: () => expanded,
    run: () => setPanelExpanded(false),
  });

  const resizePanel = (width: number) => {
    setPanelExpanded(false);
    setPanelWidth(clampWidth(width, bounds));
  };

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
        className={cn(
          "grid h-dvh overflow-hidden",
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
        <div className="relative order-1 flex min-h-0 min-w-0 flex-col overflow-hidden">
          {sidebarShown && (fit.sidebar === "compact" ? <OverviewRail /> : <OverviewSidebar />)}
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
          inert={expanded}
          // Its own stacking context, so nothing layered inside the chat rises over the panel above it.
          className={cn(
            "isolate flex min-h-0 min-w-0 flex-col bg-thread",
            panelLeft ? "order-3" : "order-2",
          )}
          style={expanded ? { width: Math.max(0, beside - shownWidth) } : undefined}
        >
          <ShellTitlebar
            sidebarShown={sidebarShown}
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
        <div
          className={cn(
            "relative z-10 flex min-h-0 min-w-0 flex-col overflow-hidden",
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
      <QuietLayer />
      <MenuBar />
    </>
  );
}
