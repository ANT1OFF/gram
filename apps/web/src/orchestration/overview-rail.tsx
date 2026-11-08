import { PreviewCard } from "@base-ui/react/preview-card";
import {
  type OrchestratorLedger,
  type ThreadId,
  type ThreadSummary,
  type WorkspaceId,
  type WorkspaceState,
} from "@gram/contracts";
import { MessageSquare, PanelLeftClose, UnfoldHorizontal } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { useShallow } from "zustand/react/shallow";

import { AgentIcon } from "@/agents/agent-display";
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { useWindowLights } from "@/desktop/window-lights";
import { useShortcutHint, withHint } from "@/keyboard/use-shortcut-hint";
import { cn } from "@/lib/utils";
import { CARD_SURFACE } from "@/reviews/pr-display";
import { OVERVIEW_STOP, overviewStops } from "@/shell/focus-regions";
import { TopLeftNav } from "@/shell/top-left-nav";
import { useOpenThread } from "@/shell/thread-switcher";
import { useSwitchWorkspace } from "@/shell/workspace-switcher";
import { threadStatusOf } from "@/sidebar/status";
import { useThreadsStore } from "@/stores/threads";
import { threadDisplayTitle } from "@/thread/thread-title";
import { OVERVIEW_FLYOUT, OVERVIEW_ROOT, toggleOverviewSidebar } from "@/views/shell-layout";
import { soloThreads } from "@/views/solo-threads";
import { useSettleRule } from "@/views/use-settle-rule";
import { useViewSolo, useViewWorkspace } from "@/views/view-workspace";

import { useWorkspaceAsks } from "./ask-stack";
import { keepBeside } from "./beside-store";
import {
  overviewItems,
  overviewState,
  orchestratorHover,
  overviewSummary,
  plainActivity,
  plainRunning,
  tileWorking,
  type OverviewState,
} from "./overview-model";
import {
  askingOf,
  besideKey,
  overviewKeys,
  SoloRow,
  switchOverview,
  OrchestratorAtWork,
  useAgentsMixed,
  useOverviewFeatures,
  WorkerRow,
} from "./overview-sidebar";
import { ROW } from "./overview-section";
import { peek } from "./peek-store";
import { workingWorkerThreads } from "./tree-model";
import { needsYouScope, needsYouSpoken } from "./needs-you-entry";
import { asksAmong } from "./needs-you-items";
import { useNeedsYouCounts, useNeedsYouPill } from "./use-needs-you";
import { ledgerSlotsText } from "./overview-extras-model";
import { monograms } from "./rail-monogram";
import { useWorkerTally, useWorkspaceStatuses } from "./use-workspace-statuses";
import { useWorkspaces } from "./use-orchestration";

// The overview's compact form: a narrow rail
// with a tile per workspace and one for the solo threads. A tile says what its row in the open
// overview says, in a ring (its orchestrator works), a badge (its asks) and a count (its workers at
// work); hovered or focused, a flyout beside it lists them, with the open overview's rows. Watching
// holds nothing here either.

const STOP = { [OVERVIEW_STOP]: "" };

/**
 * The overview's compact rail: Hide sidebar in the toggle's spot, Usage and Settings, Expand sidebar,
 * Needs you, a tile per workspace, then the solo threads'.
 */
