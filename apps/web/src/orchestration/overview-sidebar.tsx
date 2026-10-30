import { PreviewCard } from "@base-ui/react/preview-card";
import {
  STATION_LABELS,
  type FeatureCardHeld,
  type OrchestratorLedger,
  type ThreadId,
  type ThreadSummary,
  type WorkspaceId,
  type WorkspaceState,
} from "@gram/contracts";
import { useParams } from "@tanstack/react-router";
import { ChevronDown, PanelLeftClose, PanelLeftDashed } from "lucide-react";
import {
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
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { useShortcutHint, withHint } from "@/keyboard/use-shortcut-hint";
import { formatClockTime, formatRelative } from "@/lib/time";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { revealVirtualRow, virtualRowOf, VirtualRows } from "@/lib/virtual-rows";
import { PresenceItem, PresenceList, Swap } from "@/motion";
import { CARD_SURFACE } from "@/reviews/pr-display";
import { focusLost } from "@/lib/use-return-focus";
import { focusSidebar, overviewStops } from "@/shell/focus-regions";
import { useOpenThread } from "@/shell/thread-switcher";
import { TopLeftNav } from "@/shell/top-left-nav";
import { useSwitchWorkspace } from "@/shell/workspace-switcher";
import {
  activityLine,
  settledRow,
  SETTLED_AFTER_MS,
  statusHint,
  threadStatusOf,
} from "@/sidebar/status";
import { overviewFoldKey, useLayoutStore, type ShellFit } from "@/stores/layout";
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
import { doneSoloThreads, parkedSoloThreads, soloThreads } from "@/views/solo-threads";
import { useViewWorkspace } from "@/views/view-workspace";

import { askKeysByThread } from "./ask-model";
import { NewEntryMenu } from "./new-entry-menu";
import { useWorkspaceAsks } from "./ask-stack";
import { PAUSE_WORD, useWorkerPause, WorkerPauseMark, type WorkerPauseState } from "./worker-pause";
import { keepBeside } from "./beside-store";
import { PrChip } from "./feature-card";
import { RAIL_TONES } from "./feature-sheet";
import { OverviewDoneToday, OverviewFoot, OverviewPullRequests } from "./overview-extras";
import { ledgerSlotsText } from "./overview-extras-model";
import {
  foldByKey,
  nowLineShown,
  orchestratorHover,
  orchestratorLine,
  overviewFeatures,
  overviewState,
  rowTone,
  stateWordShown,
  workLineText,
  type OverviewFeature,
  type OverviewState,
  type OverviewWorkerRow,
  type ReportNext,
  type RunningWorker,
} from "./overview-model";
import { ROW, Section, SETTLED, STOP } from "./overview-section";
import { WorkerPrChips } from "./overview-pr-chips";
import { peek } from "./peek-store";
import { TONE_DOT, type RailTone } from "./rail-model";
import { orchestratorOf, threadWorking, workingWorkerThreads } from "./tree-model";
import { useFeatureCards } from "./use-feature-cards";
import { NeedsYouPopover } from "./needs-you-popover";
import { useNeedsYou } from "./use-needs-you";
import { useWorkerTally, useWorkspaceStatuses } from "./use-workspace-statuses";
import { WorkspaceMenuItems } from "./workspace-menu-items";
import { useOrchestratorLedger, useOrchestratorLedgers, useWorkspaces } from "./use-orchestration";
import { workerActivities, workerTones } from "./workers-model";

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
  // The workers the ledger has are the live ones: a worker closed with its worktree is gone from it.
  const ledger = useOrchestratorLedger(workspaceId).data;
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
  const tones = useThreadsStore(
    useSame(
      (s) =>
        workerTones(
          ledger,
          workingWorkerThreads(s.byId, s.statusDetail, workspaceId).map((t) => t.thread.id),
          { byId: s.byId, statusDetail: s.statusDetail, asking },
        ).tones,
    ),
  );
  return useMemo(() => {
    const running: RunningWorker[] = [];
    for (let i = 0; i + 2 < flat.length; i += 3) {
      running.push({ threadId: flat[i] as ThreadId, title: flat[i + 1]!, feature: flat[i + 2]! });
    }
    const keys = askKeysByThread(asks ?? []);
    const live =
      ledger === undefined
        ? undefined
        : new Set(
            ledger.features.flatMap((feature) => feature.workers.map((worker) => worker.threadId)),
          );
    const held = new Set(
      ledger?.features.flatMap((feature) =>
        feature.workers.filter((worker) => worker.userIntervened).map((worker) => worker.threadId),
      ),
    );
    const reports = new Map<ThreadId, ReportNext>();
    for (const worker of ledger?.features.flatMap((feature) => feature.workers) ?? []) {
      const report = worker.lastReport;
      if (report !== undefined) {
        reports.set(worker.threadId, { at: report.at, nextStep: report.evidence?.nextStep });
      }
    }
    return overviewFeatures(cards, keys, live, running, held, activities, reports, tones);
  }, [cards, asks, ledger, flat, activities, tones]);
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

/** The Orchestrator layout's left column: what needs you, the orchestrators and the solo threads. */
export function OverviewSidebar() {
  const hideHint = useShortcutHint("sidebar.toggle");
  // The optional sections Settings → General turned off.
  const hidden = useLayoutStore((s) => s.overviewHidden);
  return (
    <aside
      aria-label="Overview"
      data-testid="overview-sidebar"
      data-surface="chrome"
      {...{ [OVERVIEW_ROOT]: "open" }}
      className="flex min-h-0 flex-1 flex-col border-r border-border bg-sidebar text-sidebar-foreground"
    >
      {/* The title bar's height. Hide sidebar leads, after macOS's window buttons, in the spot the
          title bar's Show sidebar takes while it is hidden, so the toggle never moves. Too narrow
          for them all beside the buttons, the rest wrap to a row below rather than clip. */}
      <div className="flex min-h-(--titlebar-height) shrink-0 flex-wrap content-start items-center gap-1 px-2 py-2 pl-[max(--spacing(2),var(--window-lights-inset))] [-webkit-app-region:drag]">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Hide sidebar"
          data-testid="overview-hide"
          title={withHint("Hide sidebar", hideHint)}
          className="text-muted-foreground [-webkit-app-region:no-drag]"
          onClick={toggleOverviewSidebar}
        >
          <PanelLeftClose />
        </Button>
        <TopLeftNav />
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Compact overview"
          data-testid="overview-compact"
          title="Compact overview"
          className="text-muted-foreground [-webkit-app-region:no-drag]"
          onClick={() => switchOverview("compact")}
        >
          <PanelLeftDashed />
        </Button>
        <NewEntryMenu />
      </div>
      <div
        onKeyDown={overviewKeys}
        className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto overscroll-contain px-2 pt-1 pb-3 text-[13px]"
      >
        <NeedsYou />
        <Orchestrators />
        {!hidden.includes("solo") && <SoloThreads />}
        {!hidden.includes("pullRequests") && <OverviewPullRequests />}
        {!hidden.includes("doneToday") && <OverviewDoneToday />}
      </div>
      {!hidden.includes("usage") && <OverviewFoot />}
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
        mode === "compact" ? '[data-testid="overview-expand"]' : '[data-testid="overview-compact"]',
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
 * The pill: what needs you across every workspace, which opens the Needs you popover under it. Its
 * shortcut is on its hover.
 */
function NeedsYou() {
  const { count, label, hint } = useNeedsYou();
  const words = count > 0 ? `${count} ${count === 1 ? "needs" : "need"} you` : "Nothing needs you";
  // Nothing waiting, it stays as quiet grey words, so the column doesn't jump.
  return (
    <NeedsYouPopover
      anchor="overview"
      trigger={
        <button
          type="button"
          {...{ [STOP]: "" }}
          data-testid="overview-needs-you"
          data-count={count}
          aria-label={withHint(words, hint)}
          title={withHint(label, hint)}
          className={cn(
            "flex w-full shrink-0 items-center gap-2 rounded-(--radius-md) px-2.5 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
            count > 0
              ? "bg-status-needs/10 font-medium text-status-needs hover:bg-status-needs/15"
              : "text-muted-foreground hover:bg-sidebar-row-hover",
          )}
        >
          {count > 0 && (
            <span aria-hidden className="size-2 shrink-0 rounded-full bg-status-needs" />
          )}
          <span className="min-w-0 flex-1 truncate">{words}</span>
        </button>
      }
    />
  );
}

/** One line per workspace, in the switcher's order, each folded or open into its live workers. */
function Orchestrators() {
  const workspaces = useWorkspaces();
  const current = useViewWorkspace();
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
  // Each workspace's asks, and the workers they wait on.
  const waiting = useMemo(
    () =>
      new Map(
        asks.map((each) => [
          each.workspaceId as string,
          {
            count: each.asks.length,
            asking: new Set(askKeysByThread(each.asks).keys()),
          },
        ]),
      ),
    [asks],
  );
  // Every line counts its workers from its ledger, folded or open, so both say the same.
  const workspaceIds = useMemo(() => workspaces.map((state) => state.workspace.id), [workspaces]);
  const ledgers = useOrchestratorLedgers(workspaceIds);
  if (workspaces.length === 0) return null;
  return (
    <Section id="orchestrators" title="Orchestrators" count={workspaces.length}>
      {workspaces.map((state) => {
        const id = state.workspace.id;
        return (
          <WorkspaceRow
            key={id}
            state={state}
            here={id === current?.workspace.id}
            asks={waiting.get(id)?.count ?? 0}
            asking={waiting.get(id)?.asking ?? NO_ASKING}
            word={overviewState(statuses.get(id), state.paused !== undefined)}
            ledger={ledgers.get(id)}
          />
        );
      })}
    </Section>
  );
}

const NO_ASKING: ReadonlySet<ThreadId> = new Set();

/**
 * A workspace's line, and under it, open, its features with their live workers. Every workspace's
 * line has the same form, folded or open, with no worker or many: its dot, its name, one number,
 * the asks that need you, and the chevron. Paused or parked, it says that too; the rest (its live
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
  const folded = useLayoutStore((s) => s.workspacesCollapsedNodes.includes(foldKey));
  const fold = (to: boolean) => useLayoutStore.getState().toggleWorkspaceNode(foldKey, to);
  const bodyId = useId();
  const hover = orchestratorHover(word, { live, working, asks }, ledgerSlotsText(ledger));
  const line = orchestratorLine(word, { working, asks });
  const name = state.workspace.name;
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
              )}
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
            aria-label={`${name}, ${hover}`}
            title={hover}
            onClick={() => switchTo(state.workspace)}
            onKeyDown={onKeyDown}
            className={cn(ROW, "min-w-0 flex-1")}
          >
            <span
              aria-hidden
              data-testid="overview-workspace-dot"
              data-working={line.pulse || undefined}
              className={cn(
                "size-2 justify-self-center rounded-full",
                line.dot,
                line.pulse && "gram-working",
              )}
            />
            <span className="truncate font-medium">{name}</span>
            <span className="flex items-center gap-1.5">
              {stateWordShown(word) && (
                <span
                  data-testid="overview-workspace-state"
                  className="text-xs whitespace-nowrap text-muted-foreground"
                >
                  {word}
                </span>
              )}
              {asks > 0 && (
                <span
                  data-testid="overview-workspace-asks"
                  className="min-w-4.5 rounded-full bg-status-needs/12 px-1.5 text-center text-[11px] leading-4.5 font-semibold text-status-needs tabular-nums"
                >
                  {asks}
                </span>
              )}
            </span>
          </button>
          <button
            type="button"
            data-testid="overview-workspace-fold"
            aria-expanded={!folded}
            aria-controls={bodyId}
            aria-label={folded ? `Show ${name}'s workers` : `Hide ${name}'s workers`}
            title={folded ? "Show workers" : "Hide workers"}
            onClick={() => fold(!folded)}
            className="grid size-6 shrink-0 cursor-default place-items-center rounded-(--radius-sm) text-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronDown
              aria-hidden
              className={cn(
                "size-3.5 transition-transform duration-(--dur-fast)",
                folded && "-rotate-90",
              )}
            />
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent data-testid="overview-workspace-menu">
          <WorkspaceMenuItems state={state} />
        </ContextMenuContent>
      </ContextMenu>
      <div id={bodyId} hidden={folded} className="flex flex-col">
        {/* The current one's are there folded too, for ⌘J to open it on its first worker. */}
        {(here || !folded) && <WorkspaceBody workspaceId={id} />}
      </div>
    </div>
  );
}

