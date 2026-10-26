import {
  Focus,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";
import { useState } from "react";

import { isMac } from "@/keyboard/registry";
import { cn } from "@/lib/utils";
import { TitlebarTidyUp } from "@/orchestration/tidy-up-button";
import { WorkersButton } from "@/orchestration/workers-list";
import { TitlebarPause } from "@/orchestration/workspace-pause-button";
import { NotificationsBell } from "@/panels/notifications-panel";
import { FakeAgentBadge } from "@/shell/fake-agent-badge";
import { LayoutPicker } from "@/shell/layout-picker";
import { ShellToggle } from "@/shell/shell-toggle";
import { Foldable, TitlebarOverflow } from "@/shell/titlebar-fold";
import {
  useSoloRoute,
  useTitlebarFold,
  useTitlebarSlot,
  useTitlebarThread,
} from "@/shell/titlebar-slot";
import { TopLeftNav } from "@/shell/top-left-nav";
import { UsageMeter } from "@/shell/usage-meter";
import { WorkspaceSwitcher } from "@/shell/workspace-switcher";
import { useLayoutStore } from "@/stores/layout";
import { toggleOverviewSidebar } from "@/views/shell-layout";
import { QuietToggle, ViewSwitcher } from "@/views/view-frame";
import { useViewStore } from "@/views/view-store";

/**
 * The chat column's title bar: the workspace and its views, the thread's header or Board's
 * controls in the slot, then the workspace's controls and the shell's toggles. Narrow, the lesser
 * buttons fold into "…".
 */
export function ShellTitlebar({
  sidebarShown,
  compactRail,
  panelShown,
  panelLeft,
}: {
  /** The overview, open or compact, is to the bar's left. */
  sidebarShown: boolean;
  /** The overview is the compact rail. */
  compactRail: boolean;
  /** The right panel is shown. */
  panelShown: boolean;
  /** `panel.side` puts the panel on the left. */
  panelLeft: boolean;
}) {
  const focusMode = useLayoutStore((s) => s.focusMode);
  const togglePanel = useLayoutStore((s) => s.togglePanel);
  const toggleFocusMode = useLayoutStore((s) => s.toggleFocusMode);
  // One bar: a thread alone in Chat puts its header here, and Board its controls.
  const barThread = useTitlebarThread() !== undefined;
  const board = useViewStore((s) => s.view === "board");
  const carried = barThread || board;
  // A solo thread's bar leaves out what acts on the workspace's orchestration.
  const soloRoute = useSoloRoute();
  const soloBar = barThread && soloRoute;
  const setTitlebarSlot = useTitlebarSlot((s) => s.setSlot);
  const fold = useTitlebarSlot((s) => s.fold);
  // Folded at all: the lesser buttons are in "…".
  const folded = fold > 0;
  const [titlebar, setTitlebar] = useState<HTMLDivElement | null>(null);
  useTitlebarFold(titlebar);

  // With no panel to its right, the chat's titlebar runs under Windows' window controls.
  const titlebarAtEdge = panelLeft || !panelShown;
  // With no sidebar (or overview) to its left, the title bar starts under macOS's window buttons.
  const titlebarUnderLights = !sidebarShown && isMac() && window.gram !== undefined;
  // Beside the compact rail, narrower than macOS's window buttons, it starts clear of them.
  const titlebarBesideRail = compactRail && isMac() && window.gram !== undefined;

  return (
    <div
      ref={setTitlebar}
      data-surface="titlebar"
      data-testid="shell-titlebar"
      data-solo-thread={soloBar || undefined}
      data-carries={barThread ? "thread" : board ? "board" : undefined}
      data-folded={folded || undefined}
      data-fold={fold || undefined}
      className={cn(
        "@container/titlebar relative flex h-(--titlebar-height) shrink-0 items-center justify-end gap-1 border-b border-border px-2 [-webkit-app-region:drag]",
        titlebarAtEdge && "pr-[calc(var(--window-controls-inset)+--spacing(2))]",
        titlebarUnderLights && "pl-20",
        titlebarBesideRail && "pl-6",
      )}
    >
      <div className={cn("mr-auto flex min-w-0 items-center gap-1", carried && "flex-1")}>
        {/* Hidden, the overview comes back from here as from ⌘B; shown, its own button hides it. */}
        {!sidebarShown && (
          <ShellToggle
            icon={PanelLeftOpen}
            label="Show sidebar"
            shortcutId="sidebar.toggle"
            testId="overview-show"
            onClick={toggleOverviewSidebar}
          />
        )}
        {/* Usage and Settings follow the toggle, as they do in the overview's header. */}
        {!sidebarShown && <TopLeftNav className="mr-2" />}
        <WorkspaceSwitcher
          className={cn(
            "shrink-0 [-webkit-app-region:no-drag]",
            carried && "@max-2xl/titlebar:max-w-28",
            folded && "max-w-20",
          )}
        />
        {/* Chat · Board are the workspace's views: a solo thread in Chat is no part of it. */}
        {!soloBar && (
          <>
            <ViewSwitcher className="shrink-0 [-webkit-app-region:no-drag]" />
            <FakeAgentBadge className="[-webkit-app-region:no-drag]" />
          </>
        )}
        {/* The thread's header or Board's controls, title first: it truncates before
            anything else gives way. */}
        <div
          ref={setTitlebarSlot}
          data-testid="titlebar-slot"
          className={cn("flex min-w-0 self-stretch", carried && "flex-1")}
        />
      </div>
      {carried && (
        <span
          aria-hidden
          data-testid="titlebar-divider"
          className="mx-1 h-4 w-px shrink-0 bg-border"
        />
      )}
      {/* The workspace's workers, tidy-up and pause are Board's and the orchestrator's: a
          solo thread is none of their work, and ⌘J, the palette and Board still reach them. */}
      {!soloBar && (
        <>
          {/* Workers is one of the bar's main controls: it folds last. */}
          <Foldable level={2} gap={4}>
            <WorkersButton className="[-webkit-app-region:no-drag]" />
          </Foldable>
          <Foldable level={1} gap={4}>
            <TitlebarTidyUp className="[-webkit-app-region:no-drag]" />
          </Foldable>
          <TitlebarPause className="[-webkit-app-region:no-drag]" />
        </>
      )}
      {/* Narrow, the title needs the room more than the meter needs its words. */}
      <UsageMeter
        className="mr-1 [-webkit-app-region:no-drag]"
        textClassName="@max-2xl/titlebar:hidden"
      />
      <NotificationsBell />
      {/* Narrow, these and Tidy up, then Workers, are in "…": the thread's menu, or the bar's
          own without one. */}
      {folded && !barThread && (
        <TitlebarOverflow orchestration={!soloBar} className="[-webkit-app-region:no-drag]" />
      )}
      <Foldable level={1} gap={4} className="gap-1">
        <QuietToggle className="[-webkit-app-region:no-drag]" />
        <LayoutPicker className="[-webkit-app-region:no-drag]" />
        <ShellToggle
          icon={Focus}
          label={focusMode ? "Leave focus mode" : "Focus mode"}
          shortcutId="focus.toggle"
          pressed={focusMode}
          onClick={toggleFocusMode}
        />
      </Foldable>
      <ShellToggle
        icon={
          panelShown
            ? panelLeft
              ? PanelLeftClose
              : PanelRightClose
            : panelLeft
              ? PanelLeftOpen
              : PanelRightOpen
        }
        label={panelShown ? "Hide right panel" : "Show right panel"}
        shortcutId="panel.toggle"
        pressed={panelShown}
        onClick={togglePanel}
      />
    </div>
  );
}
