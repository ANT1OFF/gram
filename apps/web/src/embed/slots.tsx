import { Link, useMatches, useParams, useRouterState } from "@tanstack/react-router";
import { ChevronDown } from "lucide-react";
import { createElement, useEffect, useId, useMemo, useRef, type ReactNode } from "react";

import { Hint } from "@/components/hint";
import { Avatar } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { OVERVIEW_STOP } from "@/shell/focus-regions";
import { useShowingNotFound } from "@/shell/not-found";

import { Glide } from "./glide";
import { useStripOpen } from "./strip-open";
import type {
  ShellNavigationGroup,
  ShellNavigationItem,
  ShellNavigationPlacement,
  ShellPlacement,
} from "./contract";
import { useGroupFold } from "./folded";
import {
  itemName,
  currentDestination,
  headingTo,
  hiddenCount,
  navigationAt,
  shownCount,
  shownNavigation,
  shownRows,
  useEmbedShell,
  useRoomySidebar,
  useThreadsTitle,
} from "./store";

/** The embedding app's switcher, where the shell has room for one. */
export function EmbedSwitcher({
  placement,
  className,
}: {
  placement: ShellPlacement;
  className?: string;
}) {
  const switcher = useEmbedShell((s) => s.workspaceSwitcher);
  const inTitlebar = useEmbedShell((s) => s.sidebar.switcher === "titlebar");
  if (switcher === undefined || (inTitlebar && placement !== "titlebar")) return null;
  return (
    <div
      data-testid="embed-switcher"
      data-placement={placement}
      className={cn("flex min-w-0 shrink-0 [-webkit-app-region:no-drag]", className)}
    >
      {createElement(switcher, { placement })}
    </div>
  );
}

export const usePathname = () => useRouterState({ select: (state) => state.location.pathname });

/**
 * The `to` of the navigation row the window is at, among every group's: the row to mark current,
 * in the sidebar, the compact sidebar and a phone's menu alike.
 */
export function useCurrentDestination(): string | undefined {
  const groups = useEmbedShell((s) => s.navigation);
  const pathname = usePathname();
  return useMemo(
    () =>
      currentDestination(
        pathname,
        shownNavigation(groups).flatMap((group) => group.items),
      ),
    [groups, pathname],
  );
}

/** The added pages take their path as a string: the router's typed `to` knows only Gram's own. */
export const linkTo = (to: string) => ({ to }) as unknown as { to: "/" };

function Monogram({ label, className }: { label: string; className?: string }) {
  return (
    <span aria-hidden className={cn("grid place-items-center text-caption font-medium", className)}>
      {label.trim().charAt(0).toUpperCase()}
    </span>
  );
}

export function ItemIcon({ item, className }: { item: ShellNavigationItem; className: string }) {
  const Icon = item.icon;
  const mark = item.mark;
  if (mark !== undefined)
    return (
      <Avatar {...mark} name={mark.name ?? item.label} size="xs" testId="embed-navigation-mark" />
    );
  return Icon === undefined ? (
    <Monogram label={item.label} className={className} />
  ) : (
    <Icon aria-hidden className={className} />
  );
}

/** A mark's status in words after a row's name, for a screen reader. */
export function MarkStatus({ item }: { item: ShellNavigationItem }) {
  const words = item.mark?.statusLabel;
  return words === undefined || words === "" ? null : <span className="sr-only">, {words}</span>;
}

/** A row's name for a screen reader where only its icon shows: with its mark's status. */
export const spokenStatus = (item: ShellNavigationItem, name: string): string =>
  item.mark?.statusLabel === undefined || item.mark.statusLabel === ""
    ? name
    : `${name}, ${item.mark.statusLabel}`;

/** The ground a mark's status dot is ringed in: the sidebar's own. */
export const MARK_GROUND = "[--mark-ground:var(--color-sidebar)]";

const NAV_ROW =
  "relative flex h-8 min-w-0 items-center gap-1.5 rounded-(--radius-sm) pr-1.5 pl-1 text-muted-foreground outline-none [:where(&)_svg]:text-sidebar-icon transition-[background-color,color,scale] duration-(--dur-fast) ease-(--ease-out) hover:bg-sidebar-row-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-safe:active:scale-[0.98] aria-[current=page]:text-foreground aria-[current=page]:[&_svg]:text-primary aria-[current=page]:hover:bg-transparent in-data-phone-drawer:h-11 in-data-phone-drawer:gap-2.5 in-data-phone-drawer:px-2";

