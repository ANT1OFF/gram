import { Link, useRouterState } from "@tanstack/react-router";
import { History, Inbox, PanelLeft, Search, Settings } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";

import { useHostAttention } from "@/embed/attention";
import { ItemIcon, linkTo, useCurrentDestination } from "@/embed/slots";
import { navigationAt, shownCount, useEmbedShell, useThreadsListed } from "@/embed/store";
import { useHistoryStore } from "@/history/history-view";
import { useShortcutHint, withHint } from "@/keyboard/use-shortcut-hint";
import { useLaunchIssues } from "@/launch-checks/banner";
import { cn } from "@/lib/utils";
import { useMotionLevel } from "@/motion";
import { needsYouSpoken } from "@/orchestration/needs-you-entry";
import { OverviewSidebar } from "@/orchestration/overview-sidebar";
import { useNeedsYouPill } from "@/orchestration/use-needs-you";
import { useLayoutStore } from "@/stores/layout";
import { DOCK_ITEM, NAV_REGION, useNavigationStore } from "@/stores/navigation";

/** One of the dock's items: its icon over a short label, the label its name to a screen reader. */
const ITEM =
  "relative flex min-w-14 flex-col items-center gap-0.5 rounded-(--radius-md) px-2 py-1 text-muted-foreground outline-none transition-[background-color,color] duration-(--dur-fast) ease-(--ease-out) [:where(&)_svg]:text-sidebar-icon hover:bg-sidebar-row-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-sidebar-row-active aria-expanded:text-foreground aria-[current=page]:bg-sidebar-row-active aria-[current=page]:text-foreground aria-[current=page]:[&_svg]:text-primary [&_svg]:size-icon-row";

const LABEL = "max-w-20 truncate text-caption leading-tight";

const Dot = ({ testId }: { testId: string }) => (
  <span
    aria-hidden
    data-testid={testId}
    className="absolute top-1 right-3 size-1.5 rounded-full bg-status-needs-mark"
  />
);

function DockButton({
  label,
  short,
  testId,
  expanded,
  onClick,
  children,
}: {
  label: string;
  short: string;
  testId: string;
  expanded?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      {...{ [DOCK_ITEM]: "" }}
      data-testid={testId}
      aria-label={label}
      title={label}
      aria-expanded={expanded}
      onClick={onClick}
      className={ITEM}
    >
      {children}
      <span aria-hidden className={LABEL}>
        {short}
      </span>
    </button>
  );
}

/** Needs you, with a dot while anything waits; the embedding app's own count where it gives one. */
function NeedsYouItem() {
  const own = useNeedsYouPill();
  const host = useHostAttention();
  const count = host?.count ?? own.count;
  const label =
    host === undefined
      ? needsYouSpoken(own.count, own.parts)
      : count > 0
        ? host.words
        : "Needs you";
  return (
    <DockButton
      label={label}
      short="Needs you"
      testId="nav-dock-needs-you"
      onClick={host?.open ?? own.openAsks}
    >
      <Inbox aria-hidden />
      {count > 0 && <Dot testId="nav-dock-needs-you-dot" />}
    </DockButton>
  );
}

/** The embedding app's places, `main` then `foot`, each its icon and its own short label. */
function PlaceItems() {
  const navigation = useEmbedShell((s) => s.navigation);
  const at = useCurrentDestination();
  const groups = [...navigationAt(navigation, "main"), ...navigationAt(navigation, "foot")];
  return groups.flatMap((group) =>
    group.items.map((item) => {
      const count = shownCount(item.count);
      return (
        <Link
          key={`${group.id}:${item.id}`}
          {...linkTo(item.to)}
          {...{ [DOCK_ITEM]: "" }}
          data-testid="nav-dock-place"
          aria-label={count === undefined ? item.label : `${item.label}, ${count}`}
          title={item.label}
          aria-current={item.to === at ? "page" : undefined}
          className={ITEM}
        >
          <ItemIcon item={item} className="size-icon-row" />
          {count !== undefined && <Dot testId="nav-dock-place-dot" />}
          <span aria-hidden className={LABEL}>
            {item.label}
          </span>
        </Link>
      );
    }),
  );
}

function SettingsItem() {
  const hint = useShortcutHint("settings.open");
  const setup = useLaunchIssues().dismissed;
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const label =
    setup.length === 0
      ? withHint("Settings", hint)
      : `Settings, ${setup.length === 1 ? "1 setup problem" : `${setup.length} setup problems`}`;
  return (
    <Link
      to={setup.length === 0 ? "/settings" : "/settings/diagnostics"}
      {...{ [DOCK_ITEM]: "" }}
      data-testid="nav-dock-settings"
      aria-label={label}
      title={label}
      aria-current={pathname.includes("/settings") ? "page" : undefined}
      className={ITEM}
    >
      <Settings aria-hidden />
      {setup.length > 0 && <Dot testId="nav-dock-settings-dot" />}
      <span aria-hidden className={LABEL}>
        Settings
      </span>
    </Link>
  );
}

