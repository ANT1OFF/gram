import {
  type FeatureCardHeld,
  type OrchestratorLedger,
  type Thread,
  ThreadId,
  type ThreadSummary,
  type WorkspaceId,
  type WorkspaceState,
} from "@gram/contracts";
import { useParams } from "@tanstack/react-router";
import {
  ChevronDown,
  ChevronsLeft,
  FoldHorizontal,
  PanelLeft,
  PanelLeftClose,
  X,
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

import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { EmbedAccount, EmbedNavigation, EmbedSidebarHeader, EmbedSwitcher } from "@/embed/slots";
import { useScrollFade } from "@/embed/scroll-fade";
import { useEmbedShell, useRoomySidebar, useThreadsListed, useWorkersWord } from "@/embed/store";
import { useShortcutHint, withHint } from "@/keyboard/use-shortcut-hint";
import { formatRelative, formatStamp } from "@/lib/time";
import { useNow } from "@/lib/use-now";
import { EXPLAIN } from "@/lib/explain";
import { cn } from "@/lib/utils";
import { revealVirtualRow, virtualRowOf, VirtualRows } from "@/lib/virtual-rows";
import { PresenceItem, PresenceList } from "@/motion";
import { focusLost } from "@/lib/use-return-focus";
import { focusSidebar, overviewStops } from "@/shell/focus-regions";
import { useRouteThreadId } from "@/shell/route-params";
import { useOpenThread } from "@/shell/thread-switcher";
import { UpdatePill } from "@/updates/update-pill";
import { useSwitchWorkspace } from "@/shell/workspace-switcher";
import { settledRow, threadStatusOf } from "@/sidebar/status";
import { fitShell, overviewFoldKey, useLayoutStore, type ShellFit } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";
import { useSame } from "@/stores/use-same";
import { RowMenuItems, rowMenuKeys, threadDragProps } from "@/thread/row-menu";
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
import { besideShown, keepBeside, useBesideStore } from "./beside-store";
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
  orchestratorHover,
  stateWord,
  orchestratorLine,
  handedOverItems,
  overviewFeatures,
  overviewItems,
  overviewState,
  soloDisplay,
  stateWordShown,
  steplessLine,
  workspaceWorkersText,
  type OverviewFeature,
  type OverviewState,
  type ReportNext,
  type RunningWorker,
} from "./overview-model";
import {
  CURRENT_ROW,
  ROW,
  ROW_STATUS,
  ROW_TRAIL,
  ROW_TITLE,
  RowMenu,
  Section,
  SECTION_CHEVRON,
  SECTION_TITLE,
  SETTLED,
  STOP,
} from "./overview-section";
import { threadHost } from "@/thread/machine-mark";
import { MachineMarker, useMachineMark } from "@/thread/machine-marker";
import { peek } from "./peek-store";
import { focusWorkersPane } from "./workers-tab";
import { StatusDot } from "./status-dot";
import { STATUS_WORDS } from "./status-words";
import { orchestratorOf, threadWorking, workingWorkerThreads } from "./tree-model";
import { useFeatureCards } from "./use-feature-cards";
import { NeedsYouEntry } from "./needs-you-entry";
import { useNeedsYouCounts } from "./use-needs-you";
import { useWorkerTally, useWorkspaceStatuses } from "./use-workspace-statuses";
import { accentStyle, useWorkspaceAccent } from "./workspace-accent";
import { WorkspaceMenuItems } from "./workspace-menu-items";
import { useOrchestratorLedger, useOrchestratorLedgers, useWorkspaces } from "./use-orchestration";
import { useOrchestratorWaiting, useWorkerWaitings } from "./use-waiting-on";
import { ledgerWorkersOver, workerActivities, workerTones } from "./workers-model";
import {
  besideKey,
  DOT,
  TALL_DOT,
  TWO_LINE_ROW,
  UNREAD_TITLE,
  useWorkLine,
  WaitingLine,
  WORKER_ROW,
  WORKER_TRAIL,
  WorkerRow,
} from "./worker-row";

/**
 * The live workers of `workspaceId` by feature, from its cards, and the ask each one waits on. Only
 * the workspace the window is on reads its cards.
 */