/**
 * A row in the `roomy` sidebar: taller, its label in the body's stronger weight and the foreground
 * colour, bold while it is where the window is, on the list's `Glide` as its fill. Its icon sits in
 * a `RoomyTile`.
 */
export const ROOMY_ROW =
  "group/row relative flex h-10 scroll-my-5 in-data-phone-drawer:h-11 min-w-0 items-center gap-3 rounded-(--radius-sm) pr-2 pl-1 text-left text-body-strong text-foreground outline-none transition-[background-color,color,scale] duration-(--dur-fast) ease-(--ease-out) hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset motion-safe:active:scale-[0.98] aria-[current=page]:font-semibold aria-[current=page]:hover:bg-transparent aria-expanded:bg-sidebar-row-hover";

/**
 * The square an icon of a `roomy` row sits in, which lines the labels up. The icon is quiet grey,
 * the foreground's colour under the pointer and while the row is where the window is, and it grows
 * a touch under the pointer.
 */
export function RoomyTile({ children }: { children: ReactNode }) {
  return (
    <span className="relative grid size-8 shrink-0 place-items-center rounded-(--radius-sm) text-muted-foreground transition-colors duration-(--dur-fast) group-hover/row:text-foreground group-aria-[current=page]/row:text-primary *:size-4.5 [:where(&)>svg]:text-sidebar-icon group-aria-[current=page]/row:*:text-primary *:transition-transform *:duration-(--dur-fast) *:ease-(--ease-out) motion-safe:group-hover/row:*:scale-110">
      {children}
    </span>
  );
}

/** A shortcut's keys apart, each its own cap: `Ctrl+K` as Ctrl and K, `⌘K` as ⌘ and K. */
export const keyCaps = (hint: string): readonly string[] => {
  if (hint.length > 1 && hint.includes("+")) return hint.split("+").filter((key) => key !== "");
  const [, mods = "", key = ""] = /^([⌃⌘⌥⇧]*)(.*)$/u.exec(hint) ?? [];
  return [...mods, ...(key === "" ? [] : [key])];
};

/** A shortcut drawn as key caps, as the `roomy` sidebar's search has it. */
export function KeyCaps({ hint }: { hint: string }) {
  if (hint === "") return null;
  return (
    <span aria-hidden data-testid="key-caps" className="flex shrink-0 items-center gap-1">
      {keyCaps(hint).map((key, i) => (
        <kbd
          key={i}
          className="inline-flex h-5 min-w-5 items-center justify-center rounded-2xs border border-border bg-background px-1 font-mono text-caption text-muted-foreground"
        >
          {key}
        </kbd>
      ))}
    </span>
  );
}

/** The embedding app's head of the sidebar: its mark and name. Nothing when it supplied none. */
export function EmbedSidebarHeader({ className }: { className?: string }) {
  const header = useEmbedShell((s) => s.sidebar.header);
  if (header === undefined) return null;
  return (
    <div
      data-testid="embed-sidebar-header"
      className={cn("flex min-w-0 flex-1 items-center [-webkit-app-region:no-drag]", className)}
    >
      {createElement(header, { placement: "sidebar" })}
    </div>
  );
}

/** The embedding app's account, at the sidebar's foot. Nothing when it supplied none. */
export function EmbedAccount({ className }: { className?: string }) {
  const account = useEmbedShell((s) => s.sidebar.account);
  if (account === undefined) return null;
  return (
    <div data-testid="embed-account" className={cn("flex min-w-0 shrink-0", className)}>
      {createElement(account, { placement: "sidebar" })}
    </div>
  );
}

function Count({ count }: { count: number | undefined }) {
  const shown = shownCount(count);
  if (shown === undefined) return null;
  return (
    <span
      data-testid="embed-navigation-count"
      className="shrink-0 text-meta text-muted-foreground tabular-nums"
    >
      {shown}
    </span>
  );
}