export function OverviewRail() {
  const hideHint = useShortcutHint("sidebar.toggle");
  // Under macOS's window buttons the title bar's row is theirs; the toggle leads the column below.
  const underLights = useWindowLights((s) => s.inset > 0);
  const hide = (
    <Hint
      label={withHint("Hide sidebar", hideHint)}
      side="right"
      render={
        <Button
          variant="ghost"
          size="icon-sm"
          {...STOP}
          aria-label="Hide sidebar"
          data-testid="overview-hide"
          className="shrink-0 text-muted-foreground [-webkit-app-region:no-drag]"
          onClick={toggleOverviewSidebar}
        />
      }
    >
      <PanelLeftClose />
    </Hint>
  );
  return (
    <aside
      aria-label="Overview"
      data-testid="overview-rail"
      data-surface="chrome"
      {...{ [OVERVIEW_ROOT]: "compact" }}
      className="flex min-h-0 flex-1 flex-col items-center border-r border-sidebar-divider bg-sidebar text-sidebar-foreground"
    >
      <div
        onKeyDown={overviewKeys}
        className="flex min-h-0 w-full flex-1 flex-col items-center gap-3 overflow-y-auto overscroll-contain pb-3"
      >
        {/* The title bar's height: Hide sidebar in the spot the open overview's and the title bar's
            Show sidebar take, so the toggle never moves; under macOS's window buttons, just below. */}
        <div className="flex h-(--titlebar-height) shrink-0 items-center self-stretch px-2 [-webkit-app-region:drag]">
          {!underLights && hide}
        </div>
        {underLights && hide}
        {/* Settings follows the toggle, as it follows it in the open header. */}
        <TopLeftNav className="shrink-0 flex-col" />
        <Hint
          label="Expand sidebar: workspaces as rows"
          side="right"
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              {...STOP}
              aria-label="Expand sidebar"
              data-testid="overview-expand"
              className="shrink-0 text-muted-foreground"
              onClick={() => switchOverview("open")}
            />
          }
        >
          <UnfoldHorizontal />
        </Hint>
        <RailNeedsYou />
        <Separator />
        <WorkspaceTiles />
        <Separator />
        <SoloTile />
      </div>
    </aside>
  );
}

const Separator = () => <span aria-hidden className="h-px w-6 shrink-0 bg-sidebar-divider" />;

/**
 * Needs you as the open overview counts it, as a pill, amber while anything waits; it opens what
 * the open overview's opens.
 */
function RailNeedsYou() {
  const { count, parts, scope: where, label: action, hint, openAsks } = useNeedsYouPill();
  // The sidebar's words, which a number alone stands for here: the rail has room for no more.
  const label = needsYouSpoken(count, parts);
  const scope = needsYouScope(count, where);
  const asks = asksAmong(count, parts);
  // Nothing waiting, it stays as a quiet grey pill, so the tiles don't jump.
  return (
    <button
      type="button"
      {...STOP}
      data-testid="overview-rail-needs-you"
      data-count={count}
      data-asks={asks || undefined}
      aria-label={label}
      title={`${withHint(action, hint)}\n${scope}`}
      onClick={openAsks}
      className={cn(
        "h-5 min-w-7 shrink-0 rounded-full border px-1.5 text-caption leading-4.5 font-semibold tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring",
        // A neutral outline, as the open sidebar's pill: only the count is amber, and only while
        // something asks. Errors alone keep the quiet pill (one alarm each).
        asks
          ? "border-sidebar-block-border text-status-needs hover:bg-sidebar-row-hover"
          : "border-transparent bg-sidebar-block text-muted-foreground hover:bg-sidebar-row-hover",
      )}
    >
      {count}
    </button>
  );
}

/**
 * A tile: a workspace's monogram, one letter of its name ("B" for billing-api), two only where
 * another workspace starts with the same one (`monograms`), in the tile's own text; the solo
 * threads' tile keeps a thread's glyph. Its flyout, open on hover or focus, heads with the whole
 * name, and its accessible name says it too.
 */
const TILE =
  "relative grid size-9 shrink-0 place-items-center rounded-xs border border-sidebar-block-border bg-sidebar-block text-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-current:border-foreground/35 aria-current:bg-sidebar-row-active aria-current:text-foreground";

/** One tile per workspace, in the switcher's order, as the open overview's rows. */
function WorkspaceTiles() {
  const workspaces = useWorkspaces();
  // A solo thread in view is in no workspace: no tile is marked.
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
  const { statuses, ledgers } = useWorkspaceStatuses(own);
  // Each workspace's share of Needs you, and the workers its asks wait on, as the open overview's
  // lines read them.
  const { byWorkspace } = useNeedsYouCounts();
  const asking = useMemo(
    () => new Map(asks.map((each) => [each.workspaceId as string, askingOf(each.asks)] as const)),
    [asks],
  );
  const marks = monograms(workspaces.map((state) => state.workspace.name));
  return workspaces.map((state, index) => {
    const id = state.workspace.id;
    return (
      <WorkspaceTile
        key={id}
        mark={marks[index] ?? ""}
        state={state}
        here={id === current?.workspace.id}
        asks={byWorkspace.get(id) ?? 0}
        asking={asking.get(id) ?? NO_ASKING}
        ledger={ledgers.get(id)}
        word={overviewState(statuses.get(id), state.paused !== undefined)}
      />
    );
  });
}

