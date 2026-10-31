import { PreviewCard } from "@base-ui/react/preview-card";
import {
  STATION_LABELS,
  type OrchestratorLedger,
  type ThreadId,
  type ThreadSummary,
  type WorkspaceId,
  type WorkspaceState,
} from "@gram/contracts";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import {
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
import { useViewWorkspace } from "@/views/view-workspace";

import { askKeysByThread } from "./ask-model";
import { useWorkspaceAsks } from "./ask-stack";
import { keepBeside } from "./beside-store";
import {
  overviewState,
  orchestratorHover,
  overviewSummary,
  tileLetters,
  tileWorking,
  type OverviewState,
} from "./overview-model";
import {
  besideKey,
  overviewKeys,
  SoloRow,
  switchOverview,
  OrchestratorAtWork,
  useOrchestratorAgent,
  useOverviewFeatures,
  WorkerRow,
} from "./overview-sidebar";
import { ROW } from "./overview-section";
import { peek } from "./peek-store";
import { workingWorkerThreads } from "./tree-model";
import { NeedsYouPopover } from "./needs-you-popover";
import { useNeedsYou } from "./use-needs-you";
import { ledgerSlotsText } from "./overview-extras-model";
import { useWorkerTally, useWorkspaceStatuses } from "./use-workspace-statuses";
import { useWorkspaces } from "./use-orchestration";

// The overview's compact form: a narrow rail
// with a tile per workspace and one for the solo threads. A tile says what its row in the open
// overview says, in a ring (its orchestrator works), a badge (its asks) and a count (its workers at
// work); hovered or focused, a flyout beside it lists them, with the open overview's rows. Watching
// holds nothing here either.

const STOP = { [OVERVIEW_STOP]: "" };

/**
 * The overview's compact rail: Hide sidebar in the toggle's spot, Usage and Settings, Expand overview,
 * Needs you, a tile per workspace, then the solo threads'.
 */
export function OverviewRail() {
  const hideHint = useShortcutHint("sidebar.toggle");
  // Under macOS's window buttons the title bar's row is theirs; the toggle leads the column below.
  const underLights = useWindowLights((s) => s.inset > 0);
  const hide = (
    <Button
      variant="ghost"
      size="icon-xs"
      {...STOP}
      aria-label="Hide sidebar"
      data-testid="overview-hide"
      title={withHint("Hide sidebar", hideHint)}
      className="shrink-0 text-muted-foreground [-webkit-app-region:no-drag]"
      onClick={toggleOverviewSidebar}
    >
      <PanelLeftClose />
    </Button>
  );
  return (
    <aside
      aria-label="Overview"
      data-testid="overview-rail"
      data-surface="chrome"
      {...{ [OVERVIEW_ROOT]: "compact" }}
      className="flex min-h-0 flex-1 flex-col items-center border-r border-border bg-sidebar text-sidebar-foreground"
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
        {/* Usage and Settings follow the toggle, stacked, as they follow it in the open header. */}
        <TopLeftNav className="shrink-0 flex-col" />
        <Button
          variant="ghost"
          size="icon-sm"
          {...STOP}
          aria-label="Expand overview"
          data-testid="overview-expand"
          title="Expand overview"
          className="shrink-0 text-muted-foreground"
          onClick={() => switchOverview("open")}
        >
          <PanelLeftOpen />
        </Button>
        <RailNeedsYou />
        <Separator />
        <WorkspaceTiles />
        <Separator />
        <SoloTile />
      </div>
    </aside>
  );
}

const Separator = () => <span aria-hidden className="h-px w-6 shrink-0 bg-border" />;

/**
 * Needs you as the open overview counts it, as a pill, amber while anything waits; it opens what
 * the open overview's opens.
 */
function RailNeedsYou() {
  const { count, label: action, hint } = useNeedsYou();
  const label = count > 0 ? `${count} ${count === 1 ? "needs" : "need"} you` : "Nothing needs you";
  // Nothing waiting, it stays as a quiet grey pill, so the tiles don't jump.
  return (
    <NeedsYouPopover
      anchor="rail"
      trigger={
        <button
          type="button"
          {...STOP}
          data-testid="overview-rail-needs-you"
          data-count={count}
          aria-label={label}
          title={withHint(action, hint)}
          className={cn(
            "h-5 min-w-7 shrink-0 rounded-full px-1.5 text-[11px] leading-5 font-semibold tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring",
            count > 0
              ? "bg-status-needs text-background hover:bg-status-needs/85"
              : "bg-sidebar-block text-muted-foreground hover:bg-sidebar-row-hover",
          )}
        >
          {count}
        </button>
      }
    />
  );
}

const TILE =
  "relative grid size-9 shrink-0 place-items-center rounded-[9px] border border-sidebar-block-border bg-sidebar-block text-[12.5px] font-semibold tracking-wide text-muted-foreground outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring aria-current:border-foreground/35 aria-current:bg-sidebar-row-active aria-current:text-foreground";

/** One tile per workspace, in the switcher's order, as the open overview's rows. */
function WorkspaceTiles() {
  const workspaces = useWorkspaces();
  const current = useViewWorkspace();
  const asks = useWorkspaceAsks();
  const own = useThreadsStore(
    useShallow((s) =>
      Object.values(s.byId).filter(
        (summary): summary is ThreadSummary => summary?.thread.workspaceId !== undefined,
      ),
    ),
  );
  const { statuses, ledgers } = useWorkspaceStatuses(own);
  // Each workspace's asks, and the workers they wait on, as the open overview's lines read them.
  const waiting = useMemo(
    () =>
      new Map(
        asks.map((each) => [
          each.workspaceId as string,
          { count: each.asks.length, asking: new Set(askKeysByThread(each.asks).keys()) },
        ]),
      ),
    [asks],
  );
  return workspaces.map((state) => {
    const id = state.workspace.id;
    return (
      <WorkspaceTile
        key={id}
        state={state}
        here={id === current?.workspace.id}
        asks={waiting.get(id)?.count ?? 0}
        asking={waiting.get(id)?.asking ?? NO_ASKING}
        ledger={ledgers.get(id)}
        word={overviewState(statuses.get(id), state.paused !== undefined)}
      />
    );
  });
}

const NO_ASKING: ReadonlySet<ThreadId> = new Set();

function WorkspaceTile({
  state,
  here,
  asks,
  asking,
  ledger,
  word,
}: {
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
              "pointer-events-none absolute -inset-1 rounded-[12px] border-2",
              ringing ? "gram-ring-breathe border-status-working/55" : "border-transparent",
            )}
          />
          <span aria-hidden>{tileLetters(state.workspace.name)}</span>
          {asks > 0 && (
            <span
              aria-hidden
              data-testid="overview-tile-asks"
              className="absolute -top-1.5 -right-2 h-4 min-w-4 rounded-full bg-status-needs px-1 text-center text-[10px] leading-4 font-semibold text-background tabular-nums"
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
    className="absolute -right-1.5 -bottom-1.5 rounded-[6px] border border-sidebar-block-border bg-sidebar px-0.75 text-[10px] leading-3.5 font-normal tracking-normal text-muted-foreground tabular-nums"
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
  const solo = useThreadsStore(useShallow((s) => soloThreads(Object.values(s.byId), ids)));
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
          aria-label={`Solo threads, ${solo.length}`}
          className={TILE}
        />
      }
      tile={
        <>
          <span aria-hidden>so</span>
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
 * A tile and its flyout, open while the tile is hovered or focused and while the pointer or the
 * focus is in it. → goes in to its first row, ↑↓ Home End move between its rows, and ← or Esc
 * close it with the focus back on the tile. A pick in it (open, peek, keep beside, a solo
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
    if (next && details.reason === "trigger-focus" && quiet.current) return;
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
        delay={150}
        closeDelay={150}
        ref={(element: HTMLElement | null) => {
          tileRef.current = element;
        }}
        render={trigger}
        onClick={() => {
          // The click decides: a hover onto the tile it began with reopens nothing.
          reentered.current = false;
          setOpen(clickOpens);
        }}
        onKeyDown={onTileKey}
        onMouseEnter={() => {
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
            className={cn(
              CARD_SURFACE,
              "flex max-h-[min(32rem,var(--available-height))] w-72 flex-col gap-px overflow-y-auto p-2 text-[13px]",
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
    <h3 className="flex items-baseline gap-2 px-1.5 pt-0.5 pb-1 text-[13px] font-semibold">
      <span className="min-w-0 flex-1 truncate">{title}</span>
      <span
        data-testid="overview-flyout-summary"
        className="shrink-0 text-xs font-normal text-muted-foreground"
      >
        {detail}
      </span>
    </h3>
  );
}

const Empty = ({ children }: { children: ReactNode }) => (
  <p className="px-1.5 py-1 text-xs text-muted-foreground">{children}</p>
);

/** The workspace the window is on: its live workers by feature, the open overview's rows. */
function CurrentWorkers({ workspaceId }: { workspaceId: WorkspaceId }) {
  const features = useOverviewFeatures(workspaceId);
  const orchestratorAgent = useOrchestratorAgent(workspaceId);
  const rows = features.filter((feature) => feature.rows.length > 0);
  if (rows.length === 0) {
    return (
      <OrchestratorAtWork workspaceId={workspaceId} className="px-1.5 py-1">
        No workers now.
      </OrchestratorAtWork>
    );
  }
  return rows.map((feature) => (
    <section
      key={feature.feature}
      aria-label={`${feature.feature}, ${STATION_LABELS[feature.station]}`}
      data-testid="overview-feature"
      data-feature={feature.feature}
      data-station={feature.station}
      className="flex flex-col"
    >
      <h4
        title={`Stage: ${STATION_LABELS[feature.station]}`}
        className="truncate px-1.5 pt-1 pb-0.5 text-xs font-medium text-muted-foreground"
      >
        {feature.feature}
      </h4>
      {feature.rows.map((row) => (
        <WorkerRow
          key={row.threadId}
          row={row}
          feature={feature.feature}
          updatedAt={feature.updatedAt}
          orchestratorAgent={orchestratorAgent}
          card={false}
        />
      ))}
    </section>
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
  if (threads.length === 0) return <Empty>No workers at work.</Empty>;
  return threads.map((summary) => <OtherWorkerRow key={summary.thread.id} summary={summary} />);
}

function OtherWorkerRow({ summary }: { summary: ThreadSummary }) {
  const openThread = useOpenThread();
  const { thread } = summary;
  const title = threadDisplayTitle(thread);
  const detail = useThreadsStore((s) => s.statusDetail[thread.id]);
  const display = threadStatusOf(summary, detail);
  const now = detail ?? display.label;
  return (
    <button
      type="button"
      {...STOP}
      data-testid="overview-worker"
      data-thread-id={thread.id}
      aria-label={`${title}, ${now}`}
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
        {thread.model?.agent !== undefined && (
          <AgentIcon agent={thread.model.agent} className="size-3" />
        )}
      </span>
      <span className="col-span-2 col-start-2 min-w-0 truncate text-xs text-muted-foreground">
        {now}
      </span>
    </button>
  );
}
