import { PreviewCard } from "@base-ui/react/preview-card";
import {
  type FeatureCardHeld,
  type OrchestratorLedger,
  type Thread,
  type ThreadId,
  type ThreadSummary,
  type WorkspaceId,
  type WorkspaceState,
} from "@gram/contracts";
import { useParams } from "@tanstack/react-router";
import {
  Bot,
  ChevronDown,
  ChevronsLeft,
  FoldHorizontal,
  Gauge,
  Hourglass,
  LaptopMinimalCheck,
  Link2,
  PanelLeft,
  PanelLeftClose,
  Timer,
  type LucideIcon,
} from "lucide-react";
import {
  memo,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useShallow } from "zustand/react/shallow";

import { AgentIcon, agentLabel } from "@/agents/agent-display";
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { keyLabel } from "@/keyboard/registry";
import { EmbedAccount, EmbedNavigation, EmbedSidebarHeader, EmbedSwitcher } from "@/embed/slots";
import { useScrollFade } from "@/embed/scroll-fade";
import { useEmbedShell, useRoomySidebar, useThreadsListed } from "@/embed/store";
import { useShortcutHint, withHint } from "@/keyboard/use-shortcut-hint";
import { formatRelative, formatStamp } from "@/lib/time";
import { useNow } from "@/lib/use-now";
import { EXPLAIN } from "@/lib/explain";
import { cn } from "@/lib/utils";
import { revealVirtualRow, virtualRowOf, VirtualRows } from "@/lib/virtual-rows";
import { PendingRing, PresenceItem, PresenceList, Swap } from "@/motion";
import { CARD_SURFACE } from "@/reviews/pr-display";
import { focusLost } from "@/lib/use-return-focus";
import { focusSidebar, overviewStops } from "@/shell/focus-regions";
import { useOpenThread } from "@/shell/thread-switcher";
import { UpdatePill } from "@/updates/update-pill";
import { useSwitchWorkspace } from "@/shell/workspace-switcher";
import { activityLine, settledRow, SETTLED_AFTER_MS, threadStatusOf } from "@/sidebar/status";
import { fitShell, overviewFoldKey, useLayoutStore, type ShellFit } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";
import { useSame } from "@/stores/use-same";
import { workerPauseHint } from "@/thread/orchestration-model";
import { useThreadHeadline } from "@/thread/plan-ui";
import { RowMenuItems, rowMenuKeys, threadDragProps, WorkerRowMenuItems } from "@/thread/row-menu";
import { threadDisplayTitle } from "@/thread/thread-title";
import { heldStateText } from "@/usage/limit-format";
import {
  focusInOverview,
  inOverview,
  OVERVIEW_ROOT,
  toggleOverviewSidebar,
} from "@/views/shell-layout";
import { parkedSoloThreads, snoozedSoloThreads, soloThreads } from "@/views/solo-threads";
import { useSettleRule } from "@/views/use-settle-rule";
import { useViewSolo, useViewWorkspace } from "@/views/view-workspace";
import { useBeforeSetup } from "@/welcome/welcome-state";

import { threadNeed } from "./needs-you-items";
import { useAnsweredWorkers, useDerivedAsks } from "./needs-you-store";
import { askKeysByThread } from "./ask-model";
import { NewEntryMenu } from "./new-entry-menu";
import { OverviewEmptyHint } from "./overview-empty-hint";
import { useWorkspaceAsks } from "./ask-stack";
import { PAUSE_WORD, useWorkerPause, WorkerPauseMark, type WorkerPauseState } from "./worker-pause";
import { keepBeside } from "./beside-store";
import { PrChip } from "./feature-card";
import { RAIL_TONES } from "./rail-tones";
import {
  OverviewDone,
  OverviewFoot,
  OverviewHistory,
  OverviewPullRequests,
  OverviewSearch,
  RoomyFoot,
  useOverviewDone,
  useOverviewPrRows,
} from "./overview-extras";
import { ledgerSlotsText } from "./overview-extras-model";
import {
  foldByKey,
  mixedAgents,
  nowLineShown,
  orchestratorHover,
  stateWord,
  orchestratorLine,
  overviewFeatures,
  overviewItems,
  overviewState,
  plainActivity,
  plainRunning,
  rowTone,
  rowWaiting,
  soloDisplay,
  stateWordShown,
  steplessLine,
  edgeWords,
  featureAddsToTitle,
  waitShort,
  workLineText,
  workspaceWorkersText,
  type OverviewFeature,
  type OverviewState,
  type OverviewWorkerRow,
  type ReportNext,
  type RunningWorker,
} from "./overview-model";
import {
  CURRENT_ROW,
  ROW,
  ROW_TRAIL,
  ROW_TITLE,
  RowMenu,
  Section,
  SECTION_CHEVRON,
  SECTION_TITLE,
  SETTLED,
  STOP,
} from "./overview-section";
import { shownPrNumbers, useChipsFit, useWorkerPrChips, WorkerPrChips } from "./overview-pr-chips";
import { threadHost, type MachineMark } from "@/thread/machine-mark";
import { MachineMarker, useMachineMark, useThreadHost } from "@/thread/machine-marker";
import { peek } from "./peek-store";
import { ANSWERED, nowBesidePrs, TONE_DOT, workerStarting, type RailTone } from "./rail-model";
import { showWorkersTab } from "./workers-tab";
import { StatusDot } from "./status-dot";
import { STARTING, STATUS_WORDS } from "./status-words";
import { orchestratorOf, threadWorking, workingWorkerThreads } from "./tree-model";
import { useFeatureCards } from "./use-feature-cards";
import { NeedsYouEntry } from "./needs-you-entry";
import { useNeedsYouCounts } from "./use-needs-you";
import { useWorkerTally, useWorkspaceStatuses } from "./use-workspace-statuses";
import { accentStyle, useWorkspaceAccent } from "./workspace-accent";
import { WorkspaceMenuItems } from "./workspace-menu-items";
import { useOrchestratorLedger, useOrchestratorLedgers, useWorkspaces } from "./use-orchestration";
import { useOrchestratorWaiting, useWorkerWaitings } from "./use-waiting-on";
import type { WaitGlyph, WaitingOn } from "./waiting-on";
import { ledgerWorkersOver, workerActivities, workerTones } from "./workers-model";

// The overview sidebar: the Orchestrator layout's left
// column. What needs you across every workspace, one line per workspace with the one the window is
// on opened into its features and live workers, and the threads outside any workspace. A worker's
// click opens it, where any ask it has shows, ⌥-click peeks and ⌘-click keeps it beside. Watching
// holds nothing: every way in here only reads.

/**
 * The live workers of `workspaceId` by feature, from its cards, and the ask each one waits on. Only
 * the workspace the window is on reads its cards.
 */
export function useOverviewFeatures(workspaceId: WorkspaceId): readonly OverviewFeature[] {
  const cards = useFeatureCards(workspaceId);
  const all = useWorkspaceAsks();
  const asks = all.find((each) => each.workspaceId === workspaceId)?.asks;
  // Which workers show is the Board's rule (`workerShown`): the ledger's, while their work isn't
  // over. A worker closed with its worktree is gone from it.
  const ledger = useOrchestratorLedger(workspaceId).data;
  const over = useThreadsStore(
    useSame((s) => (ledger === undefined ? undefined : ledgerWorkersOver(ledger, s.byId))),
  );
  // What each worker does, by the selector Quiet and the Board share.
  const activities = useThreadsStore(
    useSame((s) => workerActivities(ledger, s.byId, s.statusDetail)),
  );
  // Workers at work right now, whatever their cards say: id, title and feature, flat for a shallow
  // compare.
  const flat = useThreadsStore(
    useShallow((s) =>
      workingWorkerThreads(s.byId, s.statusDetail, workspaceId).flatMap((each) => [
        each.thread.id,
        each.thread.title,
        each.thread.spawnedBy?.feature ?? "",
      ]),
    ),
  );
  // Each live worker's tone, by the selector the Board, ⌘J and Quiet read too.
  const asking = useMemo(() => new Set(askKeysByThread(asks ?? []).keys()), [asks]);
  const answered = useAnsweredWorkers();
  const tones = useThreadsStore(
    useSame(
      (s) =>
        workerTones(
          ledger,
          workingWorkerThreads(s.byId, s.statusDetail, workspaceId).map((t) => t.thread.id),
          { byId: s.byId, statusDetail: s.statusDetail, asking, answered },
        ).tones,
    ),
  );
  // What each one at rest waits on, in the Board's and ⌘J's words.
  const waits = useWorkerWaitings(ledger, asking);
  return useMemo(() => {
    const running: RunningWorker[] = [];
    for (let i = 0; i + 2 < flat.length; i += 3) {
      running.push({
        threadId: flat[i] as ThreadId,
        title: flat[i + 1]!,
        feature: flat[i + 2]!,
      });
    }
    const keys = askKeysByThread(asks ?? []);
    const held = new Set(
      ledger?.features.flatMap((feature) =>
        feature.workers.filter((worker) => worker.userIntervened).map((worker) => worker.threadId),
      ),
    );
    const reports = new Map<ThreadId, ReportNext>();
    for (const worker of ledger?.features.flatMap((feature) => feature.workers) ?? []) {
      const report = worker.lastReport;
      if (report !== undefined) {
        reports.set(worker.threadId, {
          at: report.at,
          nextStep: report.evidence?.nextStep,
        });
      }
    }
    return overviewFeatures(cards, keys, over, running, held, activities, reports, tones, waits);
  }, [cards, asks, ledger, over, flat, activities, tones, waits]);
}