/**
 * The added navigation groups at one place in the open sidebar and the phone's drawer: each its
 * heading, when it has one, and its destinations as rows. `main` is at the top of the sidebar's
 * list, under Needs you and search, as places you work in; `foot` is below the threads and above
 * History, with the places you go to.
 */
export function EmbedNavigation({ placement = "foot" }: { placement?: ShellNavigationPlacement }) {
  const groups = navigationAt(
    useEmbedShell((s) => s.navigation),
    placement,
  );
  const roomy = useRoomySidebar();
  const list = useRef<HTMLElement>(null);
  const at = useCurrentDestination();
  useEffect(() => {
    if (at === undefined) return;
    list.current
      ?.querySelector<HTMLElement>('[aria-current="page"]:not([data-glide-skip])')
      ?.scrollIntoView?.({ block: "nearest" });
  }, [at]);
  if (groups.length === 0) return null;
  const main = placement === "main";
  return (
    <nav
      ref={list}
      aria-label={main ? "Places" : "More places"}
      data-testid={main ? "embed-navigation-main" : "embed-navigation"}
      data-placement={placement}
      data-look={roomy ? "roomy" : undefined}
      className={cn(
        "relative flex shrink-0 flex-col text-body",
        MARK_GROUND,
        roomy ? "gap-0" : "gap-tight",
        !main && "border-t border-border px-inset py-tight",
      )}
    >
      <Glide />
      {groups.map((group) => (
        <EmbedGroup key={group.id} group={group} roomy={roomy} at={at} />
      ))}
    </nav>
  );
}

