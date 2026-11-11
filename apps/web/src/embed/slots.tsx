import { Link, useMatches, useParams, useRouterState } from "@tanstack/react-router";
import { createElement, useRef } from "react";

import { Hint } from "@/components/hint";
import { cn } from "@/lib/utils";
import { OVERVIEW_STOP } from "@/shell/focus-regions";

import { Glide } from "./glide";
import { useStripOpen } from "./strip-open";
import type { ShellNavigationItem, ShellNavigationPlacement, ShellPlacement } from "./contract";
import {
  itemName,
  navigationAt,
  navigationCurrent,
  shownCount,
  shownNavigation,
  useEmbedShell,
} from "./store";

// The places in Gram's shell an app in front of it may fill. Each draws nothing until something was
// added (`mountGram`), which never happens in Gram on its own.

/** The embedding app's switcher, where the shell has room for one. */
export function EmbedSwitcher({
  placement,
  className,
}: {
  placement: ShellPlacement;
  className?: string;
}) {
  const switcher = useEmbedShell((s) => s.workspaceSwitcher);
  if (switcher === undefined) return null;
  return (
    <div
      data-testid="embed-switcher"
      data-placement={placement}
      className={cn("flex min-w-0 shrink-0 [-webkit-app-region:no-drag]", className)}
    >
      {/* The embedding app's own component, held in the store: the same one from render to render. */}
      {createElement(switcher, { placement })}
    </div>
  );
}

const usePathname = () => useRouterState({ select: (state) => state.location.pathname });

/** The added pages take their path as a string: the router's typed `to` knows only Gram's own. */
const linkTo = (to: string) => ({ to }) as unknown as { to: "/" };

/** A first letter, where a destination brought no icon. */
function Monogram({ label, className }: { label: string; className?: string }) {
  return (
    <span aria-hidden className={cn("grid place-items-center text-caption font-medium", className)}>
      {label.trim().charAt(0).toUpperCase()}
    </span>
  );
}

function ItemIcon({ item, className }: { item: ShellNavigationItem; className: string }) {
  const Icon = item.icon;
  return Icon === undefined ? (
    <Monogram label={item.label} className={className} />
  ) : (
    <Icon aria-hidden className={className} />
  );
}

/**
 * A navigation row: its fill and colour ease in on hover, and it gives a little when pressed, under
 * the Motion setting. The current row's fill is the list's `Glide`, which moves between rows.
 */
const NAV_ROW =
  "relative flex h-8 min-w-0 items-center gap-1.5 rounded-(--radius-sm) pr-1.5 pl-1 text-muted-foreground outline-none transition-[background-color,color,scale] duration-(--dur-fast) ease-(--ease-out) hover:bg-sidebar-row-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-safe:active:scale-[0.98] aria-[current=page]:text-foreground aria-[current=page]:hover:bg-transparent in-data-phone-drawer:h-11 in-data-phone-drawer:gap-2.5 in-data-phone-drawer:px-2";