/** ⌘/Ctrl-click: beside the chat rather than in its own view. */
export const besideKey = (event: MouseEvent) => event.metaKey || event.ctrlKey;

// Arrows move between the overview's rows; nothing else is taken, and never from a field.
export const overviewKeys = (event: KeyboardEvent<HTMLElement>) => {
  if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
  if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
  // A folded section's rows are hidden, and can't take the focus.
  const stops = overviewStops(event.currentTarget);
  const active = document.activeElement;
  let from = stops.indexOf(active as HTMLElement);
  // On a control between stops (a worker's PR chip): from the stop before it.
  if (from === -1 && active !== null && event.currentTarget.contains(active)) {
    from = stops.findLastIndex(
      (stop) => (stop.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    );
    if (from !== -1 && event.key === "ArrowUp") from += 1;
  }
  if (from === -1) return;
  const to =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? stops.length - 1
        : Math.max(0, Math.min(stops.length - 1, from + (event.key === "ArrowUp" ? -1 : 1)));
  event.preventDefault();
  const target = stops[to];
  // Up and End land on a list's last row, down and Home on its first.
  const last = event.key === "ArrowUp" || event.key === "End";
  // A virtualized list draws only the rows near the view, so its rows go by index: the next one
  // may not be drawn, and a drawn one may be the focused row kept from far away.
  const origin = stops[from];
  const at = origin === undefined ? undefined : virtualRowOf(origin);
  if (at !== undefined && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
    const next = at.index + (last ? -1 : 1);
    const inRow = target !== undefined && to !== from && at.row.contains(target);
    if (!inRow && next >= 0 && next < at.count) return void focusVirtualRow(at.list, next, last);
  }
  const into = target === undefined ? undefined : virtualRowOf(target);
  // Into a list from outside it, or End onto its last drawn row: its first or last row by index.
  if (into !== undefined && (into.list !== at?.list || event.key === "End")) {
    const index = last ? into.count - 1 : 0;
    if (index !== into.index) return void focusVirtualRow(into.list, index, last);
  }
  target?.focus();
};

/** Focuses the first (or `last`) stop of `list`'s row `index`, once it has drawn. */
const focusVirtualRow = async (list: HTMLElement, index: number, last: boolean) => {
  const row = await revealVirtualRow(list, index);
  const stops = row === null ? [] : overviewStops(row);
  (last ? stops.at(-1) : stops[0])?.focus();
};

/**
 * Where the thread in view lists in the overview, for `useRevealViewed`: "solo" for a solo thread,
 * its workspace's id for a worker, and nothing for an orchestrator (its line is the workspace's own,
 * always shown) or a thread not loaded yet.
 */
export const viewedSection = (
  thread: Pick<Partial<Thread>, "workspaceId" | "spawnedBy"> | undefined,
): "solo" | WorkspaceId | undefined => {
  if (thread === undefined) return undefined;
  if (thread.workspaceId === undefined) return "solo";
  return thread.spawnedBy === undefined ? undefined : thread.workspaceId;
};

/**
 * Opens what the thread in view lists under, once each time the view moves to another thread: a
 * jump to a solo thread opens Solo threads, and one to a worker its workspace's line, so its row
 * shows where it is, marked as the one in view. The thread the window opens on moves nothing, so a
 * section folded there stays folded across a reload, and so does one folded again while there.
 */
function useRevealViewed() {
  const viewed = useParams({ strict: false }).threadId as ThreadId | undefined;
  const section = useThreadsStore((s) =>
    viewedSection(viewed === undefined ? undefined : s.byId[viewed]?.thread),
  );
  // The thread last revealed, or the one the window opened on.
  const revealed = useRef(viewed);
  useEffect(() => {
    // A thread not loaded yet is revealed once it is.
    if (viewed === undefined || section === undefined || revealed.current === viewed) return;
    revealed.current = viewed;
    const layout = useLayoutStore.getState();
    if (section === "solo") layout.unfoldOverviewSection("solo");
    else layout.toggleWorkspaceNode(overviewFoldKey(section), false);
  }, [viewed, section]);
}

/**
 * The Orchestrator layout's left column: what needs you, the orchestrators and the solo threads. On
 * a phone it is the drawer's content: Search and New task at its top, no sidebar toggles, and no
 * usage at its foot (the header's More has it).
 */
export function OverviewSidebar({
  phone = false,
  onPin,
}: {
  phone?: boolean;
  /**
   * Shown over the page from the hosted compact strip: its header's one toggle keeps it open
   * (`onPin`) in place of Hide and Compact.
   */
  onPin?: () => void;
}) {
  const hideHint = useShortcutHint("sidebar.toggle");
  useRevealViewed();
  // The optional sections Settings → General turned off.
  const hidden = useLayoutStore((s) => s.overviewHidden);
  // An app in front of Gram may leave the workspaces and threads out of the sidebar.
  const threadsListed = useThreadsListed();
  const hasHeader = useEmbedShell((s) => s.sidebar.header !== undefined);
  // Before any setup the welcome is the one thing to look at: no usage beside it.
  const beforeSetup = useBeforeSetup();
  // An app in front of Gram may draw it roomy: taller rows, labelled rows at its foot. A phone's
  // drawer keeps its own head, search and New, and takes the look below it.
  const roomyLook = useRoomySidebar();
  const roomy = roomyLook && !phone;
  const scroller = useScrollFade(roomyLook);
  return (
    <aside
      aria-label="Overview"
      data-testid="overview-sidebar"
      data-surface="chrome"
      {...{ [OVERVIEW_ROOT]: "open" }}
      data-overlay={onPin === undefined ? undefined : ""}
      data-look={roomy ? "roomy" : undefined}
      className="flex min-h-0 flex-1 flex-col border-r border-sidebar-divider bg-sidebar text-sidebar-foreground"
    >
      {roomy ? (
        // The embedding app's mark and name, with New beside it; the toggles are at the foot.
        <div className="flex min-h-(--titlebar-height) shrink-0 items-center gap-1 px-inset pt-2.5 pb-1.5">
          <EmbedSidebarHeader />
          {!hasHeader && <span className="flex-1" />}
          {onPin !== undefined && (
            <Hint
              label="Keep sidebar open"
              side="bottom"
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Keep sidebar open"
                  data-testid="overview-pin"
                  className="text-muted-foreground"
                  onClick={onPin}
                />
              }
            >
              <PanelLeft />
            </Hint>
          )}
          {onPin === undefined && (
            <Hint
              label={withHint("Collapse sidebar to a strip", hideHint)}
              side="bottom"
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Collapse sidebar"
                  data-testid="overview-compact"
                  className="text-muted-foreground"
                  onClick={() => switchOverview("compact")}
                />
              }
            >
              <ChevronsLeft />
            </Hint>
          )}
          <UpdatePill size="xs" />
          <NewEntryMenu />
        </div>
      ) : phone ? (
        <div className="flex shrink-0 items-center gap-2 px-3 pt-3 pb-2">
          <OverviewSearch phone />
          <NewEntryMenu />
        </div>
      ) : (
        <>
          {/* The title bar's height. Hide sidebar leads, after macOS's window buttons, in the spot the
          title bar's Show sidebar takes while it is hidden, so the toggle never moves. Too narrow
          for them all beside the buttons, the rest wrap to a row below rather than clip. Its
          room past those buttons decides whether New says its words. */}
          <div className="@container/overview-head flex min-h-(--titlebar-height) shrink-0 flex-wrap content-start items-center gap-1 px-2 py-1.5 pl-[max(--spacing(2),var(--window-lights-inset))] [-webkit-app-region:drag]">
            {onPin !== undefined ? (
              <Hint
                label="Keep sidebar open"
                side="bottom"
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Keep sidebar open"
                    data-testid="overview-pin"
                    className="text-muted-foreground [-webkit-app-region:no-drag]"
                    onClick={onPin}
                  />
                }
              >
                <PanelLeft />
              </Hint>
            ) : (
              <>
                {/* Each icon says what it does the moment it's hovered, with its key where it has one. */}
                <Hint
                  label={withHint("Hide sidebar", hideHint)}
                  side="bottom"
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Hide sidebar"
                      data-testid="overview-hide"
                      className="text-muted-foreground [-webkit-app-region:no-drag]"
                      onClick={toggleOverviewSidebar}
                    />
                  }
                >
                  <PanelLeftClose />
                </Hint>
                {/* The sidebar's own two, side by side and drawn apart: Hide folds it away, Compact
            narrows it to a strip. Settings is at the foot, beside History. */}
                <Hint
                  label="Compact sidebar: a strip that opens on hover"
                  side="bottom"
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Compact sidebar"
                      data-testid="overview-compact"
                      className="text-muted-foreground [-webkit-app-region:no-drag]"
                      onClick={() => switchOverview("compact")}
                    />
                  }
                >
                  <FoldHorizontal />
                </Hint>
              </>
            )}
            <UpdatePill size="xs" />
            <NewEntryMenu />
          </div>
        </>
      )}
      {/* An app in front of Gram puts its own head and switcher here; nothing on Gram's own. */}
      {!roomy && (
        <EmbedSidebarHeader className={cn("flex-none px-inset pb-tight", roomyLook && "pt-1")} />
      )}
      <EmbedSwitcher placement="sidebar" className="px-inset pb-tight" />
      {/* Roomy: Search stays put under the switcher while the list scrolls. */}
      {roomy && (
        <div className="shrink-0 px-inset pb-tight">
          <OverviewSearch roomy />
        </div>
      )}
      {/* The spacing scale's named steps: sections a list's step apart (12 px), as a list's
          headings are, so the column reads as one even list rather than blocks with gaps. */}
      <div
        ref={scroller}
        onKeyDown={overviewKeys}
        className={cn(
          "flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-inset pt-tight pb-list text-body",
          // Roomy: its headings bring their own air, and the list fades out where more of it
          // lies past an edge, rather than cutting a row in half.
          roomyLook
            ? "gap-0 [scrollbar-width:thin] [mask-image:linear-gradient(to_bottom,transparent,black_var(--fade-top,0px),black_calc(100%-var(--fade-bottom,0px)),transparent)]"
            : "gap-list",
        )}
      >
        {/* What needs you, and the way to find anything else, as one block at the top. */}
        <div className="flex flex-col gap-tight">
          <NeedsYou />
          {!phone && !roomy && <OverviewSearch />}
        </div>
        {/* The places an app in front of Gram puts first, above the workspaces and threads. */}
        <EmbedNavigation placement="main" />
        {threadsListed && <Orchestrators />}
      </div>
      {/* The places an app in front of Gram added, with the others you go to: roomy has them in
          its foot's block. */}
      {!roomyLook && <EmbedNavigation />}
      {roomyLook ? (
        <>
          {!phone && !beforeSetup && !hidden.includes("usage") && <OverviewFoot />}
          {/* History, Settings, the account and Collapse, each a labelled row. */}
          <RoomyFoot showHistory={!hidden.includes("doneToday")} />
        </>
      ) : (
        <>
          {/* The embedding app's account, above the foot's own places. */}
          <EmbedAccount className="border-t border-border px-inset py-tight" />
          {/* History and Settings share the foot: the places you go to rather than work in. */}
          <OverviewHistory showHistory={!hidden.includes("doneToday")} />
          {!phone && !beforeSetup && !hidden.includes("usage") && <OverviewFoot />}
        </>
      )}
    </aside>
  );
}