const NO_ASKING: ReadonlySet<ThreadId> = new Set();

function WorkspaceTile({
  mark,
  state,
  here,
  asks,
  asking,
  ledger,
  word,
}: {
  /** Its monogram (`monograms`). */
  mark: string;
  state: WorkspaceState;
  here: boolean;
  asks: number;
  asking: ReadonlySet<ThreadId>;
  ledger: OrchestratorLedger | undefined;
  word: OverviewState;
}) {
  const switchTo = useSwitchWorkspace();
  const id = state.workspace.id;
  // How many of its workers work, by their tones, as the open overview's line counts them.
  const { live, working } = useWorkerTally(id, ledger, asking);
  const summary = overviewSummary(word, { working, asks });
  const hover = orchestratorHover(word, { live, working, asks }, ledgerSlotsText(ledger));
  const ringing = tileWorking(word, working);
  return (
    <Flyout
      testId={`workspace:${id}`}
      trigger={
        <button
          type="button"
          {...STOP}
          data-testid="overview-tile"
          data-workspace-id={id}
          data-state={word}
          aria-current={here || undefined}
          aria-label={`${state.workspace.name}, ${hover}`}
          onClick={() => switchTo(state.workspace)}
          className={cn(TILE, (word === "paused" || word === "parked") && "opacity-60")}
        />
      }
      tile={
        <>
          <span
            aria-hidden
            data-testid="overview-tile-ring"
            data-working={ringing || undefined}
            className={cn(
              "pointer-events-none absolute -inset-1 rounded-sm border-2",
              ringing ? "gram-ring-breathe border-status-working/55" : "border-transparent",
            )}
          />
          <span
            aria-hidden
            data-testid="overview-tile-mark"
            className="text-body-strong leading-none tracking-normal"
          >
            {mark}
          </span>
          {asks > 0 && (
            <span
              aria-hidden
              data-testid="overview-tile-asks"
              className="absolute -top-1.5 -right-2 h-4 min-w-4 rounded-full bg-status-needs px-1 text-center text-caption leading-4 font-semibold text-background tabular-nums"
            >
              {asks}
            </span>
          )}
          {working > 0 && <TileCount count={working} />}
        </>
      }
    >
      <FlyoutHead title={state.workspace.name} detail={summary} />
      {here ? <CurrentWorkers workspaceId={id} /> : <OtherWorkers workspaceId={id} />}
    </Flyout>
  );
}

const TileCount = ({ count }: { count: number }) => (
  <span
    aria-hidden
    data-testid="overview-tile-count"
    className="absolute -right-1.5 -bottom-1.5 rounded-xs border border-sidebar-block-border bg-sidebar px-0.75 text-caption leading-3.5 font-normal tracking-normal text-muted-foreground tabular-nums"
  >
    {count}
  </span>
);

/** The threads outside any workspace, as one tile with their count. */
function SoloTile() {
  const workspaces = useWorkspaces();
  const ids = useMemo(
    () => new Set(workspaces.map((state) => state.workspace.id as string)),
    [workspaces],
  );
  const settle = useSettleRule();
  const solo = useThreadsStore(useShallow((s) => soloThreads(Object.values(s.byId), ids, settle)));
  const here = useViewSolo();
  return (
    <Flyout
      testId="solo"
      // Its threads are in the flyout, which a click opens as hovering does.
      clickOpens
      trigger={
        <button
          type="button"
          {...STOP}
          data-testid="overview-tile"
          data-tile="solo"
          aria-current={here || undefined}
          aria-label={`Solo threads, ${solo.length}`}
          className={TILE}
        />
      }
      tile={
        <>
          <MessageSquare aria-hidden data-testid="overview-tile-glyph" className="size-icon-row" />
          <TileCount count={solo.length} />
        </>
      }
    >
      <FlyoutHead title="Solo threads" detail={String(solo.length)} />
      {solo.length === 0 ? (
        <Empty>None.</Empty>
      ) : (
        solo.map((summary) => <SoloRow key={summary.thread.id} summary={summary} />)
      )}
    </Flyout>
  );
}

const plain = (event: KeyboardEvent) => !event.altKey && !event.metaKey && !event.ctrlKey;

