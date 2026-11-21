import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from "lucide-react";
import { useState } from "react";

import { InboxButton } from "@/inbox/inbox-button";
import { LaunchIssuesChip } from "@/launch-checks/banner";
import { TitlebarOpenBeside } from "@/orchestration/worker-header";
import { usePhone } from "@/lib/use-phone";
import { cn } from "@/lib/utils";
import { TitlebarPause } from "@/orchestration/workspace-pause-button";
import { FakeAgentBadge } from "@/shell/fake-agent-badge";
import { Foldable } from "@/shell/foldable";
import { PhoneMenuButton } from "@/shell/phone-drawer";
import { ROUND } from "@/shell/phone-button-style";
import { useHostAttention } from "@/embed/attention";
import { useEmbedShell, useGramSettingKept, useHostPage, useRoomySidebar } from "@/embed/store";
import { PhoneTitle } from "@/shell/phone-title";
import { ShellToggle } from "@/shell/shell-toggle";
import { TitlebarOverflow } from "@/shell/titlebar-fold";
import {
  FOLD_ALL,
  FOLD_ICONS,
  useRouteAgent,
  useSoloRoute,
  useTitlebarFold,
  useTitlebarSlot,
  useTitlebarThread,
} from "@/shell/titlebar-slot";
import { SettingsTitle } from "@/shell/settings-title";
import { EmbedPageTitle, EmbedSwitcher, useEmbedPageTitle } from "@/embed/slots";
import { TitlebarPath, TitlebarPathViews, usePathBar } from "@/shell/titlebar-path";
import { TopLeftNav } from "@/shell/top-left-nav";
import { UsageMeter } from "@/shell/usage-meter";
import { WorkspaceSwitcher } from "@/shell/workspace-switcher";
import { useBeforeSetup } from "@/welcome/welcome-state";
import { useLayoutStore } from "@/stores/layout";
import { toggleOverviewSidebar } from "@/views/shell-layout";
import { ViewSwitcher } from "@/views/view-frame";
import { useViewStore } from "@/views/view-store";

const CLUSTER_GAP = "ml-3 @max-2xl/titlebar:ml-1";

/**
 * The chat column's title bar, icon-only and few: the workspace and its views, the thread's header
 * or Board's controls in the slot, then what wants your attention (the Inbox while no column to
 * the left shows the needs-you pill, a setup problem folded from its banner, a paused workspace,
 * and the thread's agent's usage), one "…" with
 * everything else in words, and the panel. Narrow, what the slot carries folds into "…" too, then
 * the icons that have an item there (Conversation only, usage), and last Chat · Board and Settings,
 * so nothing runs over anything at the chat's narrowest. Each destination has one entry here or in
 * the sidebar, never both.
 */