/** A row's count, at its end. */
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
  const pathname = usePathname();
  const list = useRef<HTMLElement>(null);
  if (groups.length === 0) return null;
  const main = placement === "main";
  return (
    <nav
      ref={list}
      aria-label={main ? "Places" : "More places"}
      data-testid={main ? "embed-navigation-main" : "embed-navigation"}
      data-placement={placement}
      className={cn(
        "relative flex shrink-0 flex-col gap-tight text-body",
        // In the list it scrolls with the rest, a list's step from what follows; at the foot it
        // is a block of its own, ruled off from the list above.
        !main && "border-t border-border px-inset py-tight",
      )}
    >
      <Glide container={list} />
      {groups.map((group) => (
        <section
          key={group.id}
          {...(group.label === undefined ? {} : { "aria-label": group.label })}
          data-testid="embed-navigation-group"
        >
          {group.label !== undefined && (
            <h2 className="flex h-6 items-center px-1.5 text-meta text-muted-foreground">
              {group.label}
            </h2>
          )}
          <ul className="flex flex-col gap-px">
            {group.items.map((item) => {
              const current = navigationCurrent(pathname, item.to);
              return (
                <li key={item.id}>
                  <Link
                    {...linkTo(item.to)}
                    {...{ [OVERVIEW_STOP]: "" }}
                    data-testid="embed-navigation-item"
                    aria-current={current ? "page" : undefined}
                    className={NAV_ROW}
                  >
                    <ItemIcon item={item} className="size-icon-row shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    <Count count={item.count} />
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </nav>
  );
}

/** A compact tile: the open row's height, filled while it is where the window is. */
export const RAIL_TILE =
  "relative grid size-8 shrink-0 place-items-center rounded-(--radius-sm) text-muted-foreground outline-none transition-[background-color,color,scale] duration-(--dur-fast) ease-(--ease-out) hover:bg-sidebar-row-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-safe:active:scale-[0.98] aria-[current=page]:bg-sidebar-row-active aria-[current=page]:text-foreground aria-expanded:text-foreground";

/** A rail tile in a list whose current fill is its `Glide`. */
const GLIDE_TILE = cn(
  RAIL_TILE,
  "aria-[current=page]:bg-transparent aria-[current=page]:hover:bg-transparent",
);

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
  const pathname = usePathname();
  const list = useRef<HTMLElement>(null);
  const stripOpen = useStripOpen();
  if (groups.length === 0) return null;
  const main = placement === "main";
  return (
    <nav
      ref={list}
      aria-label={main ? "Places" : "More places"}
      data-testid={main ? "embed-rail-navigation-main" : "embed-rail-navigation"}
      data-placement={placement}
      className={cn(
        "relative flex shrink-0 flex-col items-center",
        quiet ? "gap-3.5" : "gap-1",
        !main && !quiet && "border-t border-sidebar-divider py-2",
      )}
    >
      <Glide container={list} />
      {groups.map((group) => (
        <div
          key={group.id}
          className={cn("flex flex-col items-center", quiet ? "gap-px" : "gap-1")}
        >
          {group.items.map((item) => {
            const current = navigationCurrent(pathname, item.to);
            const count = shownCount(item.count);
            const name = itemName(group, item.label);
            const spoken = count === undefined ? name : `${name}, ${count}`;
            return (
              <Hint
                key={item.id}
                // The strip's own words are the place's name alone; the group is its neighbours'.
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

/** Gram's own pages that name themselves in the title bar as an added page does: in no workspace. */
const OWN_PAGE_TITLES: Readonly<Record<string, string>> = { "/threads": "Threads" };

/**
 * The name of the page the window is on, where the title bar says it in place of the workspace and
 * its views: an added page's (the one it brought; undefined if none) or the Threads page's.
 * Undefined on Gram's other pages.
 */
export function useEmbedPageTitle(): string | undefined {
  const titles = useEmbedShell((s) => s.titles);
  // The deepest match is the page; its `fullPath` is the path the page was added under.
  const path = useMatches({ select: (matches) => matches.at(-1)?.fullPath as string | undefined });
  return path === undefined ? undefined : (titles[path] ?? OWN_PAGE_TITLES[path]);
}

/**
 * The heading of the group whose destination the window is at, or undefined at none: on a phone,
 * the line under an added page's name says where it is listed.
 */
export function useEmbedPageGroup(): string | undefined {
  const groups = useEmbedShell((s) => s.navigation);
  const pathname = usePathname();
  return shownNavigation(groups).find((group) =>
    group.items.some((item) => navigationCurrent(pathname, item.to)),
  )?.label;
}

/** An added page's name in the title bar, where Gram's own pages name the workspace. */
export function EmbedPageTitle({ title }: { title: string }) {
  return (
    <h1
      data-testid="embed-page-title"
      // Keyed by the title where it is drawn: a new page's name fades in where the last one was.
      className="gram-fade min-w-0 truncate px-2 text-body font-medium text-foreground"
    >
      {title}
    </h1>
  );
}

/** The embedding app's home page at `/`, in the conversation's place as an added page is. */
export function EmbedHome() {
  const home = useEmbedShell((s) => s.home);
  const params = useParams({ strict: false }) as Readonly<Record<string, string>>;
  if (home === undefined) return null;
  return (
    <section data-testid="embed-page" data-path="/" className="min-h-0 flex-1 overflow-y-auto">
      {createElement(home, { params })}
    </section>
  );
}