/** An open workspace's features and their live workers, from its cards. */
function WorkspaceBody({ workspaceId }: { workspaceId: WorkspaceId }) {
  const features = useOverviewFeatures(workspaceId);
  return <WorkspaceFeatures workspaceId={workspaceId} features={features} />;
}

/** The agent the workspace's orchestrator runs, which its workers' rows leave out when they share it. */
export const useOrchestratorAgent = (workspaceId: WorkspaceId): string | undefined => {
  const workspace = useWorkspaces().find((state) => state.workspace.id === workspaceId)?.workspace;
  return useThreadsStore(
    (s) =>
      orchestratorOf(Object.values(s.byId), workspace ?? { id: workspaceId })?.thread.model?.agent,
  );
};

/** An open workspace: its features with their live workers, each feature's stage on its hover. */
function WorkspaceFeatures({
  workspaceId,
  features,
}: {
  workspaceId: WorkspaceId;
  features: readonly OverviewFeature[];
}) {
  const orchestratorAgent = useOrchestratorAgent(workspaceId);
  if (features.length === 0) {
    return (
      <OrchestratorAtWork workspaceId={workspaceId} className="pb-1 pl-6">
        No workers now.
      </OrchestratorAtWork>
    );
  }
  return (
    <div
      data-testid="overview-features"
      className="mb-1 ml-3 flex flex-col gap-px border-l border-border pl-2"
    >
      {features.map((feature) => (
        <section
          key={feature.feature}
          aria-label={`${feature.feature}, ${STATION_LABELS[feature.station]}`}
          data-testid="overview-feature"
          data-feature={feature.feature}
          data-station={feature.station}
          className="flex flex-col"
        >
          <h3
            title={`Stage: ${STATION_LABELS[feature.station]}`}
            className="truncate px-1.5 pt-1.5 pb-0.5 text-xs font-medium text-muted-foreground"
          >
            {feature.feature}
          </h3>
          <PresenceList>
            {feature.rows.map((row) => (
              <PresenceItem key={row.threadId}>
                <WorkerRow
                  row={row}
                  feature={feature.feature}
                  updatedAt={feature.updatedAt}
                  orchestratorAgent={orchestratorAgent}
                />
              </PresenceItem>
            ))}
          </PresenceList>
          {feature.held.map((held) => (
            <HeldRow key={held.id} held={held} />
          ))}
        </section>
      ))}
    </div>
  );
}