export function useOverviewFeatures(workspaceId: WorkspaceId): readonly OverviewFeature[] {
  const cards = useFeatureCards(workspaceId);
  const all = useWorkspaceAsks();
  const asks = all.find((each) => each.workspaceId === workspaceId)?.asks;
  const ledger = useOrchestratorLedger(workspaceId).data;
  const over = useThreadsStore(
    useSame((s) => (ledger === undefined ? undefined : ledgerWorkersOver(ledger, s.byId))),
  );
  const activities = useThreadsStore(
    useSame((s) => workerActivities(ledger, s.byId, s.statusDetail)),
  );
  const flat = useThreadsStore(
    useShallow((s) =>
      workingWorkerThreads(s.byId, s.statusDetail, workspaceId).flatMap((each) => [
        each.thread.id,
        each.thread.title,
        each.thread.spawnedBy?.feature ?? "",
      ]),
    ),
  );
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
  const waits = useWorkerWaitings(ledger, asking);
  return useMemo(() => {
    const running: RunningWorker[] = [];
    for (let i = 0; i + 2 < flat.length; i += 3) {
      running.push({
        threadId: ThreadId.make(flat[i]!),
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

export const overviewKeys = (event: KeyboardEvent<HTMLElement>) => {
  if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
  if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
  const stops = overviewStops(event.currentTarget);
  const active = document.activeElement;
  let from = stops.findIndex((stop) => stop === active);
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
  const last = event.key === "ArrowUp" || event.key === "End";
  const origin = stops[from];
  const at = origin === undefined ? undefined : virtualRowOf(origin);
  if (at !== undefined && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
    const next = at.index + (last ? -1 : 1);
    const inRow = target !== undefined && to !== from && at.row.contains(target);
    if (!inRow && next >= 0 && next < at.count) return void focusVirtualRow(at.list, next, last);
  }
  const into = target === undefined ? undefined : virtualRowOf(target);
  if (into !== undefined && (into.list !== at?.list || event.key === "End")) {
    const index = last ? into.count - 1 : 0;
    if (index !== into.index) return void focusVirtualRow(into.list, index, last);
  }
  target?.focus();
};

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

function useRevealViewed() {
  const viewed = useRouteThreadId();
  const section = useThreadsStore((s) =>
    viewedSection(viewed === undefined ? undefined : s.byId[viewed]?.thread),
  );
  const revealed = useRef(viewed);
  useEffect(() => {
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
  onClose,
}: {
  phone?: boolean;
  /**
   * Shown over the page from the hosted compact strip: its header's one toggle keeps it open
   * (`onPin`) in place of Hide and Compact.
   */
  onPin?: () => void;
  /** Shown over the page from the navigation dock: its header's one toggle closes it. */
  onClose?: () => void;
}) {
  const hideHint = useShortcutHint("sidebar.toggle");
  useRevealViewed();
  const hidden = useLayoutStore((s) => s.overviewHidden);
  const threadsListed = useThreadsListed();
  const hasHeader = useEmbedShell((s) => s.sidebar.header !== undefined);
  const beforeSetup = useBeforeSetup();
  const roomyLook = useRoomySidebar();
  const roomy = roomyLook && !phone;
  const scroller = useScrollFade(roomyLook);
  return (
    <aside
      aria-label="Overview"
      data-testid="overview-sidebar"
      data-surface="chrome"
      {...{ [OVERVIEW_ROOT]: "open" }}
      data-overlay={onPin === undefined && onClose === undefined ? undefined : ""}
      data-look={roomy ? "roomy" : undefined}
      className={cn(
        "flex min-h-0 flex-1 flex-col border-r border-sidebar-divider bg-sidebar text-sidebar-foreground",
        !phone &&
          onPin === undefined &&
          onClose === undefined &&
          "m-(--sidebar-inset) rounded-(--sidebar-radius) border-y-(length:--sidebar-edge) border-l-(length:--sidebar-edge)",
      )}
    >
      {roomy ? (
        <div className="flex min-h-(--titlebar-height) shrink-0 items-center gap-1 px-inset pt-2.5 pb-1.5">
          <EmbedSidebarHeader />
          {!hasHeader && <span className="flex-1" />}
          {onClose !== undefined && <CloseOver onClose={onClose} />}
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
                  className="text-muted-foreground [:where(&)_svg]:text-sidebar-icon"
                  onClick={onPin}
                />
              }
            >
              <PanelLeft />
            </Hint>
          )}
          {onPin === undefined && onClose === undefined && (
            <Hint
              label={withHint("Collapse sidebar to a strip", hideHint)}
              side="bottom"
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Collapse sidebar"
                  data-testid="overview-compact"
                  className="text-muted-foreground [:where(&)_svg]:text-sidebar-icon"
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
          <div className="@container/overview-head flex min-h-(--titlebar-height) shrink-0 flex-wrap content-start items-center gap-1 px-2 py-1.5 pl-[max(--spacing(2),var(--window-lights-inset))] [-webkit-app-region:drag]">
            {onClose !== undefined ? (
              <CloseOver onClose={onClose} />
            ) : onPin !== undefined ? (
              <Hint
                label="Keep sidebar open"
                side="bottom"
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Keep sidebar open"
                    data-testid="overview-pin"
                    className="text-muted-foreground [:where(&)_svg]:text-sidebar-icon [-webkit-app-region:no-drag]"
                    onClick={onPin}
                  />
                }
              >
                <PanelLeft />
              </Hint>
            ) : (
              <>
                <Hint
                  label={withHint("Hide sidebar", hideHint)}
                  side="bottom"
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Hide sidebar"
                      data-testid="overview-hide"
                      className="text-muted-foreground [:where(&)_svg]:text-sidebar-icon [-webkit-app-region:no-drag]"
                      onClick={toggleOverviewSidebar}
                    />
                  }
                >
                  <PanelLeftClose />
                </Hint>
                <Hint
                  label="Compact sidebar: a strip that opens on hover"
                  side="bottom"
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Compact sidebar"
                      data-testid="overview-compact"
                      className="text-muted-foreground [:where(&)_svg]:text-sidebar-icon [-webkit-app-region:no-drag]"
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
      {!roomy && (
        <EmbedSidebarHeader className={cn("flex-none px-inset pb-tight", roomyLook && "pt-1")} />
      )}
      <EmbedSwitcher placement="sidebar" className="px-inset pb-tight" />
      {roomy && (
        <div className="shrink-0 px-inset pb-tight">
          <OverviewSearch roomy />
        </div>
      )}
      <div
        ref={scroller}
        onKeyDown={overviewKeys}
        className={cn(
          "flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-inset pt-tight pb-list text-body",
          roomyLook
            ? "gap-0 [scrollbar-width:thin] [mask-image:linear-gradient(to_bottom,transparent,black_var(--fade-top,0px),black_calc(100%-var(--fade-bottom,0px)),transparent)]"
            : "gap-list",
        )}
      >
        <div className="flex flex-col gap-tight">
          <NeedsYou />
          {!phone && !roomy && <OverviewSearch />}
        </div>
        <EmbedNavigation placement="main" />
        {threadsListed && <Orchestrators />}
      </div>
      {!roomyLook && <EmbedNavigation />}
      {roomyLook ? (
        <>
          {!phone && !beforeSetup && !hidden.includes("usage") && <OverviewFoot />}
          <RoomyFoot showHistory={!hidden.includes("doneToday")} />
        </>
      ) : (
        <>
          <EmbedAccount className="border-t border-border px-inset py-tight" />
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
    if (useLayoutStore.getState().overviewSidebar !== undefined) return;
    void focusSidebar();
  }, [sidebar]);
}

function NeedsYou() {
  if (useBeforeSetup()) return null;
  return <NeedsYouEntry variant="row" {...{ [STOP]: "" }} data-testid="overview-needs-you" />;
}

function Orchestrators() {
  const workspaces = useWorkspaces();
  const solo = useViewSolo();
  const viewed = useViewWorkspace();
  const current = solo ? undefined : viewed;
  const asks = useWorkspaceAsks();
  const own = useThreadsStore(
    useShallow((s) =>
      Object.values(s.byId).filter(
        (summary): summary is ThreadSummary => summary?.thread.workspaceId !== undefined,
      ),
    ),
  );
  const { statuses } = useWorkspaceStatuses(own);
  const { byWorkspace } = useNeedsYouCounts();
  const asking = useMemo(
    () => new Map(asks.map((each) => [each.workspaceId as string, askingOf(each.asks)] as const)),
    [asks],
  );
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
        prs={(workspaces.length > 0 || anyThread) && !hidden.includes("pullRequests")}
        done={!hidden.includes("doneToday")}
      />
    </>
  );
}

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
  const { live, working } = useWorkerTally(id, ledger, asking);
  const foldKey = overviewFoldKey(id);
  const userFolded = useLayoutStore((s) => s.workspacesCollapsedNodes.includes(foldKey));
  const besideOn = useBesideStore((s) => besideShown(s) !== undefined);
  const inTab = useLayoutStore(
    (s) => here && (s.panelTab === "workers" || besideOn) && fitShell(s).panel !== "none",
  );
  const folded = userFolded || inTab;
  const handedOver = inTab;
  const workersWord = useWorkersWord();
  const fold = (to: boolean) => useLayoutStore.getState().toggleWorkspaceNode(foldKey, to);
  const bodyId = useId();
  const orchestratorWaiting = useOrchestratorWaiting(ledger);
  const waiting = stateWordShown(word) ? undefined : orchestratorWaiting;
  const summary = orchestratorHover(word, { live, working, asks }, ledgerSlotsText(ledger));
  const hover = waiting === undefined ? summary : `${summary}\nOrchestrator: ${waiting.hint}`;
  const line = orchestratorLine(word, { working, asks });
  const name = state.workspace.name;
  const accent = useWorkspaceAccent(id);
  const orchestratorBusy = useThreadsStore(
    (s) => workingOrchestrator(s, state.workspace) !== undefined,
  );
  const empty =
    live === 0 && (ledger?.held?.length ?? 0) === 0 && !orchestratorBusy && word === "idle";
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
                <span data-testid="overview-workspace-summary" className="truncate">
                  {workspaceWorkersText({ live, working, inTab, word: workersWord })}
                </span>
              ) : orchestratorBusy ? (
                <span className="truncate">At work</span>
              ) : (ledger?.held?.length ?? 0) > 0 ? (
                <span className="truncate">{ledger?.held?.length} held</span>
              ) : null}
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
                ? `${name}'s ${workersWord.toLowerCase()} are in the pane: go there`
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
                    ? `Go to ${name}'s ${workersWord.toLowerCase()} in the pane`
                    : folded
                      ? `Show ${name}'s workers`
                      : `Hide ${name}'s workers`
                }
                onClick={() => (inTab ? focusWorkersPane() : fold(!folded))}
                className="grid size-7 shrink-0 cursor-default place-items-center rounded-(--radius-sm) text-muted-foreground [:where(&)_svg]:text-sidebar-icon outline-none hover:bg-sidebar-row-hover hover:text-foreground focus-visible:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring"
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
        hidden={folded && !handedOver}
        className={cn("flex flex-col", accent !== undefined && "gram-accent-rail")}
        style={accentStyle(accent)}
      >
        {(here || !folded) && (
          <WorkspaceBody workspaceId={id} empty={empty} handedOver={handedOver} />
        )}
      </div>
    </div>
  );
}

function WorkspaceBody({
  workspaceId,
  empty,
  handedOver,
}: {
  workspaceId: WorkspaceId;
  empty: boolean;
  handedOver: boolean;
}) {
  const features = useOverviewFeatures(workspaceId);
  return (
    <WorkspaceFeatures
      workspaceId={workspaceId}
      features={features}
      empty={empty}
      handedOver={handedOver}
    />
  );
}

function WorkspaceFeatures({
  workspaceId,
  features,
  empty,
  handedOver = false,
}: {
  workspaceId: WorkspaceId;
  features: readonly OverviewFeature[];
  empty: boolean;
  handedOver?: boolean;
}) {
  const paneCurrent = useBesideStore((s) => (besideShown(s) === undefined ? undefined : s.current));
  const openThread = useOpenThread();
  const openInPane = (threadId: ThreadId, event: Pick<MouseEvent, "metaKey" | "ctrlKey">) => {
    if (besideKey(event) || !keepBeside(threadId, openThread)) openThread(threadId);
  };
  const snoozed = useThreadsStore(
    useShallow((s) =>
      Object.values(s.byId)
        .filter((each) => each.thread.snoozedUntil !== undefined)
        .map((each) => each.thread.id),
    ),
  );
  const items = useMemo(() => {
    const away = new Set<string>(snoozed);
    const shown = overviewItems(features).filter(
      (item) => item.kind !== "worker" || !away.has(item.row.threadId),
    );
    return handedOver ? handedOverItems(shown) : shown;
  }, [features, snoozed, handedOver]);
  if (items.length === 0) {
    if (empty || handedOver) return null;
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
                {...(paneCurrent === item.row.threadId ? { current: true } : {})}
                {...(handedOver ? { onOpen: (event) => openInPane(item.row.threadId, event) } : {})}
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

const SOLO_ROW = 36;
const SOLO_GAP = 1;

const soloKey = (summary: ThreadSummary) => summary.thread.id;

const soloAlarm = (display: { tone: string }) =>
  display.tone === "text-status-needs" || display.tone === "text-destructive";

const SoloThreads = memo(function SoloThreads() {
  const workspaces = useWorkspaces();
  const ids = useMemo(
    () => new Set(workspaces.map((state) => state.workspace.id as string)),
    [workspaces],
  );
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

function SoloList({
  threads,
  viewed,
}: {
  threads: readonly ThreadSummary[];
  viewed: string | undefined;
}) {
  const groups = useDerivedAsks((s) => s.needsYou.groups);
  const twoLine = useThreadsStore(
    useShallow((s) =>
      threads
        .filter((summary) =>
          soloAlarm(
            soloDisplay(
              threadStatusOf(summary, s.statusDetail[summary.thread.id]),
              threadNeed(groups, summary.thread.id),
            ),
          ),
        )
        .map(soloKey),
    ),
  );
  const tall = new Set(twoLine);
  return (
    <VirtualRows
      items={threads}
      rowKey={soloKey}
      sizeClass={(summary) => (tall.has(soloKey(summary)) ? "two-line" : "one-line")}
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
  const viewed = useParams({
    strict: false,
    select: (params) => params.threadId === summary.thread.id,
  });
  const now = useNow(true, undefined, 60_000);
  const { thread } = summary;
  const detail = useThreadsStore((s) => s.statusDetail[thread.id]);
  const need = useDerivedAsks((s) => threadNeed(s.needsYou.groups, thread.id));
  const display = soloDisplay(threadStatusOf(summary, detail), need);
  const title = threadDisplayTitle(thread);
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
  const alarm = soloAlarm(display);
  const hostId = threadHost(thread);
  const machine = useMachineMark(hostId, thread.sentTo);
  const where = machine === undefined ? "" : `, ${machine.words}`;
  const twoLines = alarm;
  const age = (
    <span data-testid="overview-solo-age" className="shrink-0 tabular-nums">
      {formatRelative(thread.lastActivityAt, now)}
    </span>
  );
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
        className={cn(ROW, WORKER_ROW, twoLines && TWO_LINE_ROW, CURRENT_ROW, faded && SETTLED)}
      >
        <span
          aria-hidden
          data-working={display.working || undefined}
          data-tall={twoLines || undefined}
          className={cn(
            twoLines ? TALL_DOT : DOT,
            twoLines ? "bg-current" : "rounded-full bg-current",
            display.tone === "text-status-needs" ? "text-status-needs-mark" : display.tone,
            display.working && "gram-working",
          )}
        />
        <span className={cn(ROW_TITLE, thread.unread && UNREAD_TITLE)}>{title}</span>
        <span data-testid="overview-solo-status" className={cn(ROW_TRAIL, WORKER_TRAIL)}>
          <MachineMarker
            hostId={hostId}
            sent={thread.sentTo}
            show={twoLines ? "glyph" : "name"}
            hover="none"
            testId="overview-solo-machine"
          />
          {machine !== undefined && !twoLines && !display.working && <span aria-hidden>·</span>}
          {!twoLines && !display.working && age}
        </span>
        {twoLines && (
          <span data-testid="overview-solo-line" className={ROW_STATUS}>
            <span
              className={cn(
                "min-w-0 flex-1 truncate",
                display.tone === "text-status-needs" ? "text-status-needs" : "text-destructive",
              )}
            >
              {display.label}
            </span>
            <span className="ml-auto pl-1">{age}</span>
          </span>
        )}
      </button>
    </RowMenu>
  );
}

function CloseOver({ onClose }: { onClose: () => void }) {
  return (
    <Hint
      label="Close overview"
      side="bottom"
      render={
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close overview"
          data-testid="overview-close"
          className="text-muted-foreground [:where(&)_svg]:text-sidebar-icon [-webkit-app-region:no-drag]"
          onClick={onClose}
        />
      }
    >
      <X />
    </Hint>
  );
}