export function ShellTitlebar({
  sidebarShown,
  navAway,
  needsYouPill,
  settings,
  compactRail,
  panelShown,
  panelOffered,
  panelLeft,
}: {
  /** The overview, open or compact, is to the bar's left. */
  sidebarShown: boolean;
  /**
   * The main navigation is a dock, or a sidebar that hides when not in use: no Show sidebar or
   * Settings here, which it carries itself. The hidden sidebar carries the app's switcher too.
   */
  navAway?: "dock" | "sidebar" | undefined;
  /** The column to the bar's left (the overview, or Settings' sections) shows the needs-you pill. */
  needsYouPill: boolean;
  /** Settings is open: Back and its name in place of the workspace and its views. */
  settings: boolean;
  /** The overview is the compact rail. */
  compactRail: boolean;
  /** The right panel is shown. */
  panelShown: boolean;
  /** The app in front of Gram offers the right panel on this page: its toggle shows. */
  panelOffered: boolean;
  /** `panel.side` puts the panel on the left. */
  panelLeft: boolean;
}) {
  const switcherInTitlebar = useEmbedShell((s) => s.sidebar.switcher === "titlebar");
  const togglePanel = useLayoutStore((s) => s.togglePanel);
  const beforeSetup = useBeforeSetup();
  const barThreadId = useTitlebarThread();
  const barThread = barThreadId !== undefined;
  const board = useViewStore((s) => s.view === "board");
  const carried = barThread || board;
  const soloRoute = useSoloRoute();
  const soloBar = barThread && soloRoute;
  const agent = useRouteAgent();
  const setTitlebarSlot = useTitlebarSlot((s) => s.setSlot);
  const fold = useTitlebarSlot((s) => s.fold);
  const folded = fold > 0;
  const [titlebar, setTitlebar] = useState<HTMLDivElement | null>(null);
  useTitlebarFold(titlebar);

  const titlebarAtEdge = panelLeft || !panelShown;
  const phone = usePhone();
  const embedTitle = useEmbedPageTitle();
  const roomy = useRoomySidebar();
  const host = useHostAttention();
  const pathBar = usePathBar();
  const usageKept = useGramSettingKept("usage");
  const hostSettings = useEmbedShell(
    (s) => s.settings.gram !== undefined || (s.settings.pages?.length ?? 0) > 0,
  );
  const hostPage = useHostPage() || (settings && hostSettings);

  if (phone && roomy) {
    return (
      <div
        ref={setTitlebar}
        data-surface="titlebar"
        data-testid="shell-titlebar"
        data-phone=""
        data-look="roomy"
        data-solo-thread={soloBar || undefined}
        data-carries={barThread ? "thread" : board ? "board" : undefined}
        data-folded={folded || undefined}
        data-fold={fold || undefined}
        className="relative flex h-17 shrink-0 items-center gap-2 bg-transparent! px-3 [backdrop-filter:none]!"
      >
        {settings ? (
          <div className="flex min-w-0 flex-1 items-center [&_button]:size-11">
            <SettingsTitle />
          </div>
        ) : (
          <>
            <PhoneMenuButton />
            <PhoneTitle centred />
          </>
        )}
        <div ref={setTitlebarSlot} data-testid="titlebar-slot" hidden />
        {host === undefined && (
          <div
            role="group"
            aria-label="Attention"
            data-testid="titlebar-attention"
            className="flex shrink-0 items-center [&_[data-testid=inbox-button-dot]]:top-2.5 [&_[data-testid=inbox-button-dot]]:right-2.5 [&_button]:size-11"
          >
            <InboxButton />
          </div>
        )}
        <TitlebarOverflow orchestration={!soloBar} hostPage={hostPage} className={ROUND} />
      </div>
    );
  }

  if (phone) {
    return (
      <div
        ref={setTitlebar}
        data-surface="titlebar"
        data-testid="shell-titlebar"
        data-phone=""
        data-solo-thread={soloBar || undefined}
        data-carries={barThread ? "thread" : board ? "board" : undefined}
        data-folded={folded || undefined}
        data-fold={fold || undefined}
        className="relative flex h-14 shrink-0 items-center gap-1 border-b border-border px-1"
      >
        {settings ? (
          <div className="flex min-w-0 flex-1 items-center [&_button]:size-11">
            <SettingsTitle />
          </div>
        ) : (
          <>
            <PhoneMenuButton />
            <PhoneTitle className="pl-1" />
          </>
        )}
        <div ref={setTitlebarSlot} data-testid="titlebar-slot" hidden />
        <div
          role="group"
          aria-label="Attention"
          data-testid="titlebar-attention"
          className="flex shrink-0 items-center [&_[data-testid=inbox-button-dot]]:top-2.5 [&_[data-testid=inbox-button-dot]]:right-2.5 [&_button]:size-11"
        >
          <InboxButton />
        </div>
        <TitlebarOverflow
          orchestration={!soloBar}
          hostPage={hostPage}
          className="size-11 shrink-0"
        />
      </div>
    );
  }

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
          {!sidebarShown && navAway === undefined && (
            <ShellToggle
              icon={PanelLeftOpen}
              label="Show sidebar"
              shortcutId="sidebar.toggle"
              testId="overview-show"
              onClick={toggleOverviewSidebar}
            />
          )}
          {!sidebarShown && navAway === undefined && (
            <Foldable level={FOLD_ALL} gap={4}>
              <TopLeftNav className="mr-2" />
            </Foldable>
          )}
          {(switcherInTitlebar || (!sidebarShown && navAway !== "sidebar")) && (
            <EmbedSwitcher placement="titlebar" />
          )}
          {embedTitle !== undefined && <EmbedPageTitle key={embedTitle} title={embedTitle} />}
          {embedTitle === undefined && pathBar && (
            <TitlebarPath solo={soloBar} narrow={carried && folded} />
          )}
          {embedTitle === undefined && !pathBar && (
            <WorkspaceSwitcher
              className={cn(
                "shrink-0 [-webkit-app-region:no-drag]",
                carried && "@max-2xl/titlebar:max-w-28",
                folded && "max-w-20",
              )}
            />
          )}
          {embedTitle === undefined && !soloBar && !pathBar && (
            <>
              <Foldable level={FOLD_ALL} gap={4}>
                <ViewSwitcher className="shrink-0 [-webkit-app-region:no-drag]" />
              </Foldable>
              <FakeAgentBadge className="[-webkit-app-region:no-drag]" />
            </>
          )}
          <div
            ref={setTitlebarSlot}
            data-testid="titlebar-slot"
            className={cn("flex min-w-0 self-stretch", carried && "flex-1")}
          />
        </div>
      )}
      {embedTitle === undefined && pathBar && !settings && <TitlebarPathViews solo={soloBar} />}
      {carried && !settings && (
        <span
          aria-hidden
          data-testid="titlebar-divider"
          className="mx-1 h-4 w-px shrink-0 bg-border"
        />
      )}
      <div
        role="group"
        aria-label="Attention"
        data-testid="titlebar-attention"
        className="flex shrink-0 items-center gap-0.5"
      >
        {(!needsYouPill || beforeSetup) && <InboxButton />}
        <LaunchIssuesChip className="[-webkit-app-region:no-drag]" />
        {!soloBar && !settings && <TitlebarPause className="[-webkit-app-region:no-drag]" />}
        {!beforeSetup && usageKept && (
          <Foldable level={FOLD_ICONS} gap={2}>
            <UsageMeter
              agent={settings ? undefined : agent}
              className="[-webkit-app-region:no-drag]"
              iconOnly
            />
          </Foldable>
        )}
      </div>
      <div
        role="group"
        aria-label="View"
        data-testid="titlebar-view"
        className={cn("flex shrink-0 items-center gap-0.5", CLUSTER_GAP)}
      >
        <TitlebarOverflow
          orchestration={!soloBar}
          hostPage={hostPage}
          folds={{
            views: !settings && embedTitle === undefined && !soloBar && !pathBar,
            settings: !settings && !sidebarShown && navAway === undefined,
            usage: !beforeSetup && usageKept,
          }}
          className="[-webkit-app-region:no-drag]"
        />
      </div>
      <div
        role="group"
        aria-label="Panels"
        data-testid="titlebar-panels"
        className="ml-1 flex shrink-0 items-center gap-0.5"
      >
        {!settings && <TitlebarOpenBeside threadId={barThreadId} />}
        {panelOffered && (
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
        )}
      </div>
    </div>
  );
}