/**
 * A live worker: a click opens it, where any ask it has shows, ⌥-click peeks and ⌘/Ctrl-click keeps
 * it beside; a right-click (or Shift+F10) opens its menu, and it drags onto a grid pane. Its agent's
 * glyph shows only when it isn't its orchestrator's, and a second line only for an ask, a failure or
 * real activity; its name and hover card keep the rest. In the compact rail's flyout it has no hover
 * card of its own (`card={false}`), the flyout being one.
 */
export function WorkerRow({
  row,
  feature,
  updatedAt,
  orchestratorAgent,
  card = true,
}: {
  row: OverviewWorkerRow;
  feature: string;
  updatedAt: number;
  orchestratorAgent: string | undefined;
  card?: boolean;
}) {
  const openThread = useOpenThread();
  const lastActivity = useThreadsStore((s) => s.byId[row.threadId]?.thread.lastActivityAt);
  const agent = useThreadsStore((s) => s.byId[row.threadId]?.thread.model?.agent);
  const status = useThreadsStore((s) => s.byId[row.threadId]?.status);
  const busy = useThreadsStore((s) => busyThread(s, row.threadId));
  const pause = useWorkerPause(row.threadId, status, row.held);
  const asking = row.askKey !== undefined;
  // One tone for its dot, its words and its count on the orchestrator's line, as the Board has it.
  const tone = rowTone(row, { status, working: busy });
  const dot = TONE_DOT[tone];
  const working = tone === "working";
  // Ages to the minute.
  const now = useNow(true, undefined, 60_000);
  const settled =
    tone === "idle" &&
    pause === undefined &&
    lastActivity !== undefined &&
    now - lastActivity >= SETTLED_AFTER_MS;
  const facts = [
    row.title,
    ...(pause === undefined ? [] : [PAUSE_WORD[pause.state]]),
    row.now,
    ...(agent === undefined ? [] : [agentLabel(agent)]),
    ...(lastActivity === undefined ? [] : [`last active ${formatClockTime(lastActivity)}`]),
  ];
  const onClick = (event: MouseEvent<HTMLElement>) => {
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
    "aria-label": facts.join(", "),
    // The compact rail's flyout has no card to say them.
    title: card ? undefined : facts.join(" · "),
    "aria-keyshortcuts": "Shift+F10",
    onClick,
    onKeyDown: rowMenuKeys,
    ...threadDragProps(row.threadId),
    className: cn(ROW, settled && SETTLED),
  };
  const body = (
    <>
      <span
        aria-hidden
        data-testid="overview-worker-dot"
        data-tone={tone}
        data-working={working || undefined}
        className={cn("size-2 justify-self-center rounded-full", dot, working && "gram-working")}
      />
      <span data-testid="overview-worker-title" className="truncate text-foreground">
        {row.title}
      </span>
      <span className="flex items-center gap-1.5 text-muted-foreground">
        {pause !== undefined && <WorkerPauseMark pause={pause} />}
        {agent !== undefined && agent !== orchestratorAgent && (
          <AgentIcon agent={agent} className="size-3" />
        )}
      </span>
      {/* At work, the thread's own step and what it runs, as its tree row says them, else the
          card's now line. An ask or a failure is all the row says. */}
      {working && !asking && !row.failed ? (
        <WorkerStep row={row} />
      ) : (
        <WorkerNow row={row} asking={asking} />
      )}
    </>
  );
  // The PR chips sit under the row, outside its button: each is a button of its own.
  const chips = <WorkerPrChips threadId={row.threadId} cardPrs={row.prs} card={card} />;
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
      <PreviewCard.Root>
        <PreviewCard.Trigger delay={250} render={<button {...props} />}>
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
              className={cn(CARD_SURFACE, "flex w-72 flex-col gap-1.5 p-3 text-sm")}
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
              />
            </PreviewCard.Popup>
          </PreviewCard.Positioner>
        </PreviewCard.Portal>
      </PreviewCard.Root>
      {chips}
    </RowMenu>
  );
}