/**
 * The main navigation as a rounded bar at the window's top or bottom: Needs you, Search, the
 * embedding app's places, Overview (the sidebar, over the page), History and Settings, each
 * an icon over a short label. Arrow keys move along it.
 */
export function NavDock({ edge }: { edge: "top" | "bottom" }) {
  const threadsListed = useThreadsListed();
  const sheet = useNavigationStore((s) => s.sheet);
  const setSheet = useNavigationStore((s) => s.setSheet);
  const paletteOpen = useLayoutStore((s) => s.paletteOpen);
  const historyOpen = useHistoryStore((s) => s.open);
  const searchHint = useShortcutHint("palette.open");
  const historyHint = useShortcutHint("history.open");
  const sidebarHint = useShortcutHint("sidebar.toggle");
  const bar = useRef<HTMLElement>(null);
  return (
    <nav
      ref={bar}
      aria-label="Navigation"
      data-testid="nav-dock"
      data-edge={edge}
      {...{ [NAV_REGION]: "dock" }}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        const items = [...(bar.current?.querySelectorAll<HTMLElement>(`[${DOCK_ITEM}]`) ?? [])];
        const index = items.indexOf(document.activeElement as HTMLElement);
        if (index === -1) return;
        event.preventDefault();
        const step = event.key === "ArrowRight" ? 1 : -1;
        items[(index + step + items.length) % items.length]?.focus();
      }}
      className="flex max-w-full items-end gap-0.5 overflow-x-auto rounded-(--radius-lg) border border-border bg-sidebar p-1 text-sidebar-foreground shadow-overlay [scrollbar-width:none]"
    >
      <NeedsYouItem />
      <DockButton
        label={withHint("Search", searchHint)}
        short="Search"
        testId="nav-dock-search"
        expanded={paletteOpen}
        onClick={() => useLayoutStore.getState().openPalette()}
      >
        <Search aria-hidden />
      </DockButton>
      <PlaceItems />
      {threadsListed && (
        <DockButton
          label={withHint("Overview", sidebarHint)}
          short="Overview"
          testId="nav-dock-overview"
          expanded={sheet}
          onClick={() => setSheet(!sheet)}
        >
          <PanelLeft aria-hidden />
        </DockButton>
      )}
      <DockButton
        label={withHint("History", historyHint)}
        short="History"
        testId="nav-dock-history"
        expanded={historyOpen}
        onClick={() => useHistoryStore.getState().show()}
      >
        <History aria-hidden />
      </DockButton>
      <SettingsItem />
    </nav>
  );
}

/**
 * The sidebar over the page from the dock's Overview, at the window's left between the dock
 * and the far edge. Escape, going somewhere, a click outside it or its Close closes it.
 */
export function DockSheet({ edge }: { edge: "top" | "bottom" }) {
  const open = useNavigationStore((s) => s.sheet);
  const setSheet = useNavigationStore((s) => s.setSheet);
  const width = useLayoutStore((s) => s.sidebarWidth);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  // Going somewhere closes it: a row picked in it has done its job.
  const at = useRef(pathname);
  useEffect(() => {
    if (at.current === pathname) return;
    at.current = pathname;
    setSheet(false);
  }, [pathname, setSheet]);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const inside = box.current?.contains(document.activeElement) === true;
      setSheet(false);
      if (inside) document.querySelector<HTMLElement>('[data-testid="nav-dock-overview"]')?.focus();
    };
    const onDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (box.current?.contains(target) || target.closest(`[${NAV_REGION}]`) !== null) return;
      if (target.closest('[data-surface="overlay"], [role="menu"], [role="dialog"]') !== null)
        return;
      setSheet(false);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open, setSheet]);
  if (!open) return null;
  return <SheetPanel ref={box} edge={edge} width={width} onClose={() => setSheet(false)} />;
}

function SheetPanel({
  ref,
  edge,
  width,
  onClose,
}: {
  ref: Ref<HTMLDivElement>;
  edge: "top" | "bottom";
  width: number;
  onClose: () => void;
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
      data-testid="nav-dock-sheet"
      className={cn(
        "fixed left-2 z-40 flex overflow-hidden rounded-(--radius-lg) bg-surface-1 shadow-overlay",
        edge === "top" ? "top-16 bottom-2" : "top-2 bottom-16",
        slides && "transition-[translate,opacity] duration-(--dur-move-base) ease-(--ease-out)",
        shown ? "opacity-100" : "-translate-x-3 opacity-0",
      )}
      style={{ width }}
    >
      <OverviewSidebar onClose={onClose} />
    </div>
  );
}