/**
 * Picks the overview open or compact, from the button the other one has. The focus, on that button,
 * goes to the one the new form has in its place, so it isn't lost with the old form.
 */
export const switchOverview = (mode: "open" | "compact") => {
  const from = focusInOverview();
  useLayoutStore.getState().setOverviewSidebar(mode);
  if (!from) return;
  requestAnimationFrame(() =>
    document
      .querySelector<HTMLElement>(
        mode === "compact" ? '[data-testid="overview-hide"]' : '[data-testid="overview-compact"]',
      )
      ?.focus(),
  );
};

/**
 * Automatic, a window crossing `OVERVIEW_OPEN_FROM` swaps the open overview for the rail or back,
 * and the focus in one would drop to the page with it. Lost that way, it goes to the other's
 * current row or tile instead, as a switch by its buttons hands it on. Only focus that was in the
 * overview moves, and only when nothing else has it.
 */
export function useCarryOverviewFocus(sidebar: ShellFit["sidebar"]): void {
  const inside = useRef(false);
  const was = useRef(sidebar);
  useEffect(() => {
    const note = () => {
      inside.current = focusInOverview();
    };
    // A click on the page away from any control moves no focus in, but leaves the overview too. The
    // focus has not moved yet while the pointer goes down, so what was pressed decides.
    const press = (event: PointerEvent) => {
      inside.current = event.target instanceof Element && inOverview(event.target);
    };
    document.addEventListener("focusin", note);
    document.addEventListener("pointerdown", press, true);
    return () => {
      document.removeEventListener("focusin", note);
      document.removeEventListener("pointerdown", press, true);
    };
  }, []);
  useEffect(() => {
    const before = was.current;
    was.current = sidebar;
    const swapped =
      (before === "full" && sidebar === "compact") || (before === "compact" && sidebar === "full");
    if (!swapped || !inside.current || !focusLost()) return;
    // Automatic (no mode stored): a pick of Open or Compact hands the focus on itself.
    if (useLayoutStore.getState().overviewSidebar !== undefined) return;
    void focusSidebar();
  }, [sidebar]);
}

/**
 * The pill: what needs you across every workspace, which opens the Inbox; the window's one global
 * count (the title bar's Inbox button shows none beside it). Its shortcut, and how much of it is
 * here and how much elsewhere, are on its hover.
 */
function NeedsYou() {
  // A true first run, with no thread yet, has nothing to need you: the welcome is the one thing
  // to look at, without a count beside it.
  if (useBeforeSetup()) return null;
  return <NeedsYouEntry variant="row" {...{ [STOP]: "" }} data-testid="overview-needs-you" />;
}

/**
 * The overview's lists: every workspace (Orchestrators), whatever its state, in the order they were
 * made, so a row never moves when its state changes; the solo threads; and At rest at the end, one
 * fold for what needs nothing of you: the pull requests and Done.
 */
function Orchestrators() {
  const workspaces = useWorkspaces();
  // A solo thread in view is in no workspace: none of their lines is marked.
  const solo = useViewSolo();
  const viewed = useViewWorkspace();
  const current = solo ? undefined : viewed;
  const asks = useWorkspaceAsks();
  // The workspaces' own threads, by identity: a solo thread's update re-renders none of this.
  const own = useThreadsStore(
    useShallow((s) =>
      Object.values(s.byId).filter(
        (summary): summary is ThreadSummary => summary?.thread.workspaceId !== undefined,
      ),
    ),
  );
  const { statuses } = useWorkspaceStatuses(own);
  // Each workspace's share of Needs you, the pill's count, and the workers its asks wait on.
  const { byWorkspace } = useNeedsYouCounts();
  const asking = useMemo(
    () => new Map(asks.map((each) => [each.workspaceId as string, askingOf(each.asks)] as const)),
    [asks],
  );
  // Every line counts its workers from its ledger, folded or open, so both say the same.
  const workspaceIds = useMemo(() => workspaces.map((state) => state.workspace.id), [workspaces]);
  const ledgers = useOrchestratorLedgers(workspaceIds);
  const hidden = useLayoutStore((s) => s.overviewHidden);
  const anyThread = useThreadsStore((s) => Object.keys(s.byId).length > 0);
  return (
    <>
      {workspaces.length > 0 && (
        <Section id="orchestrators" title="Orchestrators" count={workspaces.length}>
          {workspaces.map((state) => {
            const id = state.workspace.id;
            return (
              <WorkspaceRow
                key={id}
                state={state}
                here={id === current?.workspace.id}
                asks={byWorkspace.get(id) ?? 0}
                asking={asking.get(id) ?? NO_ASKING}
                word={overviewState(statuses.get(id), state.paused !== undefined)}
                ledger={ledgers.get(id)}
              />
            );
          })}
        </Section>
      )}
      <OverviewEmptyHint />
      {!hidden.includes("solo") && <SoloThreads />}
      <AtRest
        // Pull requests sit beside work: on an empty home, with no workspace and no thread, they
        // would stand alone, unrelated to anything there.
        prs={(workspaces.length > 0 || anyThread) && !hidden.includes("pullRequests")}
        done={!hidden.includes("doneToday")}
      />
    </>
  );
}

