import { useRouterState } from "@tanstack/react-router";
import { History, Inbox, Search } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";

import { Hint } from "@/components/hint";
import { useHistoryStore } from "@/history/history-view";
import { useShortcutHint, withHint } from "@/keyboard/use-shortcut-hint";
import { cn } from "@/lib/utils";
import { useMotionLevel } from "@/motion";
import { needsYouSpoken } from "@/orchestration/needs-you-entry";
import { OverviewSidebar, switchOverview } from "@/orchestration/overview-sidebar";
import { useNeedsYouPill } from "@/orchestration/use-needs-you";
import { OVERVIEW_STOP } from "@/shell/focus-regions";
import { TopLeftNav } from "@/shell/top-left-nav";
import { useLayoutStore } from "@/stores/layout";
import { OVERVIEW_ROOT } from "@/views/shell-layout";

import { useHostAttention } from "./attention";
import { EmbedRailNavigation, EmbedSwitcher, RAIL_TILE } from "./slots";
import { StripOpen, useStripOpen } from "./strip-open";

/** How long the pointer rests on the strip before the sidebar opens over the page. */
export const OPEN_AFTER_MS = 150;
/** How long the pointer may be off the strip and the sidebar before it closes. */
export const CLOSE_AFTER_MS = 300;

const STOP = { [OVERVIEW_STOP]: "" };

/** One of the strip's own tiles: an icon, its name on hover and to a screen reader. */
function Tile({
  label,
  testId,
  expanded,
  onClick,
  children,
}: {
  label: string;
  testId: string;
  expanded?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Hint
      label={label}
      side="right"
      disabled={useStripOpen()}
      render={
        <button
          type="button"
          {...STOP}
          data-testid={testId}
          aria-label={label}
          aria-expanded={expanded}
          onClick={onClick}
          className={RAIL_TILE}
        />
      }
    >
      {children}
    </Hint>
  );
}

/**
 * The compact sidebar for an app in front of Gram: a quiet strip of what the open sidebar holds,
 * in its order (the embedding app's switcher, Needs you with a dot while anything waits, Search,
 * the app's places a gap apart per group, then at the foot its other places, History and
 * Settings), and no workspace or thread tiles. Resting the pointer on it, or moving focus into it,
 * slides the open sidebar over the page beside it; leaving both, Escape, or going somewhere closes
 * it, and its header's pin keeps it open.
 */
export function HostedRail() {
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
    node instanceof Node &&
    (strip.current?.contains(node) === true || overlay.current?.contains(node) === true);
  const leave = (event: { relatedTarget: EventTarget | null }) => {
    if (!inside(event.relatedTarget)) later(false, CLOSE_AFTER_MS);
  };

  return (
    <StripOpen value={open}>
      <aside
        ref={strip}
        aria-label="Overview"
        data-testid="overview-rail"
        data-hosted=""
        data-surface="chrome"
        data-open={open || undefined}
        {...{ [OVERVIEW_ROOT]: "compact" }}
        onPointerEnter={() => later(true, OPEN_AFTER_MS)}
        onPointerLeave={leave}
        // From the keyboard only: a click's focus is the click's, which goes somewhere itself.
        onFocus={(event) => {
          if (event.target instanceof Element && event.target.matches(":focus-visible")) now(true);
        }}
        onBlur={leave}
        className="flex min-h-0 flex-1 flex-col items-center gap-3.5 border-r border-sidebar-divider bg-sidebar py-2 text-sidebar-foreground"
      >
        <StripHead />
        <EmbedRailNavigation placement="main" quiet />
        <div className="flex-1" />
        <EmbedRailNavigation placement="foot" quiet />
        <StripFoot />
      </aside>
      {open && (
        <SidebarOver
          ref={overlay}
          left={left}
          width={width}
          onPointerEnter={() => clearTimeout(timer.current)}
          onPointerLeave={leave}
          onBlur={leave}
        />
      )}
    </StripOpen>
  );
}

/** The switcher, Needs you and Search: the open sidebar's head. */
function StripHead() {
  const own = useNeedsYouPill();
  // The embedding app's own count of what needs someone, where it gives one.
  const host = useHostAttention();
  const count = host?.count ?? own.count;
  const searchHint = useShortcutHint("palette.open");
  const paletteOpen = useLayoutStore((s) => s.paletteOpen);
  return (
    <div className="flex flex-col items-center gap-px">
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
          testId="hosted-rail-needs-you"
          onClick={host?.open ?? own.openAsks}
        >
          <Inbox aria-hidden className="size-icon-row" />
          {count > 0 && (
            <span
              aria-hidden
              data-testid="hosted-rail-needs-you-dot"
              className="absolute top-1 right-1 size-1.5 rounded-full bg-status-needs-mark"
            />
          )}
        </Tile>
      )}
      <Tile
        label={withHint("Search", searchHint)}
        testId="hosted-rail-search"
        expanded={paletteOpen}
        onClick={() => useLayoutStore.getState().openPalette()}
      >
        <Search aria-hidden className="size-icon-row" />
      </Tile>
    </div>
  );
}

/** History and Settings, at the foot as the open sidebar has them. */
function StripFoot() {
  const historyHint = useShortcutHint("history.open");
  const historyOpen = useHistoryStore((s) => s.open);
  return (
    <div className="flex flex-col items-center gap-px">
      <Tile
        label={withHint("History", historyHint)}
        testId="hosted-rail-history"
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
  onPointerEnter,
  onPointerLeave,
  onBlur,
}: {
  ref: Ref<HTMLDivElement>;
  left: number;
  width: number;
  onPointerEnter: () => void;
  onPointerLeave: (event: { relatedTarget: EventTarget | null }) => void;
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
      data-testid="hosted-rail-overlay"
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onBlur={onBlur}
      className={cn(
        "fixed inset-y-0 z-40 flex shadow-overlay",
        slides && "transition-[translate,opacity] duration-(--dur-move-base) ease-(--ease-out)",
        shown ? "translate-x-0 opacity-100" : "-translate-x-3 opacity-0",
      )}
      style={{ left, width }}
    >
      <OverviewSidebar onPin={() => switchOverview("open")} />
    </div>
  );
}
