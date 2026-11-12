import {
  type OrchestratorLedger,
  type ThreadId,
  type ThreadSummary,
  type WorkspaceState,
} from "@gram/contracts";
import { useRouterState } from "@tanstack/react-router";
import { History, Inbox, MessageSquare, PanelLeftClose, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { useShallow } from "zustand/react/shallow";

import { Hint } from "@/components/hint";
import { useWindowLights } from "@/desktop/window-lights";
import { useHostAttention } from "@/embed/attention";
import { EmbedRailNavigation, EmbedSwitcher, RAIL_TILE } from "@/embed/slots";
import { useEmbedShell, useThreadsListed } from "@/embed/store";
import { StripOpen, useStripOpen } from "@/embed/strip-open";
import { useHistoryStore } from "@/history/history-view";
import { useShortcutHint, withHint } from "@/keyboard/use-shortcut-hint";
import { cn } from "@/lib/utils";
import { useMotionLevel } from "@/motion";
import { OVERVIEW_STOP } from "@/shell/focus-regions";
import { TopLeftNav } from "@/shell/top-left-nav";
import { useSwitchWorkspace } from "@/shell/workspace-switcher";
import { useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";
import { OVERVIEW_ROOT, toggleOverviewSidebar } from "@/views/shell-layout";
import { useViewSolo, useViewWorkspace } from "@/views/view-workspace";

import { useWorkspaceAsks } from "./ask-stack";
import {
  orchestratorHover,
  overviewState,
  tileWorking,
  type OverviewState,
} from "./overview-model";
import { askingOf, OverviewSidebar, switchOverview } from "./overview-sidebar";
import { needsYouSpoken } from "./needs-you-entry";
import { useNeedsYouCounts, useNeedsYouPill } from "./use-needs-you";
import { ledgerSlotsText } from "./overview-extras-model";
import { monograms } from "./rail-monogram";
import { useWorkerTally, useWorkspaceStatuses } from "./use-workspace-statuses";
import { useWorkspaces } from "./use-orchestration";

/** How long the pointer rests on the strip before the sidebar opens over the page. */
export const OPEN_AFTER_MS = 150;
/** How long the pointer may be off the strip and the sidebar before it closes. */
export const CLOSE_AFTER_MS = 300;

const STOP = { [OVERVIEW_STOP]: "" };

/** What a menu, card, list or dialog opened from the sidebar is drawn in, portalled out of it. */
const POPUP = '[data-surface="overlay"], [role="menu"], [role="listbox"], [role="dialog"]';

/** The current workspace's tile, or the solo threads' while one is in view: the solid tile. */
const CURRENT = "aria-[current=true]:bg-sidebar-row-active aria-[current=true]:text-foreground";

/** Opens the sidebar over the page at once, from a tile whose click means "show me the rest". */
type OpenNow = () => void;

/** One of the strip's tiles: an icon or a monogram, its name on hover and to a screen reader. */
function Tile({
  label,
  testId,
  expanded,
  current,
  className,
  onClick,
  children,
  ...data
}: {
  label: string;
  testId: string;
  expanded?: boolean;
  current?: boolean;
  className?: string;
  onClick: () => void;
  children: ReactNode;
} & Record<`data-${string}`, string | undefined>) {
  return (
    <Hint
      label={label}
      side="right"
      // The sidebar beside the strip says each name in full, where a tooltip would cover it.
      disabled={useStripOpen()}
      render={
        <button
          type="button"
          {...STOP}
          {...data}
          data-testid={testId}
          aria-label={label}
          aria-expanded={expanded}
          aria-current={current || undefined}
          onClick={onClick}
          className={cn(RAIL_TILE, CURRENT, className)}
        />
      }
    >
      {children}
    </Hint>
  );
}

/**
 * The overview's compact form: a quiet strip of what the open sidebar holds, in its order. On its
 * own, Gram's strip leads with Hide sidebar in the title bar's row, then Needs you with a dot while
 * anything waits, Search, a monogram per workspace (a dot for its asks, a soft one while its workers
 * work) and the solo threads' glyph, with History and Settings at its foot. Mounted by an app in
 * front of Gram, it has that app's switcher and places instead of the workspaces. Resting the
 * pointer on it, or moving focus into it, slides the open sidebar over the page beside it; leaving
 * both, Escape, or going somewhere closes it, and its header's pin keeps it open.
 */
export function OverviewRail() {
  const hosted = useEmbedShell((s) => s.hosted);
  const threadsListed = useThreadsListed();
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const strip = useRef<HTMLElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const width = useLayoutStore((s) => s.sidebarWidth);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  // Where the strip ends, which the sidebar opens beside: read as it opens.
  const [left, setLeft] = useState(0);
  const show = (next: boolean) => {
    if (next) setLeft(strip.current?.getBoundingClientRect().right ?? 0);
    setOpen(next);
  };
  const later = (next: boolean, ms: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => show(next), ms);
  };
  const now = (next: boolean) => {
    clearTimeout(timer.current);
    show(next);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  // The column may still be narrowing to the strip as it opens: the sidebar keeps beside its edge.
  useEffect(() => {
    const element = strip.current;
    if (!open || element === null) return;
    const observer = new ResizeObserver(() => setLeft(element.getBoundingClientRect().right));
    observer.observe(element);
    return () => observer.disconnect();
  }, [open]);
  // Going somewhere closes it: a row picked in it has done its job.
  const [at, setAt] = useState(pathname);
  if (at !== pathname) {
    setAt(pathname);
    if (open) setOpen(false);
  }
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      clearTimeout(timer.current);
      setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  const inside = (node: EventTarget | null) =>
    node instanceof Element &&
    (strip.current?.contains(node) === true ||
      overlay.current?.contains(node) === true ||
      // A menu, card or dialog opened from the sidebar is portalled out of it, but is still its.
      node.closest(POPUP) !== null);
  const leave = (event: { relatedTarget: EventTarget | null }) => {
    if (!inside(event.relatedTarget)) later(false, CLOSE_AFTER_MS);
  };
  // While it is open, wherever the pointer goes decides: onto the page closes it after a moment,
  // back onto the strip, the sidebar or something opened from it keeps it.
  useEffect(() => {
    if (!open) return;
    const over = (event: PointerEvent) => {
      if (inside(event.target)) clearTimeout(timer.current);
      else later(false, CLOSE_AFTER_MS);
    };
    const out = (event: PointerEvent) => {
      if (event.relatedTarget === null) later(false, CLOSE_AFTER_MS);
    };
    document.addEventListener("pointerover", over);
    document.documentElement.addEventListener("pointerout", out);
    return () => {
      document.removeEventListener("pointerover", over);
      document.documentElement.removeEventListener("pointerout", out);
    };
  });

  return (
    <StripOpen value={open}>
      <aside
        ref={strip}
        aria-label="Overview"
        data-testid="overview-rail"
        data-hosted={hosted ? "" : undefined}
        data-surface="chrome"
        data-open={open || undefined}
        {...{ [OVERVIEW_ROOT]: "compact" }}
        onPointerEnter={() => {
          if (!open) later(true, OPEN_AFTER_MS);
        }}
        // A click on a tile goes somewhere itself: the sidebar a resting pointer was about to open
        // would only cover where it went.
        onClick={() => {
          if (!open) clearTimeout(timer.current);
        }}
        // From the keyboard only: a click's focus is the click's, which goes somewhere itself.
        onFocus={(event) => {
          if (event.target instanceof Element && event.target.matches(":focus-visible")) now(true);
        }}
        onBlur={leave}
        className={cn(
          "flex min-h-0 flex-1 flex-col items-center gap-3.5 border-r border-sidebar-divider bg-sidebar pb-2 text-sidebar-foreground",
          hosted && "pt-2",
        )}
      >
        {hosted ? (
          <HostedHead />
        ) : (
          <>
            <TitleRow />
            <OwnHead />
          </>
        )}
        {hosted ? (
          <>
            <EmbedRailNavigation placement="main" quiet />
            <div className="flex-1" />
          </>
        ) : (
          <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-3.5 overflow-y-auto overscroll-contain [scrollbar-width:none]">
            <EmbedRailNavigation placement="main" quiet />
            {threadsListed && (
              <>
                <WorkspaceTiles />
                <SoloTile openNow={() => now(true)} />
              </>
            )}
          </div>
        )}
        <EmbedRailNavigation placement="foot" quiet />
        <StripFoot />
      </aside>
      {open && <SidebarOver ref={overlay} left={left} width={width} onBlur={leave} />}
    </StripOpen>
  );
}

/**
 * The title bar's height, a drag region as the title bar is. Hide sidebar sits in it, in the spot
 * the open sidebar's and the title bar's take, so the toggle never moves; under macOS's window
 * buttons the row is theirs, and the toggle leads the strip just below.
 */
function TitleRow() {
  const underLights = useWindowLights((s) => s.inset > 0);
  return (
    <div className="flex h-(--titlebar-height) shrink-0 items-center self-stretch px-2 [-webkit-app-region:drag]">
      {/* The title bar's own toggle's size and place, so it is the same spot in every mode. */}
      {!underLights && <HideTile className="size-7" />}
    </div>
  );
}

function HideTile({ className }: { className?: string }) {
  const hint = useShortcutHint("sidebar.toggle");
  return (
    <Tile
      label={withHint("Hide sidebar", hint)}
      testId="overview-hide"
      className={cn("[-webkit-app-region:no-drag]", className)}
      onClick={toggleOverviewSidebar}
    >
      <PanelLeftClose aria-hidden className="size-icon-row" />
    </Tile>
  );
}

/** Needs you, always there with a dot while anything waits, and Search: the open sidebar's head. */
function OwnHead() {
  const underLights = useWindowLights((s) => s.inset > 0);
  const { count, parts, openAsks } = useNeedsYouPill();
  return (
    <div className="flex shrink-0 flex-col items-center gap-px">
      {underLights && <HideTile />}
      <Tile
        label={needsYouSpoken(count, parts)}
        testId="overview-rail-needs-you"
        data-count={String(count)}
        onClick={openAsks}
      >
        <Inbox aria-hidden className="size-icon-row" />
        {count > 0 && <NeedsDot testId="overview-rail-needs-you-dot" />}
      </Tile>
      <SearchTile />
    </div>
  );
}

/** The embedding app's switcher, Needs you while anything waits, and Search. */
function HostedHead() {
  const own = useNeedsYouPill();
  // The embedding app's own count of what needs someone, where it gives one.
  const host = useHostAttention();
  const count = host?.count ?? own.count;
  return (
    <div className="flex shrink-0 flex-col items-center gap-px">
      <EmbedSwitcher placement="rail" className="mb-2" />
      {/* An embedding app with nothing waiting has no tile: its own row for it is in its places. */}
      {(host === undefined || count > 0) && (
        <Tile
          label={
            host === undefined
              ? needsYouSpoken(own.count, own.parts)
              : count > 0
                ? host.words
                : "Needs you"
          }
          testId="overview-rail-needs-you"
          data-count={String(count)}
          onClick={host?.open ?? own.openAsks}
        >
          <Inbox aria-hidden className="size-icon-row" />
          {count > 0 && <NeedsDot testId="overview-rail-needs-you-dot" />}
        </Tile>
      )}
      <SearchTile />
    </div>
  );
}

const NeedsDot = ({ testId }: { testId: string }) => (
  <span
    aria-hidden
    data-testid={testId}
    className="absolute top-1 right-1 size-1.5 rounded-full bg-status-needs-mark"
  />
);

function SearchTile() {
  const hint = useShortcutHint("palette.open");
  const paletteOpen = useLayoutStore((s) => s.paletteOpen);
  return (
    <Tile
      label={withHint("Search", hint)}
      testId="overview-rail-search"
      expanded={paletteOpen}
      onClick={() => useLayoutStore.getState().openPalette()}
    >
      <Search aria-hidden className="size-icon-row" />
    </Tile>
  );
}

/** One monogram per workspace, in the switcher's order, as the open overview's rows. */
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
  if (workspaces.length === 0) return null;
  const marks = monograms(workspaces.map((state) => state.workspace.name));
  return (
    <div className="flex shrink-0 flex-col items-center gap-px">
      {workspaces.map((state, index) => {
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
      })}
    </div>
  );
}

const NO_ASKING: ReadonlySet<ThreadId> = new Set();

/**
 * A workspace's monogram: one letter of its name ("B" for billing-api), two only where another
 * starts with the same one (`monograms`). A dot at its top says it asks something, a soft pulsing
 * one at its foot that its orchestrator or workers are at work; paused or parked, it fades. Its name and state are its
 * hint and its accessible name; a click goes to it.
 */
function WorkspaceTile({
  mark,
  state,
  here,
  asks,
  asking,
  ledger,
  word,
}: {
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
  const { live, working } = useWorkerTally(id, ledger, asking);
  const hover = orchestratorHover(word, { live, working, asks }, ledgerSlotsText(ledger));
  const busy = tileWorking(word, working);
  return (
    <Tile
      label={`${state.workspace.name}, ${hover}`}
      testId="overview-tile"
      data-workspace-id={id}
      data-state={word}
      current={here}
      className={cn((word === "paused" || word === "parked") && "opacity-60")}
      onClick={() => switchTo(state.workspace)}
    >
      <span
        aria-hidden
        data-testid="overview-tile-mark"
        className="text-body-strong leading-none tracking-normal"
      >
        {mark}
      </span>
      {asks > 0 && <NeedsDot testId="overview-tile-asks" />}
      {busy && (
        <span
          aria-hidden
          data-testid="overview-tile-working"
          className="absolute right-1 bottom-1 size-1.5 rounded-full bg-status-working gram-working"
        />
      )}
    </Tile>
  );
}

/** The threads outside any workspace, as one glyph; a click shows them in the sidebar beside it. */
function SoloTile({ openNow }: { openNow: OpenNow }) {
  const here = useViewSolo();
  return (
    <Tile
      label="Solo threads"
      testId="overview-tile"
      data-tile="solo"
      current={here}
      onClick={openNow}
    >
      <MessageSquare aria-hidden data-testid="overview-tile-glyph" className="size-icon-row" />
    </Tile>
  );
}

/** History and Settings, at the foot as the open sidebar has them. */
function StripFoot() {
  const historyHint = useShortcutHint("history.open");
  const historyOpen = useHistoryStore((s) => s.open);
  return (
    <div className="flex shrink-0 flex-col items-center gap-px">
      <Tile
        label={withHint("History", historyHint)}
        testId="overview-rail-history"
        expanded={historyOpen}
        onClick={() => useHistoryStore.getState().show()}
      >
        <History aria-hidden className="size-icon-row" />
      </Tile>
      <TopLeftNav update={false} hintSide="top" className="flex-col" />
    </div>
  );
}

/** The open sidebar, over the page beside the strip, sliding in unless motion is reduced. */
function SidebarOver({
  ref,
  left,
  width,
  onBlur,
}: {
  ref: Ref<HTMLDivElement>;
  left: number;
  width: number;
  onBlur: (event: { relatedTarget: EventTarget | null }) => void;
}) {
  const slides = useMotionLevel() === "full";
  const [shown, setShown] = useState(!slides);
  useEffect(() => {
    if (shown) return;
    const frame = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(frame);
  }, [shown]);
  return (
    <div
      ref={ref}
      data-testid="overview-rail-overlay"
      onBlur={onBlur}
      className={cn(
        // On an opaque surface: the sidebar's own is see-through, for the window behind it.
        "fixed inset-y-0 z-40 flex bg-surface-1 shadow-overlay",
        slides && "transition-[translate,opacity] duration-(--dur-move-base) ease-(--ease-out)",
        shown ? "translate-x-0 opacity-100" : "-translate-x-3 opacity-0",
      )}
      style={{ left, width }}
    >
      <OverviewSidebar onPin={() => switchOverview("open")} />
    </div>
  );
}