/**
 * The open flyout's close: one opening closes the last at once, so a pointer moving down the rail
 * swaps one tile's name for the next rather than stacking two while the first's close delay runs.
 */
let closeOpenFlyout: (() => void) | undefined;

/**
 * A tile and its flyout, open the moment the tile is hovered or focused, so a monogram says whose it
 * is at once (the flyout heads with the whole name), and while the pointer or the
 * focus is in it. → goes in to its first row, ↑↓ Home End move between its rows, and ← or Esc
 * close it with the focus back on the tile. A pick in it (open, peek, open beside, a solo
 * thread) closes it, the focus on its tile first, so whatever the pick opens comes back to the tile.
 */
function Flyout({
  testId,
  clickOpens = false,
  trigger,
  tile,
  children,
}: {
  testId: string;
  /** A click on the tile opens the flyout, rather than closing it to do the tile's own click. */
  clickOpens?: boolean;
  trigger: ReactElement;
  tile: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    closeOpenFlyout?.();
    closeOpenFlyout = close;
    return () => {
      if (closeOpenFlyout === close) closeOpenFlyout = undefined;
    };
  }, [open]);
  const tileRef = useRef<HTMLElement | null>(null);
  const popup = useRef<HTMLDivElement>(null);
  // The focus handed back to the tile opens nothing until the tile has lost it again.
  const quiet = useRef(false);
  // A hover back onto the tile while the flyout still fades out: the card drops its open as the
  // close completes, unless that close was a hover's own, so the flyout opens once it has.
  const reentered = useRef(false);
  const back = () => {
    quiet.current = true;
    setOpen(false);
    tileRef.current?.focus({ preventScroll: true });
  };
  const onOpenChange = (next: boolean, details: PreviewCard.Root.ChangeEventDetails) => {
    if (
      next &&
      quiet.current &&
      (details.reason === "trigger-focus" || details.reason === "trigger-hover")
    )
      return;
    // From a row inside it, the focus goes back to its tile rather than to the page.
    if (
      !next &&
      details.reason === "escape-key" &&
      popup.current?.contains(document.activeElement)
    ) {
      back();
      return;
    }
    setOpen(next);
  };
  const onTileKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "ArrowRight" || !plain(event)) return;
    event.preventDefault();
    setOpen(true);
    let frames = 0;
    const into = () => {
      const first = popup.current === null ? undefined : overviewStops(popup.current)[0];
      if (first !== undefined) first.focus();
      else if (++frames < 10) requestAnimationFrame(into);
    };
    requestAnimationFrame(into);
  };
  const onFlyoutKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "ArrowLeft" && plain(event)) {
      event.preventDefault();
      back();
      return;
    }
    overviewKeys(event);
  };
  const onPick = (event: MouseEvent<HTMLElement>) => {
    if ((event.target as Element).closest("button, a[href]") !== null) back();
  };
  return (
    <PreviewCard.Root
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(opened) => {
        if (!opened && reentered.current && tileRef.current?.matches(":hover")) setOpen(true);
        reentered.current = false;
      }}
    >
      <PreviewCard.Trigger
        delay={0}
        closeDelay={150}
        ref={(element: HTMLElement | null) => {
          tileRef.current = element;
        }}
        render={trigger}
        onClick={() => {
          // The click decides: a hover onto the tile it began with reopens nothing.
          reentered.current = false;
          // Activating a focused workspace tile also cancels its pending focus preview.
          quiet.current = !clickOpens;
          setOpen(clickOpens);
        }}
        onKeyDown={onTileKey}
        onMouseEnter={() => {
          quiet.current = false;
          reentered.current = !open && popup.current !== null;
        }}
        onMouseLeave={() => {
          reentered.current = false;
        }}
        onBlur={() => {
          quiet.current = false;
        }}
      >
        {tile}
      </PreviewCard.Trigger>
      <PreviewCard.Portal>
        <PreviewCard.Positioner
          side="right"
          align="start"
          sideOffset={16}
          alignOffset={-8}
          className="isolate z-50"
        >
          <PreviewCard.Popup
            ref={popup}
            data-testid="overview-flyout"
            data-for={testId}
            {...{ [OVERVIEW_FLYOUT]: "" }}
            data-surface="overlay"
            onKeyDown={onFlyoutKey}
            onClick={onPick}
            // 24 rem: room for a worker's title and two PR chips side by side on its one line, as a
            // card would say them.
            className={cn(
              CARD_SURFACE,
              "flex max-h-[min(32rem,var(--available-height))] w-96 flex-col gap-px overflow-y-auto p-2 text-body",
            )}
          >
            {children}
          </PreviewCard.Popup>
        </PreviewCard.Positioner>
      </PreviewCard.Portal>
    </PreviewCard.Root>
  );
}

