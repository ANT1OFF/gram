import { Link, useRouterState } from "@tanstack/react-router";
import { createElement } from "react";

import { Hint } from "@/components/hint";
import { cn } from "@/lib/utils";
import { OVERVIEW_STOP } from "@/shell/focus-regions";

import type { ShellNavigationItem, ShellPlacement } from "./contract";
import { navigationCurrent, shownNavigation, useEmbedShell } from "./store";

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
 * The added navigation groups in the open sidebar and the phone's drawer: each a heading and its
 * destinations as rows, below the threads and above History, with the places you go to.
 */
export function EmbedNavigation() {
  const groups = shownNavigation(useEmbedShell((s) => s.navigation));
  const pathname = usePathname();
  if (groups.length === 0) return null;
  return (
    <nav
      aria-label="More places"
      data-testid="embed-navigation"
      className="flex shrink-0 flex-col gap-tight border-t border-border px-inset py-tight text-body"
    >
      {groups.map((group) => (
        <section key={group.id} aria-label={group.label} data-testid="embed-navigation-group">
          <h2 className="flex h-6 items-center px-1.5 text-meta text-muted-foreground">
            {group.label}
          </h2>
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
                    className="flex h-8 min-w-0 items-center gap-1.5 rounded-(--radius-sm) pr-1.5 pl-1 text-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-sidebar-row-active aria-[current=page]:text-foreground in-data-phone-drawer:h-11 in-data-phone-drawer:gap-2.5 in-data-phone-drawer:px-2"
                  >
                    <ItemIcon item={item} className="size-icon-row shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
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

/** The same destinations in the compact sidebar: an icon each, its group and name on hover. */
export function EmbedRailNavigation() {
  const groups = shownNavigation(useEmbedShell((s) => s.navigation));
  const pathname = usePathname();
  if (groups.length === 0) return null;
  return (
    <nav
      aria-label="More places"
      data-testid="embed-rail-navigation"
      className="flex shrink-0 flex-col items-center gap-1 border-t border-sidebar-divider py-2"
    >
      {groups.flatMap((group) =>
        group.items.map((item) => {
          const current = navigationCurrent(pathname, item.to);
          return (
            <Hint
              key={`${group.id}/${item.id}`}
              label={`${group.label}: ${item.label}`}
              side="right"
              render={
                <Link
                  {...linkTo(item.to)}
                  {...{ [OVERVIEW_STOP]: "" }}
                  data-testid="embed-navigation-item"
                  aria-label={`${group.label}: ${item.label}`}
                  aria-current={current ? "page" : undefined}
                  className="grid size-8 place-items-center rounded-(--radius-sm) text-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-sidebar-row-active aria-[current=page]:text-foreground"
                />
              }
            >
              <ItemIcon item={item} className="size-icon-row" />
            </Hint>
          );
        }),
      )}
    </nav>
  );
}