/**
 * At rest: what needs nothing of you, folded at the list's end into its one title line until
 * opened (kept across reloads): the pull requests and Done, each under a heading with its count.
 * Workspaces are never in it: they stay listed above, whatever their state.
 */
function AtRest({ prs, done }: { prs: boolean; done: boolean }) {
  const prRows = useOverviewPrRows();
  const finished = useOverviewDone();
  const prCount = prs ? prRows.length : 0;
  const doneCount = done ? finished.rows.length : 0;
  const count = prCount + doneCount;
  if (count === 0) return null;
  return (
    <Section
      id="rest"
      title="At rest"
      count={count}
      hint="Pull requests and finished chats: nothing here needs you."
    >
      {prCount > 0 && <OverviewPullRequests rows={prRows} />}
      {doneCount > 0 && <OverviewDone rows={finished.rows} now={finished.now} />}
    </Section>
  );
}

const NO_ASKING: ReadonlySet<ThreadId> = new Set();

/** The workers a workspace's asks wait on. */
export const askingOf = (asks: Parameters<typeof askKeysByThread>[0]): ReadonlySet<ThreadId> =>
  new Set(askKeysByThread(asks).keys());

/**
 * A workspace's line, and under it, open, its features with their live workers. Every workspace's
 * line has the same form, folded or open, with no worker or many: its dot, its name, one number,
 * its share of Needs you (`needsYouCounts`), and the chevron. Paused or parked, it says that too; the rest (its live
 * workers, who works, its state and its worker slots) is on its hover and in its name. The chevron,
 * or ← and → on the line, folds what is under it, kept per workspace across reloads. An ask
 * arriving never unfolds it: its count says so. Only an open workspace, or the current one, reads
 * its cards.
 */
function WorkspaceRow({
  state,
  here,
  asks,
  asking,
  word,
  ledger,
}: {
  state: WorkspaceState;
  here: boolean;
  asks: number;
  asking: ReadonlySet<ThreadId>;
  word: OverviewState;
  ledger: OrchestratorLedger | undefined;
}) {
  const switchTo = useSwitchWorkspace();
  const id = state.workspace.id;
  // Its workers' count and how many of them work, by the tone their rows' dots take.
  const { live, working } = useWorkerTally(id, ledger, asking);
  const foldKey = overviewFoldKey(id);
  const userFolded = useLayoutStore((s) => s.workspacesCollapsedNodes.includes(foldKey));
  // While the right panel shows this workspace's Workers tab, its workers are listed there, not
  // twice: the sidebar folds them to its line, which says where they are.
  const inTab = useLayoutStore(
    (s) => here && s.panelTab === "workers" && fitShell(s).panel !== "none",
  );
  const folded = userFolded || inTab;
  const fold = (to: boolean) => useLayoutStore.getState().toggleWorkspaceNode(foldKey, to);
  const bodyId = useId();
  // What its orchestrator waits on at rest, unless its pause or park holds everything anyway.
  const orchestratorWaiting = useOrchestratorWaiting(ledger);
  const waiting = stateWordShown(word) ? undefined : orchestratorWaiting;
  const summary = orchestratorHover(word, { live, working, asks }, ledgerSlotsText(ledger));
  const hover = waiting === undefined ? summary : `${summary}\nOrchestrator: ${waiting.hint}`;
  const line = orchestratorLine(word, { working, asks });
  const name = state.workspace.name;
  // The colour the user gave it: a bar beside its line, carried on by its workers' guide.
  const accent = useWorkspaceAccent(id);
  // Nothing under it, not even its orchestrator at work: one line, its name and the word every
  // surface says of a thread at rest (`STATUS_WORDS`), so the palette and this row agree.
  const orchestratorBusy = useThreadsStore(
    (s) => workingOrchestrator(s, state.workspace) !== undefined,
  );
  const empty =
    live === 0 && (ledger?.held?.length ?? 0) === 0 && !orchestratorBusy && word === "idle";
  // ← folds and → unfolds, as a tree row's do, and Shift+F10 opens its menu; anything else is the
  // overview's.
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    rowMenuKeys(event);
    if (event.defaultPrevented) return;
    const to = foldByKey(event, folded);
    if (to === undefined) return;
    event.preventDefault();
    fold(to);
  };
  return (
    <div
      data-testid="overview-workspace"
      data-workspace-id={id}
      data-current={here || undefined}
      data-asks={asks}
      data-folded={folded || undefined}
      className="flex flex-col"
    >
      {/* The current workspace's mark spans its line, the chevron with it, and so does its menu. */}
      <ContextMenu>
        <ContextMenuTrigger
          render={
            <div
              className={cn(
                "flex min-w-0 items-center gap-0.5 rounded-(--radius-sm)",
                here && "bg-sidebar-row-active",
                accent !== undefined && "gram-accent-row",
              )}
              data-accent={accent}
              style={accentStyle(accent)}
            />
          }
        >
          <button
            type="button"
            {...{ [STOP]: "" }}
            data-testid="overview-workspace-row"
            data-live={live}
            data-working={working}
            aria-current={here || undefined}
            aria-expanded={!folded}
            aria-controls={bodyId}
            aria-keyshortcuts="ArrowLeft ArrowRight Shift+F10"
            aria-label={`${name}, ${summary}${waiting === undefined ? "" : `, ${waiting.label}`}`}
            title={hover}
            onClick={() => switchTo(state.workspace)}
            onKeyDown={onKeyDown}
            className={cn(ROW, "min-w-0 flex-1")}
          >
            <span
              aria-hidden
              data-testid="overview-workspace-dot"
              data-working={line.pulse || undefined}
              className={cn(DOT, "rounded-full", line.dot, line.pulse && "gram-working")}
            />
            <span className="truncate font-medium">{name}</span>
            {/* At its edge, as a worker's row: what its orchestrator waits on, else idle, its pause,
                or its workers in short words, then its share of Needs you. Its hover says all. */}
            <span className={ROW_TRAIL}>
              {waiting !== undefined ? (
                <WaitingLine waiting={waiting} testId="overview-orchestrator-waiting" />
              ) : empty ? (
                <span data-testid="overview-workspace-idle" className="truncate">
                  {STATUS_WORDS.idle}
                </span>
              ) : stateWordShown(word) ? (
                <span data-testid="overview-workspace-state" className="truncate capitalize">
                  {stateWord(word)}
                </span>
              ) : live > 0 ? (
                // In the tab, how many and where: what they do is the tab's to say.
                <span data-testid="overview-workspace-summary" className="truncate">
                  {workspaceWorkersText({ live, working, inTab })}
                </span>
              ) : (
                <span className="truncate">
                  {orchestratorBusy ? "At work" : `${ledger?.held?.length ?? 0} held`}
                </span>
              )}
              {asks > 0 && (
                <span
                  data-testid="overview-workspace-asks"
                  className="min-w-4.5 shrink-0 rounded-full border border-sidebar-block-border px-1.5 text-center text-caption leading-4 font-semibold text-status-needs tabular-nums"
                >
                  {asks}
                </span>
              )}
            </span>
          </button>
          <Hint
            label={
              inTab
                ? `${name}'s workers are in the Workers tab`
                : folded
                  ? `Show ${name}'s workers`
                  : `Hide ${name}'s workers`
            }
            render={
              <button
                type="button"
                data-testid="overview-workspace-fold"
                data-in-tab={inTab || undefined}
                aria-expanded={!folded}
                aria-controls={bodyId}
                aria-label={
                  inTab
                    ? `Go to ${name}'s workers in the Workers tab`
                    : folded
                      ? `Show ${name}'s workers`
                      : `Hide ${name}'s workers`
                }
                // In the tab: the chevron leads there, with the keys on its rows.
                onClick={() => (inTab ? showWorkersTab() : fold(!folded))}
                className="grid size-7 shrink-0 cursor-default place-items-center rounded-(--radius-sm) text-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-foreground focus-visible:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring"
              />
            }
          >
            <ChevronDown
              aria-hidden
              className={cn(
                "size-icon-chip transition-transform duration-(--dur-fast)",
                folded && "-rotate-90",
              )}
            />
          </Hint>
        </ContextMenuTrigger>
        <ContextMenuContent data-testid="overview-workspace-menu">
          <WorkspaceMenuItems state={state} />
        </ContextMenuContent>
      </ContextMenu>
      <div
        id={bodyId}
        hidden={folded}
        className={cn("flex flex-col", accent !== undefined && "gram-accent-rail")}
        style={accentStyle(accent)}
      >
        {/* The current one's are there folded too, for ⌘J to open it on its first worker. */}
        {(here || !folded) && <WorkspaceBody workspaceId={id} empty={empty} />}
      </div>
    </div>
  );
}

