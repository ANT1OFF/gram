import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from "lucide-react";
import { useState } from "react";

import { InboxButton } from "@/inbox/inbox-button";
import { LaunchIssuesChip } from "@/launch-checks/banner";
import { cn } from "@/lib/utils";
import { TitlebarPause } from "@/orchestration/workspace-pause-button";
import { FakeAgentBadge } from "@/shell/fake-agent-badge";
import { ShellToggle } from "@/shell/shell-toggle";
import { TitlebarOverflow } from "@/shell/titlebar-fold";
import {
  useSoloRoute,
  useTitlebarFold,
  useTitlebarSlot,
  useTitlebarThread,
} from "@/shell/titlebar-slot";
import { SettingsTitle } from "@/shell/settings-title";
import { TopLeftNav } from "@/shell/top-left-nav";
import { UsageMeter } from "@/shell/usage-meter";
import { WorkspaceSwitcher } from "@/shell/workspace-switcher";
import { useBeforeSetup } from "@/welcome/welcome";
import { useLayoutStore } from "@/stores/layout";
import { toggleOverviewSidebar } from "@/views/shell-layout";
import { ViewSwitcher } from "@/views/view-frame";
import { useViewStore } from "@/views/view-store";

/**
 * The room before each of the bar's clusters, which groups them; a narrow bar gives it to the title.
 * By the bar's width, not its fold, so the room it frees can't unfold what it folded.
 */
const CLUSTER_GAP = "ml-3 @max-2xl/titlebar:ml-1";

/**
 * The chat column's title bar, icon-only and few: the workspace and its views, the thread's header
 * or Board's controls in the slot, then what wants your attention (a setup problem folded from its
 * banner, a paused workspace, usage, and the Inbox while no sidebar shows its pill), one "…" with
 * everything else in words, and the panel. Narrow, what the slot carries folds into "…" too. Each
 * destination has one entry here or in the sidebar, never both.
 */
export function ShellTitlebar({
  sidebarShown,
  needsYouPill,
  settings,
  compactRail,
  panelShown,
  panelLeft,
}: {
  /** The overview, open or compact, is to the bar's left. */
  sidebarShown: boolean;
  /** The overview to the bar's left shows the needs-you pill. */
  needsYouPill: boolean;
  /** Settings is open: Back and its name in place of the workspace and its views. */
  settings: boolean;
  /** The overview is the compact rail. */
  compactRail: boolean;
  /** The right panel is shown. */
  panelShown: boolean;
  /** `panel.side` puts the panel on the left. */
  panelLeft: boolean;
}) {
  const togglePanel = useLayoutStore((s) => s.togglePanel);
  const beforeSetup = useBeforeSetup();
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
        // With no sidebar (or overview) to its left, the title bar starts under macOS's window
        // buttons; beside the compact rail, narrower than them, it starts clear of them.
        !sidebarShown && "pl-[max(--spacing(2),var(--window-lights-inset))]",
        compactRail && "pl-[max(--spacing(2),calc(var(--window-lights-inset)-60px+--spacing(1)))]",
      )}
    >
      {settings ? (
        <div className="mr-auto flex min-w-0 items-center">
          <SettingsTitle />
        </div>
      ) : (
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
          {/* Settings follows the toggle, as it does in the overview's header. */}
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
      )}
      {carried && !settings && (
        <span
          aria-hidden
          data-testid="titlebar-divider"
          className="mx-1 h-4 w-px shrink-0 bg-border"
        />
      )}
      {/* Few controls, each with its words on hover: what wants your attention, then the one "…"
          with everything else, labelled, and the panel. A paused workspace says so here, and a
          click resumes it; pausing, Workers and Tidy up are the "…"'s. */}
      <div
        role="group"
        aria-label="Attention"
        data-testid="titlebar-attention"
        className="flex shrink-0 items-center gap-0.5"
      >
        {/* A setup problem seen once in its banner, folded here until dismissed. */}
        <LaunchIssuesChip className="[-webkit-app-region:no-drag]" />
        {!soloBar && !settings && <TitlebarPause className="[-webkit-app-region:no-drag]" />}
        {/* Before any setup there is no work of Gram's to meter. Narrow, the title needs the room
            more than the meter needs its words: it keeps its share ("85%"), its hover the rest. */}
        {!beforeSetup && (
          <UsageMeter
            className="[-webkit-app-region:no-drag]"
            textClassName="@max-2xl/titlebar:hidden"
            shortTextClassName="hidden @max-2xl/titlebar:inline"
          />
        )}
        {/* What needs you has one way in: the sidebar's pill, open or compact; with no pill on
            screen (the sidebar hidden, or Settings' strip in its place), this button, wearing the
            count. */}
        {/* Before setup the sidebar hides its pill (the welcome is the one thing to look at), so
            the quiet Inbox icon here is the way to what arrived meanwhile, startup notices say. */}
        {(!needsYouPill || beforeSetup) && <InboxButton />}
      </div>
      <div
        role="group"
        aria-label="View"
        data-testid="titlebar-view"
        className={cn("flex shrink-0 items-center gap-0.5", CLUSTER_GAP)}
      >
        {/* The thread's menu, the workspace's controls and the window's, and what a narrow bar
            folds: a worker's own actions and Board's layout. */}
        <TitlebarOverflow orchestration={!soloBar} className="[-webkit-app-region:no-drag]" />
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
    </div>
  );
}