/** A worker's card now line under its title, when it says more than the row's dot. */
function WorkerNow({ row, asking }: { row: OverviewWorkerRow; asking: boolean }) {
  if (!nowLineShown(row)) return null;
  return (
    <Swap
      swapKey={row.now}
      className={cn(
        "col-span-2 col-start-2 min-w-0 truncate text-xs",
        asking ? "text-status-needs" : row.failed ? "text-destructive" : "text-muted-foreground",
      )}
    >
      <span data-testid="overview-worker-now" className="truncate">
        {row.now}
      </span>
    </Swap>
  );
}

/** What a worker at work is doing, in one line; with no step to say, its now line. */
function WorkerStep({ row }: { row: OverviewWorkerRow }) {
  const step = useWorkLine(row.threadId, row.report);
  if (step === undefined) return <WorkerNow row={row} asking={false} />;
  return (
    <span
      data-testid="overview-worker-step"
      className="col-span-2 col-start-2 min-w-0 truncate text-xs text-muted-foreground"
    >
      {step}
    </span>
  );
}

/** A thread's row with its context menu: a right-click anywhere on it, its PR chips included. */
function RowMenu({ menu, children }: { menu: ReactNode; children: ReactNode }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger className="flex flex-col">{children}</ContextMenuTrigger>
      <ContextMenuContent>{menu}</ContextMenuContent>
    </ContextMenu>
  );
}