/** An open workspace's features and their live workers, from its cards. */
function WorkspaceBody({ workspaceId, empty }: { workspaceId: WorkspaceId; empty: boolean }) {
  const features = useOverviewFeatures(workspaceId);
  return <WorkspaceFeatures workspaceId={workspaceId} features={features} empty={empty} />;
}

/**
 * An open workspace: its live workers straight under its orchestrator, most urgent first
 * (`overviewItems`), then its briefs held for a limit. A worker's feature and stage are on its hover.
 */
function WorkspaceFeatures({
  workspaceId,
  features,
  empty,
}: {
  workspaceId: WorkspaceId;
  features: readonly OverviewFeature[];
  /** Its line already says "idle": nothing more under it. */
  empty: boolean;
}) {
  // A snoozed worker is out of the list until its snooze ends; the Board still shows it.
  const snoozed = useThreadsStore(
    useShallow((s) =>
      Object.values(s.byId)
        .filter((each) => each.thread.snoozedUntil !== undefined)
        .map((each) => each.thread.id),
    ),
  );
  const items = useMemo(() => {
    const away = new Set<string>(snoozed);
    return overviewItems(features).filter(
      (item) => item.kind !== "worker" || !away.has(item.row.threadId),
    );
  }, [features, snoozed]);
  const agentMark = useAgentsMixed(
    items.flatMap((item) => (item.kind === "worker" ? [item.row.threadId] : [])),
  );
  if (items.length === 0) {
    if (empty) return null;
    return (
      <OrchestratorAtWork workspaceId={workspaceId} className="pb-1 pl-6">
        No workers now.
      </OrchestratorAtWork>
    );
  }
  return (
    <div
      data-testid="overview-workers"
      data-accent-guide=""
      className="mb-1 ml-3 flex flex-col gap-px border-l border-sidebar-divider pl-2"
    >
      <PresenceList>
        {items.map((item) =>
          item.kind === "worker" ? (
            <PresenceItem key={item.row.threadId}>
              <WorkerRow
                row={item.row}
                feature={item.feature}
                updatedAt={item.updatedAt}
                agentMark={agentMark}
              />
            </PresenceItem>
          ) : (
            <PresenceItem key={item.held.id}>
              <HeldRow held={item.held} />
            </PresenceItem>
          ),
        )}
      </PresenceList>
    </div>
  );
}

/**
 * Whether the workers listed together run more than one agent (`mixedAgents`): only then does each
 * row show its agent's mark. All on one agent, the state dot alone marks a row, and its name and
 * hover card say the agent.
 */
export function useAgentsMixed(threadIds: readonly ThreadId[]): boolean {
  return useThreadsStore((s) =>
    mixedAgents(threadIds.map((id) => s.byId[id]?.thread.model?.agent)),
  );
}

/**
 * A live worker: a click opens it, where any ask it has shows, ⌥-click peeks and ⌘/Ctrl-click keeps
 * it beside; a right-click (or Shift+F10) opens its menu, and it drags onto a grid pane. Its agent's
 * mark shows only while its list mixes agents (`agentMark`), and a second line only for an ask, a
 * failure or real activity; its name and hover card keep the rest. In the compact rail's flyout it
 * has no hover card of its own (`card={false}`), the flyout being one.
 */
export function WorkerRow({
  row,
  feature,
  updatedAt,
  agentMark = false,
  card = true,
}: {
  row: OverviewWorkerRow;
  feature: string;
  updatedAt: number;
  /** Its list's workers run more than one agent, so its agent's mark says which. */
  agentMark?: boolean;
  card?: boolean;
}) {
  const openThread = useOpenThread();
  // Only this row's answer: a move to another thread re-renders the two rows it changes, not all.
  const viewed = useParams({
    strict: false,
    select: (params) => params.threadId === row.threadId,
  });
  const lastActivity = useThreadsStore((s) => s.byId[row.threadId]?.thread.lastActivityAt);
  const agent = useThreadsStore((s) => s.byId[row.threadId]?.thread.model?.agent);
  const status = useThreadsStore((s) => s.byId[row.threadId]?.status);
  const unread = useThreadsStore((s) => s.byId[row.threadId]?.thread.unread === true);
  const busy = useThreadsStore((s) => busyThread(s, row.threadId));
  const pause = useWorkerPause(row.threadId, status, row.held);
  const asking = row.askKey !== undefined;
  // One tone for its dot, its words and its count on the orchestrator's line, as the Board has it.
  const tone = rowTone(row, { status, working: busy });
  const dot = TONE_DOT[tone];
  const working = tone === "working";
  const waiting = rowWaiting(row, tone);
  // Ages to the minute.
  const now = useNow(true, undefined, 60_000);
  const settled =
    tone === "idle" &&
    pause === undefined &&
    lastActivity !== undefined &&
    now - lastActivity >= SETTLED_AFTER_MS;
  // Spawned and not begun, or its session opening: nothing has run yet, so neither "Working" nor
  // "Stopped" is true. The rule ⌘J's rows, the Workers panel and the worker's header read too.
  const starting =
    tone === "working" && workerStarting({ asking, state: row.state, failed: row.failed, status });
  // At work, its dot says it all: no words at its edge, unless an answer just sent; its plan's step
  // and what it runs are on its hover card.
  const routine = working && !starting && !asking && !row.failed && row.now !== ANSWERED;
  // The other machine it runs on, if any: named at its edge unless the edge has words of its own,
  // when the glyph alone stands and the name is on its hover card.
  const hostId = useThreadHost(row.threadId);
  const machine = useMachineMark(hostId);
  // What its edge says beyond its dot: "Starting…", an ask, a failure, a wait's reason, real
  // activity. A tone's own word ("Idle") gives way to the machine's name.
  const edgeSays = starting || (!routine && (waiting !== undefined || nowLineShown(row)));
  const prChips = useWorkerPrChips(row.threadId, row.prs);
  // The words win outright: with words at its edge its PR chips stay on its hover card; at work,
  // with no words or pause mark, they sit after its title while the whole title fits beside them.
  const chipsShown = routine && pause === undefined ? prChips : NO_CHIPS;
  const { line, words, ghost, fits } = useChipsFit(chipsShown.length);
  const facts = [
    row.title,
    ...(unread ? ["unread"] : []),
    ...(pause === undefined ? [] : [PAUSE_WORD[pause.state]]),
    starting ? STARTING : (waiting?.label ?? row.now),
    ...(machine === undefined ? [] : [machine.words]),
    ...(agent === undefined ? [] : [agentLabel(agent)]),
    ...(lastActivity === undefined ? [] : [`last active ${formatStamp(lastActivity)}`]),
  ];
  const preview = usePickedPreview();
  const onClick = (event: MouseEvent<HTMLElement>) => {
    preview.picked();
    if (besideKey(event)) keepBeside(row.threadId, openThread);
    else if (event.altKey) {
      peek({ kind: "worker", threadId: row.threadId, title: row.title }, event.currentTarget);
    } else openThread(row.threadId);
  };
  const props = {
    type: "button" as const,
    [STOP]: "",
    "data-testid": "overview-worker",
    "data-thread-id": row.threadId,
    "data-asking": asking || undefined,
    "data-unread": unread || undefined,
    "aria-current": viewed || undefined,
    "aria-label": facts.join(", "),
    // The compact rail's flyout has no card to say them.
    title: card
      ? undefined
      : `${facts.join(" · ")}${waiting === undefined ? "" : `\n${waiting.hint}`}`,
    "aria-keyshortcuts": "Shift+F10",
    onClick,
    onKeyDown: rowMenuKeys,
    ...threadDragProps(row.threadId),
    // Like every row: one line, its title cut at its end with the whole of it on hover, and its
    // state in short words with its PR chips at the line's right edge.
    className: cn(ROW, CURRENT_ROW, settled && SETTLED),
  };
  // The PRs its chips show, which its words then leave out: each said once, in the chip or, where
  // the chip doesn't fit, on the row's hover card.
  const shownPrs = shownPrNumbers(chipsShown);
  const body = (
    <>
      <StatusDot state={tone} data-testid="overview-worker-dot" data-tone={tone} className={DOT} />
      {/* Its title, one line cut at its end; the hover card, or the flyout's tooltip, says the
          whole. At work, its PR chips sit after it at the line's end only while the whole title
          fits beside them: the title wins, and short of room they wrap out of sight to the hover
          card (`useChipsFit`). */}
      <span ref={line} className="flex h-lh min-w-0 flex-wrap overflow-hidden">
        <span
          ref={words}
          data-testid="overview-worker-title"
          className={cn(
            ROW_TITLE,
            "max-w-full flex-[0_1_auto] text-foreground",
            unread && UNREAD_TITLE,
          )}
        >
          {row.title}
        </span>
        <WorkerPrChips
          threadId={row.threadId}
          cardPrs={row.prs}
          chips={chipsShown}
          dense
          ghost
          ghostRef={ghost}
          className="ml-auto h-lh items-center pl-1.5"
        />
      </span>
      {/* At its edge: a pause and its agent's marks, then what its dot can't say in short words (an
          ask, a failure, a wait's reason, "Starting…"); at work, nothing. */}
      <span className={ROW_TRAIL}>
        {/* Its hover is the row's own: its card, or the flyout's title, says the machine whole. */}
        <MachineMarker
          hostId={hostId}
          show={edgeSays ? "glyph" : "name"}
          hover="none"
          testId="overview-worker-machine"
        />
        {pause !== undefined && <WorkerPauseMark pause={pause} />}
        {agentMark && agent !== undefined && (
          <span data-testid="overview-worker-agent" className="flex shrink-0">
            <AgentIcon agent={agent} className="size-icon-row" />
          </span>
        )}
        {machine !== undefined && !edgeSays ? null : starting ? (
          <span
            data-testid="overview-worker-starting"
            className="min-w-0 truncate text-meta text-muted-foreground"
          >
            {STARTING}
          </span>
        ) : routine ? null : waiting !== undefined ? (
          <WaitingLine waiting={waiting} testId="overview-worker-waiting" prs={shownPrs} />
        ) : (
          <WorkerNow row={row} asking={asking} tone={tone} prs={shownPrs} />
        )}
      </span>
    </>
  );
  // The PR chips sit over the title line's end, outside its button: each is a button of its own.
  // Its agent's mark, when it shows, keeps the edge.
  const chips = fits && (
    <WorkerPrChips
      threadId={row.threadId}
      cardPrs={row.prs}
      chips={chipsShown}
      card={card}
      dense
      className={cn(
        "absolute top-1/2 -translate-y-1/2",
        agentMark && agent !== undefined ? "right-7.5" : "right-1.5",
      )}
    />
  );
  if (!card) {
    return (
      <RowMenu menu={<WorkerRowMenuItems threadId={row.threadId} />}>
        <button {...props}>{body}</button>
        {chips}
      </RowMenu>
    );
  }
  return (
    <RowMenu menu={<WorkerRowMenuItems threadId={row.threadId} />}>
      <PreviewCard.Root open={preview.open} onOpenChange={preview.onOpenChange}>
        <PreviewCard.Trigger
          delay={250}
          render={<button {...props} />}
          onMouseLeave={preview.onMouseLeave}
          onBlur={preview.onBlur}
        >
          {body}
        </PreviewCard.Trigger>
        <PreviewCard.Portal>
          <PreviewCard.Positioner
            side="right"
            align="start"
            sideOffset={8}
            className="isolate z-50"
          >
            <PreviewCard.Popup
              data-testid="overview-worker-card"
              data-surface="overlay"
              className={cn(CARD_SURFACE, "flex w-72 flex-col gap-1.5 p-3 text-reading")}
            >
              <WorkerCard
                row={row}
                feature={feature}
                agent={agent}
                lastActivity={lastActivity ?? updatedAt}
                dot={dot}
                tone={tone}
                asking={asking}
                pause={pause}
                waiting={waiting}
                machine={machine}
              />
            </PreviewCard.Popup>
          </PreviewCard.Positioner>
        </PreviewCard.Portal>
      </PreviewCard.Root>
      {chips}
    </RowMenu>
  );
}

