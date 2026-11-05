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
import { ChevronDown, Hourglass, PanelLeftClose, PanelLeftDashed } from "lucide-react";
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
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { keyLabel } from "@/keyboard/registry";
import { useShortcutHint, withHint } from "@/keyboard/use-shortcut-hint";
import { formatRelative, formatStamp } from "@/lib/time";
import { useNow } from "@/lib/use-now";
import { EXPLAIN } from "@/lib/explain";
import { cn } from "@/lib/utils";
import { revealVirtualRow, virtualRowOf, VirtualRows } from "@/lib/virtual-rows";
import { PresenceItem, PresenceList, Swap } from "@/motion";
import { CARD_SURFACE } from "@/reviews/pr-display";
import { focusLost } from "@/lib/use-return-focus";
import { focusSidebar, overviewStops } from "@/shell/focus-regions";
import { useOpenThread } from "@/shell/thread-switcher";
import { TopLeftNav } from "@/shell/top-left-nav";
import { useSwitchWorkspace } from "@/shell/workspace-switcher";
import { activityLine, settledRow, SETTLED_AFTER_MS, threadStatusOf } from "@/sidebar/status";
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
import { parkedSoloThreads, soloThreads } from "@/views/solo-threads";
import { useViewSolo, useViewWorkspace } from "@/views/view-workspace";
import { useBeforeSetup } from "@/welcome/welcome";

import { useAnsweredWorkers } from "./needs-you-store";
import { askKeysByThread } from "./ask-model";
import { NewEntryMenu } from "./new-entry-menu";
import { OverviewEmptyHint } from "./overview-empty-hint";
import { useWorkspaceAsks } from "./ask-stack";
import { PAUSE_WORD, useWorkerPause, WorkerPauseMark, type WorkerPauseState } from "./worker-pause";
import { keepBeside } from "./beside-store";
import { PrChip } from "./feature-card";
import { RAIL_TONES } from "./feature-sheet";
import {
  OverviewDone,
  OverviewFoot,
  OverviewHistory,
  OverviewPullRequests,
  OverviewSearch,
} from "./overview-extras";
import { ledgerSlotsText } from "./overview-extras-model";
import {
  foldByKey,
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
  stateWordShown,
  steplessLine,
  workLineText,
  type OverviewFeature,
  type OverviewState,
  type OverviewWorkerRow,
  type ReportNext,
  type RunningWorker,
} from "./overview-model";
import { CURRENT_ROW, ROW, RowMenu, Section, SETTLED, STOP } from "./overview-section";
import { WorkerPrChips } from "./overview-pr-chips";
import { peek } from "./peek-store";
import { NESTED_TONE_DOT, type RailTone } from "./rail-model";
import { orchestratorOf, threadWorking, workingWorkerThreads } from "./tree-model";
import { useFeatureCards } from "./use-feature-cards";
import { useNeedsYouCounts, useNeedsYouPill } from "./use-needs-you";
import { useWorkerTally, useWorkspaceStatuses } from "./use-workspace-statuses";
import { WorkspaceMenuItems } from "./workspace-menu-items";
import { useOrchestratorLedger, useOrchestratorLedgers, useWorkspaces } from "./use-orchestration";
import { useOrchestratorWaiting, useWorkerWaitings } from "./use-waiting-on";
import type { WaitingOn } from "./waiting-on";
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
      running.push({ threadId: flat[i] as ThreadId, title: flat[i + 1]!, feature: flat[i + 2]! });
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
        reports.set(worker.threadId, { at: report.at, nextStep: report.evidence?.nextStep });
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