function FlyoutHead({ title, detail }: { title: string; detail: string }) {
  return (
    <h3 className="flex items-baseline gap-2 px-1.5 pt-0.5 pb-1 text-body font-semibold">
      <span className="min-w-0 flex-1 truncate">{title}</span>
      <span
        data-testid="overview-flyout-summary"
        className="shrink-0 text-meta font-normal text-muted-foreground"
      >
        {detail}
      </span>
    </h3>
  );
}

const Empty = ({ children }: { children: ReactNode }) => (
  <p className="px-1.5 py-1 text-meta text-muted-foreground">{children}</p>
);

/** The workspace the window is on: its live workers, most urgent first, as the open overview has them. */
function CurrentWorkers({ workspaceId }: { workspaceId: WorkspaceId }) {
  const features = useOverviewFeatures(workspaceId);
  const items = useMemo(() => overviewItems(features), [features]);
  const workers = items.flatMap((item) => (item.kind === "worker" ? [item] : []));
  const agentMark = useAgentsMixed(workers.map((item) => item.row.threadId));
  if (workers.length === 0) {
    return (
      <OrchestratorAtWork workspaceId={workspaceId} className="px-1.5 py-1">
        No workers now.
      </OrchestratorAtWork>
    );
  }
  return workers.map((item) => (
    <WorkerRow
      key={item.row.threadId}
      row={item.row}
      feature={item.feature}
      updatedAt={item.updatedAt}
      agentMark={agentMark}
      card={false}
    />
  ));
}

/**
 * Another workspace: its workers at work, from the threads the window already has (a click opens,
 * ⌥-click peeks, ⌘-click keeps beside, as the open rows); its cards are
 * read only once it is the current one.
 */
function OtherWorkers({ workspaceId }: { workspaceId: WorkspaceId }) {
  const threads = useThreadsStore(
    useShallow((s) => workingWorkerThreads(s.byId, s.statusDetail, workspaceId)),
  );
  const agentMark = useAgentsMixed(threads.map((summary) => summary.thread.id));
  if (threads.length === 0) return <Empty>No workers at work.</Empty>;
  return threads.map((summary) => (
    <OtherWorkerRow key={summary.thread.id} summary={summary} agentMark={agentMark} />
  ));
}

/** Another workspace's worker at work; its agent's mark only while its list mixes agents. */
function OtherWorkerRow({ summary, agentMark }: { summary: ThreadSummary; agentMark: boolean }) {
  const openThread = useOpenThread();
  const { thread } = summary;
  const title = threadDisplayTitle(thread);
  const detail = useThreadsStore((s) => s.statusDetail[thread.id]);
  const display = threadStatusOf(summary, detail);
  const now = detail ? plainActivity(detail) : plainRunning(display.label);
  return (
    <button
      type="button"
      {...STOP}
      data-testid="overview-worker"
      data-thread-id={thread.id}
      aria-label={`${title}, ${now}`}
      title={`${title}\n${now}`}
      onClick={(event) => {
        if (besideKey(event)) keepBeside(thread.id, openThread);
        else if (event.altKey)
          peek({ kind: "worker", threadId: thread.id, title }, event.currentTarget);
        else openThread(thread.id);
      }}
      className={ROW}
    >
      <span
        aria-hidden
        className={cn("size-2 justify-self-center rounded-full bg-current", display.tone)}
      />
      <span className="truncate text-foreground">{title}</span>
      <span className="flex text-muted-foreground">
        {agentMark && thread.model?.agent !== undefined && (
          <AgentIcon agent={thread.model.agent} className="size-icon-chip" />
        )}
      </span>
      <span className="col-span-2 col-start-2 min-w-0 truncate text-meta text-muted-foreground">
        {now}
      </span>
    </button>
  );
}