/**
 * A row's hover card, closed by the click or Enter that opens the row: it would otherwise stay over
 * the thread just opened, under a pointer that hasn't moved. It stays closed until a fresh hover,
 * after the pointer has left the row, or a fresh focus, after the focus has left it; a focus still
 * opens it from the keyboard.
 */
function usePickedPreview() {
  const [open, setOpen] = useState(false);
  const hoverQuiet = useRef(false);
  const focusQuiet = useRef(false);
  return {
    open,
    picked: () => {
      hoverQuiet.current = true;
      focusQuiet.current = true;
      setOpen(false);
    },
    onOpenChange: (next: boolean, details: PreviewCard.Root.ChangeEventDetails) => {
      if (next && details.reason === "trigger-hover" && hoverQuiet.current) return;
      if (next && details.reason === "trigger-focus" && focusQuiet.current) return;
      setOpen(next);
    },
    onMouseLeave: () => {
      hoverQuiet.current = false;
    },
    onBlur: () => {
      focusQuiet.current = false;
    },
  };
}

const NO_PRS: readonly { readonly number: number }[] = [];

const NO_CHIPS: ReturnType<typeof useWorkerPrChips> = [];

/** A title marked unread (Mark unread, or an agent's `set_unread`): heavier, until it is opened. */
const UNREAD_TITLE = "font-semibold text-foreground";

/** A worker's line while its agent session opens, before its first turn runs. */

/** A row's 8 px dot, centred in its mark column on the row's one line. */
const DOT = "size-2 justify-self-center";

/**
 * A worker's card now line under its title, when it says more than the row's dot; else its tone in
 * a word, so every live row keeps the same status line under its title.
 */
function WorkerNow({
  row,
  asking,
  tone,
  prs = NO_PRS,
}: {
  row: OverviewWorkerRow;
  asking: boolean;
  tone: RailTone;
  /** PRs its chips show beside it, left out of its words. */
  prs?: readonly { readonly number: number }[];
}) {
  if (!nowLineShown(row)) {
    return (
      <span
        data-testid="overview-worker-state"
        className="min-w-0 truncate text-meta text-muted-foreground"
      >
        {RAIL_TONES[tone].label}
      </span>
    );
  }
  return (
    <Swap
      swapKey={row.now}
      className={cn(
        "min-w-0 truncate text-meta",
        asking ? "text-foreground" : row.failed ? "text-destructive" : "text-muted-foreground",
      )}
    >
      <span data-testid="overview-worker-now" className="truncate">
        {nowBesidePrs(edgeWords(row.now), prs)}
      </span>
    </Swap>
  );
}

/** A worker's step on its hover card in full, its plan's step count included. */
function WorkerCardStep({ row }: { row: OverviewWorkerRow }) {
  const step = useWorkLine(row.threadId, row.report);
  if (step === undefined) return null;
  return (
    <p data-testid="overview-worker-card-step" className="text-meta text-muted-foreground">
      {step}
    </p>
  );
}

/**
 * A worker on hover: its feature, agent, title, station and now line, its whole step while it
 * works, first PR and last activity.
 */