/** The Orchestrator layout's left column: what needs you, the orchestrators and the solo threads. */
export function OverviewSidebar() {
  const hideHint = useShortcutHint("sidebar.toggle");
  useRevealViewed();
  // The optional sections Settings → General turned off.
  const hidden = useLayoutStore((s) => s.overviewHidden);
  // Before any setup the welcome is the one thing to look at: no pull requests or usage beside it.
  const beforeSetup = useBeforeSetup();
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
      <div className="flex min-h-(--titlebar-height) shrink-0 flex-wrap content-start items-center gap-1 px-2 py-1.5 pl-[max(--spacing(2),var(--window-lights-inset))] [-webkit-app-region:drag]">
        <Button
          variant="ghost"
          size="icon-sm"
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
          size="icon-sm"
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
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-2 pt-1 pb-3 text-body"
      >
        {/* What needs you, and the way to find anything else, as one block at the top. */}
        <div className="flex flex-col gap-1">
          <NeedsYou />
          <OverviewSearch />
        </div>
        <Orchestrators />
        <OverviewEmptyHint />
        {!hidden.includes("solo") && <SoloThreads />}
        {!beforeSetup && !hidden.includes("pullRequests") && <OverviewPullRequests />}
        {!hidden.includes("doneToday") && <OverviewDone />}
      </div>
      {!hidden.includes("doneToday") && <OverviewHistory />}
      {!beforeSetup && !hidden.includes("usage") && <OverviewFoot />}
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
 * The pill: what needs you across every workspace, which opens the Inbox; the window's one global
 * count (the title bar's Inbox button shows none beside it). Its shortcut, and how much of it is
 * here and how much elsewhere, are on its hover.
 */
function NeedsYou() {
  const { count, scope: where, label, hint, openAsks } = useNeedsYouPill();
  // A true first run, with no thread yet, has nothing to need you: the welcome is the one thing
  // to look at, without a count beside it.
  if (useBeforeSetup()) return null;
  const words = count > 0 ? `${count} ${count === 1 ? "needs" : "need"} you` : "Nothing needs you";
  // Its scope and kinds are said on hover, so it reads beside a workspace's own count.
  const scope = count > 0 ? `${words} across all workspaces\n${where}` : words;
  // Nothing waiting, it stays as quiet grey words, so the column doesn't jump.
  return (
    <button
      type="button"
      {...{ [STOP]: "" }}
      data-testid="overview-needs-you"
      data-count={count}
      aria-label={withHint(words, hint)}
      title={`${withHint(label, hint)}\n${scope}`}
      onClick={openAsks}
      className={cn(
        "flex w-full shrink-0 items-center gap-2 rounded-(--radius-md) border px-2.5 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
        count > 0
          ? "border-status-needs-mark/60 font-medium text-status-needs hover:bg-status-needs-mark/10"
          : "border-transparent text-muted-foreground hover:bg-sidebar-row-hover",
      )}
    >
      {count > 0 && (
        <span aria-hidden className="size-2 shrink-0 rounded-full bg-status-needs-mark" />
      )}
      <span className="min-w-0 flex-1 truncate">{words}</span>
    </button>
  );
}

/** One line per workspace, in the switcher's order, each folded or open into its live workers. */
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
            asks={byWorkspace.get(id) ?? 0}
            asking={asking.get(id) ?? NO_ASKING}
            word={overviewState(statuses.get(id), state.paused !== undefined)}
            ledger={ledgers.get(id)}
          />
        );
      })}
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
  const folded = useLayoutStore((s) => s.workspacesCollapsedNodes.includes(foldKey));
  const fold = (to: boolean) => useLayoutStore.getState().toggleWorkspaceNode(foldKey, to);
  const bodyId = useId();
  // What its orchestrator waits on at rest, unless its pause or park holds everything anyway.
  const orchestratorWaiting = useOrchestratorWaiting(ledger);
  const waiting = stateWordShown(word) ? undefined : orchestratorWaiting;
  const summary = orchestratorHover(word, { live, working, asks }, ledgerSlotsText(ledger));
  const hover = waiting === undefined ? summary : `${summary}\nOrchestrator: ${waiting.hint}`;
  const line = orchestratorLine(word, { working, asks });
  const name = state.workspace.name;
  // Nothing under it, not even its orchestrator at work: one line, its name and "idle".
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
              className={cn(
                "size-2 justify-self-center rounded-full",
                line.dot,
                line.pulse && "gram-working",
              )}
            />
            <span className="flex min-w-0 items-baseline gap-1.5">
              <span className="truncate font-medium">{name}</span>
              {empty && (
                <span
                  data-testid="overview-workspace-idle"
                  className="shrink-0 text-meta text-muted-foreground"
                >
                  · idle
                </span>
              )}
            </span>
            <span className="flex items-center gap-1.5">
              {stateWordShown(word) && (
                <span
                  data-testid="overview-workspace-state"
                  className="text-meta whitespace-nowrap text-muted-foreground"
                >
                  {stateWord(word)}
                </span>
              )}
              {asks > 0 && (
                <span
                  data-testid="overview-workspace-asks"
                  className="min-w-4.5 rounded-full border border-status-needs-mark/70 px-1.5 text-center text-caption leading-4 font-semibold text-status-needs tabular-nums"
                >
                  {asks}
                </span>
              )}
            </span>
            {waiting !== undefined && (
              <WaitingLine waiting={waiting} testId="overview-orchestrator-waiting" />
            )}
          </button>
          <Hint
            label={folded ? `Show ${name}'s workers` : `Hide ${name}'s workers`}
            render={
              <button
                type="button"
                data-testid="overview-workspace-fold"
                aria-expanded={!folded}
                aria-controls={bodyId}
                aria-label={folded ? `Show ${name}'s workers` : `Hide ${name}'s workers`}
                onClick={() => fold(!folded)}
                className="grid size-7 shrink-0 cursor-default place-items-center rounded-(--radius-sm) text-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-foreground focus-visible:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring"
              />
            }
          >
            <ChevronDown
              aria-hidden
              className={cn(
                "size-3.5 transition-transform duration-(--dur-fast)",
                folded && "-rotate-90",
              )}
            />
          </Hint>
        </ContextMenuTrigger>
        <ContextMenuContent data-testid="overview-workspace-menu">
          <WorkspaceMenuItems state={state} />
        </ContextMenuContent>
      </ContextMenu>
      <div id={bodyId} hidden={folded} className="flex flex-col">
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