function EmbedGroup({
  group,
  roomy,
  at,
}: {
  group: ShellNavigationGroup;
  roomy: boolean;
  at: string | undefined;
}) {
  const fold = useGroupFold(group);
  const rows = useId();
  const items = shownRows(group, fold.open, at);
  const hidden = hiddenCount(group, fold.open, at);
  const page = headingTo(group);
  const pathname = usePathname();
  const heading = roomy
    ? "flex h-5 items-end px-2 pt-3 pb-1 text-caption font-medium tracking-[0.08em] text-muted-foreground uppercase box-content"
    : "flex h-6 items-center px-1.5 text-meta text-muted-foreground";
  return (
    <section
      {...(group.label === undefined ? {} : { "aria-label": group.label })}
      data-testid="embed-navigation-group"
      data-open={fold.foldable ? String(fold.open) : undefined}
    >
      {group.label !== undefined &&
        (page !== undefined ? (
          <h2
            data-testid="embed-navigation-heading"
            className={cn("flex min-w-0 items-center gap-1", roomy && "pt-3")}
          >
            <Link
              {...linkTo(page)}
              {...{ [OVERVIEW_STOP]: "" }}
              data-testid="embed-navigation-heading-link"
              data-glide-skip=""
              aria-current={pathname === page ? "page" : undefined}
              className={cn(
                heading,
                "relative",
                roomy && "box-border h-6 pt-0",
                "min-w-0 flex-1 rounded-(--radius-sm) outline-none transition-colors duration-(--dur-fast) hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:text-foreground",
              )}
            >
              <span className="min-w-0 flex-1 truncate">{group.label}</span>
            </Link>
            {hidden !== undefined && (
              <span
                data-testid="embed-navigation-hidden-count"
                className="shrink-0 text-meta text-muted-foreground tabular-nums"
              >
                {hidden}
              </span>
            )}
            {fold.foldable && (
              <button
                type="button"
                {...{ [OVERVIEW_STOP]: "" }}
                data-testid="embed-navigation-toggle"
                aria-label={hidden === undefined ? group.label : `${group.label}, ${hidden}`}
                aria-expanded={fold.open}
                aria-controls={rows}
                onClick={fold.toggle}
                className="grid size-6 shrink-0 place-items-center rounded-(--radius-sm) text-muted-foreground outline-none transition-colors duration-(--dur-fast) hover:bg-sidebar-row-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ChevronDown
                  aria-hidden
                  className={cn(
                    "size-3.5 transition-transform duration-(--dur-fast)",
                    !fold.open && "-rotate-90",
                  )}
                />
              </button>
            )}
          </h2>
        ) : fold.foldable ? (
          <h2 data-testid="embed-navigation-heading" className={roomy ? "pt-3" : undefined}>
            <button
              type="button"
              {...{ [OVERVIEW_STOP]: "" }}
              data-testid="embed-navigation-toggle"
              aria-expanded={fold.open}
              aria-controls={rows}
              onClick={fold.toggle}
              className={cn(
                heading,
                roomy && "box-border h-6 pt-0",
                "w-full gap-1 rounded-(--radius-sm) text-left outline-none transition-colors duration-(--dur-fast) hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
              )}
            >
              <span className="min-w-0 flex-1 truncate">{group.label}</span>
              {hidden !== undefined && (
                <span
                  data-testid="embed-navigation-hidden-count"
                  className="shrink-0 tracking-normal normal-case tabular-nums"
                >
                  {hidden}
                </span>
              )}
              <ChevronDown
                aria-hidden
                className={cn(
                  "size-3.5 shrink-0 transition-transform duration-(--dur-fast)",
                  !fold.open && "-rotate-90",
                )}
              />
            </button>
          </h2>
        ) : (
          <h2 {...(roomy ? { "data-testid": "embed-navigation-heading" } : {})} className={heading}>
            {group.label}
          </h2>
        ))}
      <ul id={rows} className="flex flex-col gap-px">
        {items.map((item) => {
          const current = item.to === at;
          return (
            <li key={item.id}>
              <Link
                {...linkTo(item.to)}
                {...{ [OVERVIEW_STOP]: "" }}
                data-testid="embed-navigation-item"
                aria-current={current ? "page" : undefined}
                className={roomy ? ROOMY_ROW : NAV_ROW}
              >
                {roomy && item.mark !== undefined ? (
                  <span className="grid size-8 shrink-0 place-items-center">
                    <ItemIcon item={item} className="shrink-0" />
                  </span>
                ) : roomy ? (
                  <RoomyTile>
                    <ItemIcon item={item} className="shrink-0" />
                  </RoomyTile>
                ) : (
                  <ItemIcon item={item} className="size-icon-row shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate">
                  {item.label}
                  <MarkStatus item={item} />
                </span>
                <Count count={item.count} />
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** A compact tile: the open row's height, filled while it is where the window is. */
export const RAIL_TILE =
  "relative grid size-8 shrink-0 place-items-center rounded-(--radius-sm) text-muted-foreground outline-none [:where(&)_svg]:text-sidebar-icon transition-[background-color,color,scale] duration-(--dur-fast) ease-(--ease-out) hover:bg-sidebar-row-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-safe:active:scale-[0.98] aria-[current=page]:bg-sidebar-row-active aria-[current=page]:text-foreground aria-[current=page]:[&_svg]:text-primary aria-expanded:text-foreground";

const GLIDE_TILE = cn(
  RAIL_TILE,
  "aria-[current=page]:bg-transparent aria-[current=page]:hover:bg-transparent",
);

/**
 * The foot's places as a row of icons, for the `roomy` sidebar's foot: each its name on hover and
 * to a screen reader, filled while it is where the window is, a dot while its count is above 0.
 */
export function EmbedFootIcons() {
  const groups = navigationAt(
    useEmbedShell((s) => s.navigation),
    "foot",
  );
  const at = useCurrentDestination();
  return groups.flatMap((group) =>
    group.items.map((item) => {
      const count = shownCount(item.count);
      const name = spokenStatus(item, itemName(group, item.label));
      const spoken = count === undefined ? name : `${name}, ${count}`;
      return (
        <Hint
          key={item.id}
          label={spoken}
          side="top"
          render={
            <Link
              {...linkTo(item.to)}
              {...{ [OVERVIEW_STOP]: "" }}
              data-testid="embed-navigation-item"
              aria-label={spoken}
              aria-current={item.to === at ? "page" : undefined}
              className={RAIL_TILE}
            />
          }
        >
          <ItemIcon item={item} className="size-4.5" />
          {count !== undefined && (
            <span
              aria-hidden
              className="absolute top-1 right-1 size-1.5 rounded-full bg-status-needs-mark"
            />
          )}
        </Hint>
      );
    }),
  );
}

/**
 * The same destinations in the compact sidebar: an icon each, its group and name on hover, and a
 * dot on the tile while its count is above 0. `main` sits above the workspaces' tiles, `foot` at
 * the rail's foot. `quiet` draws the groups a gap apart with no rule between them, as the hosted
 * strip has them.
 */
export function EmbedRailNavigation({
  placement = "foot",
  quiet = false,
}: {
  placement?: ShellNavigationPlacement;
  quiet?: boolean;
}) {
  const groups = navigationAt(
    useEmbedShell((s) => s.navigation),
    placement,
  );
  const at = useCurrentDestination();
  const stripOpen = useStripOpen();
  if (groups.length === 0) return null;
  const main = placement === "main";
  return (
    <nav
      aria-label={main ? "Places" : "More places"}
      data-testid={main ? "embed-rail-navigation-main" : "embed-rail-navigation"}
      data-placement={placement}
      className={cn(
        "relative flex shrink-0 flex-col items-center",
        MARK_GROUND,
        quiet ? "gap-3.5" : "gap-1",
        !main && !quiet && "border-t border-sidebar-divider py-2",
      )}
    >
      <Glide />
      {groups.map((group) => (
        <div
          key={group.id}
          className={cn("flex flex-col items-center", quiet ? "gap-px" : "gap-1")}
        >
          {group.items.map((item) => {
            const current = item.to === at;
            const count = shownCount(item.count);
            const name = spokenStatus(item, itemName(group, item.label));
            const spoken = count === undefined ? name : `${name}, ${count}`;
            return (
              <Hint
                key={item.id}
                label={quiet ? item.label : spoken}
                side="right"
                disabled={stripOpen}
                render={
                  <Link
                    {...linkTo(item.to)}
                    {...{ [OVERVIEW_STOP]: "" }}
                    data-testid="embed-navigation-item"
                    aria-label={spoken}
                    aria-current={current ? "page" : undefined}
                    className={GLIDE_TILE}
                  />
                }
              >
                <ItemIcon item={item} className="size-icon-row" />
                {count !== undefined && (
                  <span
                    aria-hidden
                    data-testid="embed-navigation-dot"
                    className="absolute top-1 right-1 size-1.5 rounded-full bg-foreground"
                  />
                )}
              </Hint>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

/**
 * The name of the page the window is on, where the title bar says it in place of the workspace and
 * its views: an added page's (the one it brought; undefined if none) or the Threads page's.
 * Undefined on Gram's other pages.
 */
export function useEmbedPageTitle(): string | undefined {
  const titles = useEmbedShell((s) => s.titles);
  const missing = useShowingNotFound();
  const threads = useThreadsTitle();
  const path = useMatches({ select: (matches) => matches.at(-1)?.fullPath as string | undefined });
  if (missing && Object.keys(titles).length > 0) return "Not found";
  return path === undefined
    ? undefined
    : (titles[path] ?? (path === "/threads" ? threads : undefined));
}

/**
 * The heading of the group whose destination the window is at, or undefined at none: on a phone,
 * the line under an added page's name says where it is listed.
 */
export function useEmbedPageGroup(): string | undefined {
  const groups = useEmbedShell((s) => s.navigation);
  const at = useCurrentDestination();
  return at === undefined
    ? undefined
    : shownNavigation(groups).find((group) => group.items.some((item) => item.to === at))?.label;
}

/** An added page's name in the title bar, where Gram's own pages name the workspace. */
export function EmbedPageTitle({ title }: { title: string }) {
  return (
    <h1
      data-testid="embed-page-title"
      className="gram-fade min-w-0 truncate px-2 text-body font-medium text-foreground"
    >
      {title}
    </h1>
  );
}

/** The embedding app's home page at `/`, in the conversation's place as an added page is. */
export function EmbedHome() {
  const home = useEmbedShell((s) => s.home);
  const params: Readonly<Record<string, string>> = useParams({ strict: false });
  if (home === undefined) return null;
  return (
    <section data-testid="embed-page" data-path="/" className="min-h-0 flex-1 overflow-y-auto">
      {createElement(home, { params })}
    </section>
  );
}