function WorkerCard({
  row,
  feature,
  agent,
  lastActivity,
  dot,
  tone,
  asking,
  pause,
  waiting,
  machine,
}: {
  row: OverviewWorkerRow;
  feature: string;
  agent: string | undefined;
  lastActivity: number;
  dot: string;
  tone: RailTone;
  asking: boolean;
  pause: WorkerPauseState | undefined;
  waiting: WaitingOn | undefined;
  /** The other machine it runs on; absent on this one. */
  machine: MachineMark | undefined;
}) {
  const time = formatStamp(lastActivity);
  // Its agent, then its feature where the title doesn't already say it; wrapped, never cut.
  const context = [
    ...(agent === undefined ? [] : [agentLabel(agent)]),
    ...(featureAddsToTitle(feature, row.title) ? [feature] : []),
  ];
  return (
    <>
      {context.length > 0 && (
        <p data-testid="overview-worker-card-feature" className="text-meta text-muted-foreground">
          {context.join(" · ")}
        </p>
      )}
      <p data-testid="overview-worker-card-title" className="font-medium">
        {row.title}
      </p>
      {/* Its station and now line, wrapped rather than cut: a wait in its short words, as the
          list under it says each one whole. */}
      <p className="flex min-w-0 items-start gap-1.5 text-meta">
        <span className="flex h-lh shrink-0 items-center">
          <span
            aria-hidden
            title={RAIL_TONES[tone].label}
            className={cn("size-1.5 rounded-full", dot)}
          />
        </span>
        <span data-testid="overview-worker-card-station" className="shrink-0 text-foreground/80">
          {row.stationLabel}
        </span>
        <span
          data-testid="overview-worker-card-now"
          className={cn(
            "min-w-0 flex-1 break-words",
            asking ? "text-foreground" : row.failed ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {waiting === undefined ? row.now : waitShort(waiting.label)}
        </span>
        <time
          data-testid="overview-worker-card-time"
          dateTime={new Date(lastActivity).toISOString()}
          title={`Last activity ${time}`}
          className="shrink-0 text-muted-foreground tabular-nums"
        >
          {time}
        </time>
      </p>
      {tone === "working" && !asking && !row.failed && <WorkerCardStep row={row} />}
      {waiting !== undefined && <WaitingList waiting={waiting} />}
      {pause !== undefined && (
        <p
          data-testid="overview-worker-card-paused"
          className="flex items-center gap-1.5 text-meta text-muted-foreground"
        >
          <WorkerPauseMark pause={pause} />
          {workerPauseHint(pause.state, pause.at)}
        </p>
      )}
      {row.pr !== undefined && (
        <span className="flex">
          <PrChip pr={row.pr} threadId={row.threadId} />
        </span>
      )}
      {/* Where it runs, whole: the machine, how it got in, its state, and why when it is offline. */}
      {machine !== undefined && (
        <p
          data-testid="overview-worker-card-machine"
          className={cn(
            "text-meta whitespace-pre-line",
            machine.state === undefined ? "text-muted-foreground" : "text-foreground/80",
          )}
        >
          {machine.hint}
        </p>
      )}
      <p className="mt-0.5 flex gap-3 border-t border-border pt-1.5 text-meta text-muted-foreground">
        <span>Click · open</span>
        <span>{keyLabel("⌥-click")} · peek</span>
        <span>{keyLabel("⌘-click")} · beside</span>
      </p>
    </>
  );
}

/** A wait's glyph at a row's edge, in the PR vocabulary's marks where it has one. */
const WAIT_GLYPH: Readonly<Record<WaitGlyph, LucideIcon>> = {
  ci: PendingRing,
  localCheck: LaptopMinimalCheck,
  review: Bot,
  merge: Timer,
  dependency: Link2,
  limit: Gauge,
};

/**
 * What a worker or an orchestrator at rest waits on, at its row's edge, as calm as an idle row
 * beside the row's hollow dot that already says it waits: the wait's glyph and its key token, the
 * PR or the time ("#397", "08:10"), where it has them (`WaitEdge`), else its short words without
 * "Waiting" (`waitShort`). Its words are on its hover; the whole list is on the row's card.
 */
function WaitingLine({
  waiting,
  testId,
  prs = NO_PRS,
}: {
  waiting: WaitingOn;
  testId: string;
  /** PRs its row's chips show, left out of its words. */
  prs?: readonly { readonly number: number }[];
}) {
  const edge = waiting.edge;
  const Glyph = edge === undefined ? undefined : WAIT_GLYPH[edge.glyph];
  return (
    <Swap swapKey={waiting.label} className="min-w-0 truncate text-meta text-muted-foreground">
      <span
        data-testid={testId}
        data-kind={waiting.kind}
        data-glyph={edge?.glyph}
        title={waiting.label}
        className="flex min-w-0 items-center gap-1"
      >
        {Glyph !== undefined && <Glyph aria-hidden className="size-icon-chip shrink-0" />}
        <span className={cn("truncate", edge !== undefined && "tabular-nums")}>
          {edge === undefined ? nowBesidePrs(waitShort(waiting.label), prs) : edge.token}
        </span>
      </span>
    </Swap>
  );
}

/** Every wait of a worker on its hover card, the one its row names first. */
function WaitingList({ waiting }: { waiting: WaitingOn }) {
  return (
    <ul
      data-testid="overview-worker-card-waits"
      className="flex flex-col gap-0.5 text-meta text-muted-foreground"
    >
      {waiting.reasons.map((reason, i) => (
        <li key={i} data-kind={reason.kind} className="flex min-w-0 gap-1.5">
          <Hourglass aria-hidden className="mt-0.75 size-icon-chip shrink-0" />
          <span className="min-w-0">{reason.detail}</span>
        </li>
      ))}
    </ul>
  );
}

/** A brief held until a usage limit resets, in one row: no thread yet, so nothing to open. */
function HeldRow({ held }: { held: FeatureCardHeld }) {
  const now = useNow(true, undefined, 60_000);
  const when = heldStateText(held, now);
  return (
    <div
      data-testid="overview-held"
      data-held-id={held.id}
      title={`${held.title}\nheld · ${when}`}
      className={cn(ROW, "hover:bg-transparent")}
    >
      <StatusDot state="held" className="justify-self-center" />
      <span className={cn(ROW_TITLE, "text-muted-foreground")}>{held.title}</span>
      <span className={ROW_TRAIL}>
        <span className="truncate">held · {when}</span>
      </span>
    </div>
  );
}

/**
 * A solo row's height (one line, `--space-row` at the comfortable density), the virtual list's
 * estimate until it measures a row, and the space between rows (the section's `gap-px`).
 */
const SOLO_ROW = 36;
const SOLO_GAP = 1;

const soloKey = (summary: ThreadSummary) => summary.thread.id;

/**
 * The threads outside any workspace, latest first, the parked ones folded under them: a click opens
 * one. Those marked done are in Done, with the finished workers.
 */
const SoloThreads = memo(function SoloThreads() {
  const workspaces = useWorkspaces();
  const ids = useMemo(
    () => new Set(workspaces.map((state) => state.workspace.id as string)),
    [workspaces],
  );
  // The solo threads, by identity and order: a worker's update re-renders none of them.
  const settle = useSettleRule();
  const solo = useThreadsStore(useShallow((s) => soloThreads(Object.values(s.byId), ids, settle)));
  const parked = useThreadsStore(useShallow((s) => parkedSoloThreads(Object.values(s.byId), ids)));
  const snoozed = useThreadsStore(
    useShallow((s) => snoozedSoloThreads(Object.values(s.byId), ids)),
  );
  const viewed = useParams({ strict: false }).threadId;
  if (solo.length + parked.length + snoozed.length === 0) return null;
  return (
    <Section id="solo" title="Solo threads" count={solo.length} hint={EXPLAIN.solo} term="solo">
      {solo.length > 0 && <SoloList threads={solo} viewed={viewed} />}
      {snoozed.length > 0 && <FoldedThreads kind="snoozed" threads={snoozed} viewed={viewed} />}
      {parked.length > 0 && <FoldedThreads kind="parked" threads={parked} viewed={viewed} />}
    </Section>
  );
});

/** Solo rows, drawn only near the view: there may be hundreds. */
function SoloList({
  threads,
  viewed,
}: {
  threads: readonly ThreadSummary[];
  viewed: string | undefined;
}) {
  return (
    <VirtualRows
      items={threads}
      rowKey={soloKey}
      estimate={SOLO_ROW}
      gap={SOLO_GAP}
      current={threads.findIndex((summary) => summary.thread.id === viewed)}
    >
      {(summary) => <SoloRow summary={summary} />}
    </VirtualRows>
  );
}

const FOLDED = {
  parked: { label: "Archived", hint: undefined as string | undefined },
  snoozed: {
    label: "Snoozed",
    hint: "Each comes back unread at its time, or sooner if it needs you." as string | undefined,
  },
} as const;

/**
 * The parked solo threads, or the snoozed ones, behind one line, folded until opened: out of the
 * way, still a click away. (The done ones had a line of their own until Done took them in.)
 */
function FoldedThreads({
  kind,
  threads,
  viewed,
}: {
  kind: keyof typeof FOLDED;
  threads: readonly ThreadSummary[];
  viewed: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const rows = `overview-${kind}-rows`;
  const { label, hint } = FOLDED[kind];
  return (
    <div data-testid={`overview-${kind}`} className="flex flex-col gap-px">
      <button
        type="button"
        {...{ [STOP]: "" }}
        aria-expanded={open}
        aria-controls={rows}
        aria-label={`${label}, ${threads.length}`}
        title={
          hint === undefined
            ? `${label}, ${threads.length}`
            : `${label}, ${threads.length}. ${hint}`
        }
        onClick={() => setOpen(!open)}
        // A section title's look, its count in the same column.
        className={SECTION_TITLE}
      >
        <ChevronDown aria-hidden className={cn(SECTION_CHEVRON, !open && "-rotate-90")} />
        <span className="min-w-0 truncate">{label}</span>
        <span className="tabular-nums">{threads.length}</span>
      </button>
      <div id={rows} hidden={!open} className="flex flex-col gap-px">
        <SoloList threads={threads} viewed={viewed} />
      </div>
    </div>
  );
}

type ThreadsState = ReturnType<typeof useThreadsStore.getState>;

/** Whether a thread is at work now, as its tree row would show it. */
const busyThread = (s: ThreadsState, threadId: ThreadId): boolean => {
  const summary = s.byId[threadId];
  return summary !== undefined && threadWorking(summary, s.statusDetail[threadId]);
};

/** The workspace's orchestrator (`orchestratorOf`), while it is at work itself. */
const workingOrchestrator = (
  s: ThreadsState,
  workspace: Pick<WorkspaceState["workspace"], "id" | "orchestratorThreadId">,
): ThreadId | undefined => {
  const orchestrator = orchestratorOf(Object.values(s.byId), workspace);
  return orchestrator !== undefined &&
    threadWorking(orchestrator, s.statusDetail[orchestrator.thread.id])
    ? orchestrator.thread.id
    : undefined;
};

/**
 * What a thread at work is doing, in plain words (`plainActivity`): what kind of thing it runs,
 * never the command or a path. With nothing of its own running, the work left running under it.
 */
const workLineOf = (s: ThreadsState, threadId: ThreadId): string | undefined => {
  const summary = s.byId[threadId];
  if (summary === undefined) return undefined;
  const activity = activityLine(summary.status, s.statusDetail[threadId], summary.activity);
  const display = threadStatusOf(summary, s.statusDetail[threadId]);
  if (!display.working && display.running === undefined) return undefined;
  if (activity !== undefined) return plainActivity(activity);
  // The glyph's title lists each command under the work it counts; its label alone stays plain.
  return display.running === undefined ? display.title : plainRunning(display.label);
};

/**
 * What a thread at work is doing, as its row says it: its plan's step and what it runs, else what
 * it runs. An orchestrator has no plan headline, so its line is always what it runs. A needs-you
 * headline is left to the ask stack and the row's glyph.
 */
const useWorkLine = (threadId: ThreadId, report?: ReportNext | undefined): string | undefined => {
  const { headline } = useThreadHeadline(threadId, plainActivity);
  const running = useThreadsStore((s) => workLineOf(s, threadId));
  const planAt = useThreadsStore((s) => s.byId[threadId]?.plan?.updatedAt);
  return workLineText(headline, planAt, report, running);
};

function WorkLine({ threadId }: { threadId: ThreadId }) {
  const line = useWorkLine(threadId);
  return <>{line === undefined ? line : steplessLine(line)}</>;
}

/**
 * The orchestrator of the workspace, while it runs something itself: what it runs, opening it on a
 * click. Else `children`, the line for nothing at work.
 */
export function OrchestratorAtWork({
  workspaceId,
  className,
  children,
}: {
  workspaceId: WorkspaceId;
  className?: string;
  children: ReactNode;
}) {
  const workspace = useWorkspaces().find((state) => state.workspace.id === workspaceId)?.workspace;
  const threadId = useThreadsStore((s) => workingOrchestrator(s, workspace ?? { id: workspaceId }));
  if (threadId === undefined) {
    return <p className={cn("text-meta text-muted-foreground", className)}>{children}</p>;
  }
  return <AtWorkLines threadId={threadId} own className={className} />;
}

/**
 * A thread at work: its title (unless `own`, the orchestrator's own line under its workspace) and
 * its step, its last activity on hover. A click opens it, ⌥-click peeks and ⌘-click keeps it
 * beside, as a worker row's.
 */
function AtWorkLines({
  threadId,
  own = false,
  className,
}: {
  threadId: ThreadId;
  own?: boolean;
  className?: string | undefined;
}) {
  const openThread = useOpenThread();
  const title = useThreadsStore((s) => s.byId[threadId]?.thread.title) ?? "";
  const at = useThreadsStore((s) => s.byId[threadId]?.thread.lastActivityAt);
  const onClick = (event: MouseEvent<HTMLElement>) => {
    if (besideKey(event)) keepBeside(threadId, openThread);
    else if (event.altKey) {
      peek({ kind: "worker", threadId, title }, event.currentTarget);
    } else openThread(threadId);
  };
  return (
    <button
      type="button"
      {...{ [STOP]: "" }}
      data-testid="overview-at-work"
      data-thread-id={threadId}
      data-own={own || undefined}
      title={at === undefined ? undefined : `Last activity ${formatStamp(at)}`}
      onClick={onClick}
      className={cn(
        "flex w-full min-w-0 cursor-default flex-col rounded-(--radius-sm) text-left text-meta outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      <span className="flex w-full min-w-0 items-center gap-1.5">
        <span
          aria-hidden
          className="size-1.5 shrink-0 rounded-full bg-status-working gram-working"
        />
        <span className="truncate text-foreground">{own ? "Orchestrator" : title}</span>
        {at !== undefined && <span className="sr-only">, last active {formatStamp(at)}</span>}
      </span>
      <span data-testid="overview-at-work-line" className="w-full truncate text-muted-foreground">
        <WorkLine threadId={threadId} />
      </span>
    </button>
  );
}

/**
 * A thread outside any workspace. At work its dot pulses and its last activity goes to its hover; a
 * day at rest, or `settled`, it fades until hovered.
 */
export function SoloRow({
  summary,
  settled = false,
}: {
  summary: ThreadSummary;
  settled?: boolean;
}) {
  const openThread = useOpenThread();
  // Only this row's answer: a move to another thread re-renders the two rows it changes, not all.
  const viewed = useParams({
    strict: false,
    select: (params) => params.threadId === summary.thread.id,
  });
  // Ages to the minute.
  const now = useNow(true, undefined, 60_000);
  const { thread } = summary;
  const detail = useThreadsStore((s) => s.statusDetail[thread.id]);
  // What the Inbox lists it for, if anything: a row at rest says that, never "Stopped", so the
  // row, the pill and the Inbox agree on the same thread.
  const need = useDerivedAsks((s) => threadNeed(s.needsYou.groups, thread.id));
  const display = soloDisplay(threadStatusOf(summary, detail), need);
  const title = threadDisplayTitle(thread);
  // Started before its machine: its hover says what waits and since when, or that none came.
  const waiting = thread.awaitingMachine;
  const state =
    waiting === undefined
      ? display.label
      : waiting.failed === undefined
        ? `${display.title} · since ${formatStamp(waiting.since)}`
        : display.title;
  const lastActive =
    display.working && waiting === undefined
      ? `Last activity ${formatStamp(thread.lastActivityAt)}`
      : "";
  const faded = settled || settledRow(summary.status, display, thread.lastActivityAt, now);
  // What needs you, or a failure: said in words at the row's edge, in its colour.
  const alarm = display.tone === "text-status-needs" || display.tone === "text-destructive";
  // The other machine it runs on, if any: named at its edge before its time, its glyph alone
  // beside an alarm's words.
  const hostId = threadHost(thread);
  const machine = useMachineMark(hostId);
  const where = machine === undefined ? "" : `, ${machine.words}`;
  return (
    <RowMenu menu={<RowMenuItems threadId={thread.id} />}>
      <button
        type="button"
        {...{ [STOP]: "" }}
        {...threadDragProps(thread.id)}
        data-testid="overview-solo"
        data-thread-id={thread.id}
        aria-current={viewed || undefined}
        data-settled={faded || undefined}
        data-unread={thread.unread || undefined}
        aria-label={`${title}${thread.unread ? ", unread" : ""}, ${display.label}${where}${lastActive === "" ? "" : `, ${lastActive}`}`}
        title={`${title}\n${state}${lastActive === "" ? "" : ` · ${lastActive}`}${machine === undefined ? "" : `\n${machine.hint}`}`}
        aria-keyshortcuts="Shift+F10"
        onClick={() => openThread(thread.id)}
        onKeyDown={rowMenuKeys}
        className={cn(ROW, CURRENT_ROW, faded && SETTLED)}
      >
        <span
          aria-hidden
          data-working={display.working || undefined}
          className={cn(
            DOT,
            "rounded-full bg-current",
            // A dot is a mark, not words: needs-you takes its clean ui-grade amber.
            display.tone === "text-status-needs" ? "text-status-needs-mark" : display.tone,
            display.working && "gram-working",
          )}
        />
        {/* Like every row: one line, its title cut at its end with the whole on hover. At its
            edge, what needs you or failed in words; else its dot says its state, and the edge its
            last activity (none while it works). Its hover says its state. */}
        <span className={cn(ROW_TITLE, thread.unread && UNREAD_TITLE)}>{title}</span>
        <span data-testid="overview-solo-status" className={ROW_TRAIL}>
          <MachineMarker
            hostId={hostId}
            show={alarm ? "glyph" : "name"}
            hover="none"
            testId="overview-solo-machine"
          />
          {machine !== undefined && !alarm && !display.working && <span aria-hidden>·</span>}
          {alarm ? (
            <span
              className={cn(
                "truncate",
                display.tone === "text-status-needs" ? "text-status-needs" : "text-destructive",
              )}
            >
              {display.label}
            </span>
          ) : (
            !display.working && (
              <span className="shrink-0 tabular-nums">
                {formatRelative(thread.lastActivityAt, now)}
              </span>
            )
          )}
        </span>
      </button>
    </RowMenu>
  );
}