/** A worker on hover: its feature, agent, title, station and now line, first PR and last activity. */
function WorkerCard({
  row,
  feature,
  agent,
  lastActivity,
  dot,
  tone,
  asking,
  pause,
}: {
  row: OverviewWorkerRow;
  feature: string;
  agent: string | undefined;
  lastActivity: number;
  dot: string;
  tone: RailTone;
  asking: boolean;
  pause: WorkerPauseState | undefined;
}) {
  const time = formatClockTime(lastActivity);
  return (
    <>
      <p
        data-testid="overview-worker-card-feature"
        className="truncate text-xs text-muted-foreground"
      >
        {feature}
        {agent !== undefined && ` · ${agentLabel(agent)}`}
      </p>
      <p data-testid="overview-worker-card-title" className="font-medium">
        {row.title}
      </p>
      <p className="flex min-w-0 items-center gap-1.5 text-xs">
        <span
          aria-hidden
          title={RAIL_TONES[tone].label}
          className={cn("size-1.5 shrink-0 rounded-full", dot)}
        />
        <span data-testid="overview-worker-card-station" className="shrink-0 text-foreground/80">
          {row.stationLabel}
        </span>
        <span
          data-testid="overview-worker-card-now"
          className={cn(
            "min-w-0 truncate",
            asking
              ? "text-status-needs"
              : row.failed
                ? "text-destructive"
                : "text-muted-foreground",
          )}
        >
          {row.now}
        </span>
        <time
          data-testid="overview-worker-card-time"
          dateTime={new Date(lastActivity).toISOString()}
          title={`Last activity ${time}`}
          className="ml-auto shrink-0 text-muted-foreground tabular-nums"
        >
          {time}
        </time>
      </p>
      {pause !== undefined && (
        <p
          data-testid="overview-worker-card-paused"
          className="flex items-center gap-1.5 text-xs text-status-needs"
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
      <p className="mt-0.5 flex gap-3 border-t border-border pt-1.5 text-[11px] text-muted-foreground">
        <span>Click · open</span>
        <span>⌥-click · peek</span>
        <span>⌘-click · beside</span>
      </p>
    </>
  );
}

/** A brief held until a usage limit resets: no thread yet, so nothing to open. */
function HeldRow({ held }: { held: FeatureCardHeld }) {
  const now = useNow(true, undefined, 60_000);
  return (
    <div
      data-testid="overview-held"
      data-held-id={held.id}
      className="grid grid-cols-[0.625rem_minmax(0,1fr)] items-center gap-x-2 px-1.5 py-1"
    >
      <span
        aria-hidden
        className="size-2 justify-self-center rounded-full border border-dashed border-muted-foreground"
      />
      <span className="truncate text-muted-foreground">{held.title}</span>
      <span className="col-start-2 truncate text-xs text-muted-foreground tabular-nums">
        held · {heldStateText(held, now)}
      </span>
    </div>
  );
}

/** A solo row's height before it draws, and the space between rows (the section's `gap-px`). */
const SOLO_ROW = 28;
const SOLO_GAP = 1;

const soloKey = (summary: ThreadSummary) => summary.thread.id;

/**
 * The threads outside any workspace, latest first, the parked and the done ones folded under them: a
 * click opens one.
 */
function SoloThreads() {
  const workspaces = useWorkspaces();
  const ids = useMemo(
    () => new Set(workspaces.map((state) => state.workspace.id as string)),
    [workspaces],
  );
  // The solo threads, by identity and order: a worker's update re-renders none of them.
  const solo = useThreadsStore(useShallow((s) => soloThreads(Object.values(s.byId), ids)));
  const parked = useThreadsStore(useShallow((s) => parkedSoloThreads(Object.values(s.byId), ids)));
  const done = useThreadsStore(useShallow((s) => doneSoloThreads(Object.values(s.byId), ids)));
  const viewed = useParams({ strict: false }).threadId;
  if (solo.length + parked.length + done.length === 0) return null;
  return (
    <Section id="solo" title="Solo threads" count={solo.length}>
      {solo.length > 0 && <SoloList threads={solo} viewed={viewed} />}
      {parked.length > 0 && <FoldedThreads kind="parked" threads={parked} viewed={viewed} />}
      {done.length > 0 && <FoldedThreads kind="done" threads={done} viewed={viewed} />}
    </Section>
  );
}

/** Solo rows, drawn only near the view: there may be hundreds. */
function SoloList({
  threads,
  viewed,
  settled = false,
}: {
  threads: readonly ThreadSummary[];
  viewed: string | undefined;
  /** All of them grey until hovered, whatever their age: the Done line's. */
  settled?: boolean;
}) {
  return (
    <VirtualRows
      items={threads}
      rowKey={soloKey}
      estimate={SOLO_ROW}
      gap={SOLO_GAP}
      current={threads.findIndex((summary) => summary.thread.id === viewed)}
    >
      {(summary) => <SoloRow summary={summary} settled={settled} />}
    </VirtualRows>
  );
}

const FOLDED = {
  parked: { label: "Parked", hint: undefined },
  done: { label: "Done", hint: "Threads marked done. Reopen one from its menu." },
} as const;

/**
 * The parked or done solo threads behind one line, folded until opened: out of the way, still a
 * click away.
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
        className="flex h-6 w-full items-center gap-1.5 rounded-(--radius-sm) px-1.5 text-left text-xs text-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronDown
          aria-hidden
          className={cn(
            "size-3 shrink-0 transition-transform duration-(--dur-fast)",
            !open && "-rotate-90",
          )}
        />
        <span className="flex-1">{label}</span>
        {!open && <span className="tabular-nums">{threads.length}</span>}
      </button>
      <div id={rows} hidden={!open} className="flex flex-col gap-px">
        <SoloList threads={threads} viewed={viewed} settled={kind === "done"} />
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
 * What a thread at work is doing, as its tree row says it: its plan's step and what it runs, else
 * what it runs. An orchestrator has no plan headline, so its line is always what it runs. A
 * needs-you headline is left to the ask stack and the row's glyph.
 */
const workLineOf = (s: ThreadsState, threadId: ThreadId): string | undefined => {
  const summary = s.byId[threadId];
  if (summary === undefined) return undefined;
  const activity = activityLine(summary.status, s.statusDetail[threadId], summary.activity);
  const display = threadStatusOf(summary, s.statusDetail[threadId]);
  if (!display.working && display.running === undefined) return undefined;
  return activity ?? statusHint(display, activity);
};

const useWorkLine = (threadId: ThreadId, report?: ReportNext | undefined): string | undefined => {
  const { headline } = useThreadHeadline(threadId);
  const running = useThreadsStore((s) => workLineOf(s, threadId));
  const planAt = useThreadsStore((s) => s.byId[threadId]?.plan?.updatedAt);
  return workLineText(headline, planAt, report, running);
};

function WorkLine({ threadId }: { threadId: ThreadId }) {
  return <>{useWorkLine(threadId)}</>;
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
    return <p className={cn("text-xs text-muted-foreground", className)}>{children}</p>;
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
      title={at === undefined ? undefined : `Last activity ${formatClockTime(at)}`}
      onClick={onClick}
      className={cn(
        "flex w-full min-w-0 cursor-default flex-col rounded-(--radius-sm) text-left text-xs outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      <span className="flex w-full min-w-0 items-center gap-1.5">
        <span
          aria-hidden
          className="size-1.5 shrink-0 rounded-full bg-status-working gram-working"
        />
        <span className="truncate text-foreground">{own ? "Orchestrator" : title}</span>
        {at !== undefined && <span className="sr-only">, last active {formatClockTime(at)}</span>}
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
  const viewed = useParams({ strict: false }).threadId === summary.thread.id;
  // Ages to the minute.
  const now = useNow(true, undefined, 60_000);
  const { thread } = summary;
  const detail = useThreadsStore((s) => s.statusDetail[thread.id]);
  const display = threadStatusOf(summary, detail);
  const title = threadDisplayTitle(thread);
  const active = display.working ? `Last activity ${formatClockTime(thread.lastActivityAt)}` : "";
  const faded = settled || settledRow(summary.status, display, thread.lastActivityAt, now);
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
        aria-label={`${title}, ${display.label}${active === "" ? "" : `, ${active}`}`}
        title={active === "" ? undefined : active}
        aria-keyshortcuts="Shift+F10"
        onClick={() => openThread(thread.id)}
        onKeyDown={rowMenuKeys}
        className={cn(ROW, "aria-current:bg-sidebar-row-active", faded && SETTLED)}
      >
        <span
          aria-hidden
          data-working={display.working || undefined}
          className={cn(
            "size-2 justify-self-center rounded-full bg-current",
            display.tone,
            display.working && "gram-working",
          )}
        />
        <span className="truncate">{title}</span>
        {!display.working && (
          <span className="text-xs text-muted-foreground tabular-nums">
            {formatRelative(thread.lastActivityAt, now)}
          </span>
        )}
      </button>
    </RowMenu>
  );
}