/** The agent the workspace's orchestrator runs, which its workers' rows leave out when they share it. */
export const useOrchestratorAgent = (workspaceId: WorkspaceId): string | undefined => {
  const workspace = useWorkspaces().find((state) => state.workspace.id === workspaceId)?.workspace;
  return useThreadsStore(
    (s) =>
      orchestratorOf(Object.values(s.byId), workspace ?? { id: workspaceId })?.thread.model?.agent,
  );
};

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
  const orchestratorAgent = useOrchestratorAgent(workspaceId);
  const items = useMemo(() => overviewItems(features), [features]);
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
      className="mb-1 ml-3 flex flex-col gap-px border-l border-border pl-2"
    >
      <PresenceList>
        {items.map((item) =>
          item.kind === "worker" ? (
            <PresenceItem key={item.row.threadId}>
              <WorkerRow
                row={item.row}
                feature={item.feature}
                updatedAt={item.updatedAt}
                orchestratorAgent={orchestratorAgent}
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
  const viewed = useParams({ strict: false }).threadId === row.threadId;
  const lastActivity = useThreadsStore((s) => s.byId[row.threadId]?.thread.lastActivityAt);
  const agent = useThreadsStore((s) => s.byId[row.threadId]?.thread.model?.agent);
  const status = useThreadsStore((s) => s.byId[row.threadId]?.status);
  const busy = useThreadsStore((s) => busyThread(s, row.threadId));
  const pause = useWorkerPause(row.threadId, status, row.held);
  const asking = row.askKey !== undefined;
  // One tone for its dot, its words and its count on the orchestrator's line, as the Board has it.
  const tone = rowTone(row, { status, working: busy });
  const dot = NESTED_TONE_DOT[tone];
  const working = tone === "working";
  const waiting = rowWaiting(row, tone);
  // Ages to the minute.
  const now = useNow(true, undefined, 60_000);
  const settled =
    tone === "idle" &&
    pause === undefined &&
    lastActivity !== undefined &&
    now - lastActivity >= SETTLED_AFTER_MS;
  // Its session is opening: nothing has run yet, so neither "Working" nor "Idle" is true.
  const starting = status === "starting" && !asking && !row.failed;
  const facts = [
    row.title,
    ...(pause === undefined ? [] : [PAUSE_WORD[pause.state]]),
    starting ? STARTING : (waiting?.label ?? row.now),
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
    // Its title may take two lines, so a long one with an ask under it still reads whole; the dot
    // and marks sit on its first line.
    className: cn(ROW, "items-start", CURRENT_ROW, settled && SETTLED),
  };
  const body = (
    <>
      <span
        aria-hidden
        data-testid="overview-worker-dot"
        data-tone={tone}
        data-working={working || undefined}
        className={cn(DOT_ON_FIRST_LINE, "rounded-full", dot, working && "gram-working")}
      />
      <span
        data-testid="overview-worker-title"
        className="line-clamp-2 [overflow-wrap:anywhere] text-foreground"
      >
        {row.title}
      </span>
      <span className="flex h-lh items-center gap-1.5 text-muted-foreground">
        {pause !== undefined && <WorkerPauseMark pause={pause} />}
        {agent !== undefined && agent !== orchestratorAgent && (
          <AgentIcon agent={agent} className="size-3" />
        )}
      </span>
      {/* At work, the thread's own step and what it runs, as its tree row says them, else the
          card's now line. An ask or a failure is all the row says. */}
      {starting ? (
        <span
          data-testid="overview-worker-starting"
          className="col-span-2 col-start-2 min-w-0 truncate text-meta text-muted-foreground"
        >
          {STARTING}
        </span>
      ) : working && !asking && !row.failed ? (
        <WorkerStep row={row} />
      ) : waiting !== undefined ? (
        <WaitingLine waiting={waiting} testId="overview-worker-waiting" />
      ) : (
        <WorkerNow row={row} asking={asking} tone={tone} />
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

/** A worker's line while its agent session opens, before its first turn runs. */
const STARTING = "Starting…";

/** A row's 8 px dot, centred on its title's first line however many lines the title takes. */
const DOT_ON_FIRST_LINE = "size-2 self-start justify-self-center mt-[calc((1lh-0.5rem)/2)]";

/**
 * A worker's card now line under its title, when it says more than the row's dot; else its tone in
 * a word, so every live row keeps the same status line under its title.
 */
function WorkerNow({
  row,
  asking,
  tone,
}: {
  row: OverviewWorkerRow;
  asking: boolean;
  tone: RailTone;
}) {
  if (!nowLineShown(row)) {
    return (
      <span
        data-testid="overview-worker-state"
        className="col-span-2 col-start-2 min-w-0 truncate text-meta text-muted-foreground"
      >
        {RAIL_TONES[tone].label}
      </span>
    );
  }
  return (
    <Swap
      swapKey={row.now}
      className={cn(
        "col-span-2 col-start-2 min-w-0 truncate text-meta",
        asking ? "text-foreground" : row.failed ? "text-destructive" : "text-muted-foreground",
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
  if (step === undefined) return <WorkerNow row={row} asking={false} tone="working" />;
  // The plan's step count only on hover: the row says what it does.
  const shown = steplessLine(step);
  return (
    <span
      data-testid="overview-worker-step"
      title={shown === step ? undefined : step}
      className="col-span-2 col-start-2 min-w-0 truncate text-meta text-muted-foreground"
    >
      {shown}
    </span>
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
}) {
  const time = formatStamp(lastActivity);
  return (
    <>
      <p
        data-testid="overview-worker-card-feature"
        className="truncate text-meta text-muted-foreground"
      >
        {feature}
        {agent !== undefined && ` · ${agentLabel(agent)}`}
      </p>
      <p data-testid="overview-worker-card-title" className="font-medium">
        {row.title}
      </p>
      <p className="flex min-w-0 items-center gap-1.5 text-meta">
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
            asking ? "text-foreground" : row.failed ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {waiting?.label ?? row.now}
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
      <p className="mt-0.5 flex gap-3 border-t border-border pt-1.5 text-meta text-muted-foreground">
        <span>Click · open</span>
        <span>{keyLabel("⌥-click")} · peek</span>
        <span>{keyLabel("⌘-click")} · beside</span>
      </p>
    </>
  );
}

/**
 * What a worker or an orchestrator at rest waits on, as a row's second line: an hourglass and the
 * short label, muted, as calm as an idle row. The whole list is on the row's hover.
 */
function WaitingLine({ waiting, testId }: { waiting: WaitingOn; testId: string }) {
  return (
    <Swap
      swapKey={waiting.label}
      className="col-span-2 col-start-2 min-w-0 truncate text-meta text-muted-foreground"
    >
      <span
        data-testid={testId}
        data-kind={waiting.kind}
        className="flex min-w-0 items-center gap-1"
      >
        <Hourglass aria-hidden className="size-3.5 shrink-0" />
        <span className="truncate">{waiting.label}</span>
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
          <Hourglass aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0">{reason.detail}</span>
        </li>
      ))}
    </ul>
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
      <span className="col-start-2 truncate text-meta text-muted-foreground tabular-nums">
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
 * The threads outside any workspace, latest first, the parked ones folded under them: a click opens
 * one. Those marked done are in Done, with the finished workers.
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
  const viewed = useParams({ strict: false }).threadId;
  if (solo.length + parked.length === 0) return null;
  return (
    <Section id="solo" title="Solo threads" count={solo.length} hint={EXPLAIN.solo} term="solo">
      {solo.length > 0 && <SoloList threads={solo} viewed={viewed} />}
      {parked.length > 0 && <FoldedThreads kind="parked" threads={parked} viewed={viewed} />}
    </Section>
  );
}

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
} as const;

/**
 * The parked solo threads behind one line, folded until opened: out of the way, still a click
 * away. (The done ones had a line of their own until Done took them in.)
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
        className="flex h-6 w-full items-center gap-1.5 rounded-(--radius-sm) px-1.5 text-left text-meta text-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronDown
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 transition-transform duration-(--dur-fast)",
            !open && "-rotate-90",
          )}
        />
        <span className="flex-1">{label}</span>
        {!open && <span className="tabular-nums">{threads.length}</span>}
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
  const viewed = useParams({ strict: false }).threadId === summary.thread.id;
  // Ages to the minute.
  const now = useNow(true, undefined, 60_000);
  const { thread } = summary;
  const detail = useThreadsStore((s) => s.statusDetail[thread.id]);
  const display = threadStatusOf(summary, detail);
  const title = threadDisplayTitle(thread);
  const lastActive = display.working ? `Last activity ${formatStamp(thread.lastActivityAt)}` : "";
  const faded = settled || settledRow(summary.status, display, thread.lastActivityAt, now);
  const active = display.working || display.tone === "text-status-needs";
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
        aria-label={`${title}, ${display.label}${lastActive === "" ? "" : `, ${lastActive}`}`}
        title={lastActive === "" ? title : `${title}\n${lastActive}`}
        aria-keyshortcuts="Shift+F10"
        onClick={() => openThread(thread.id)}
        onKeyDown={rowMenuKeys}
        className={cn(ROW, "items-start", CURRENT_ROW, faded && SETTLED)}
      >
        <span
          aria-hidden
          data-working={display.working || undefined}
          className={cn(
            DOT_ON_FIRST_LINE,
            "rounded-full bg-current",
            // A dot is a mark, not words: needs-you takes its clean ui-grade amber.
            display.tone === "text-status-needs" ? "text-status-needs-mark" : display.tone,
            display.working && "gram-working",
          )}
        />
        {/* At work or needing you, two lines; at rest, one, which keeps the virtual list's rows
            anchored as what is above them grows. Its hover says the whole of it. */}
        <span className={active ? "line-clamp-2 [overflow-wrap:anywhere]" : "truncate"}>
          {title}
        </span>
        {!display.working && (
          <span className="flex h-lh items-center">
            <span className="text-meta text-muted-foreground tabular-nums">
              {formatRelative(thread.lastActivityAt, now)}
            </span>
          </span>
        )}
      </button>
    </RowMenu>
  );
}
