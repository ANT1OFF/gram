import { Drawer } from "@base-ui/react/drawer";
import { Link, useRouterState } from "@tanstack/react-router";
import { ChevronDown, History, Search, Settings, SunMoon } from "lucide-react";
import { createElement, useEffect, useId, useRef, useState } from "react";

import { EmbedSwitcher, ItemIcon, linkTo, useCurrentDestination } from "@/embed/slots";
import type { ShellNavigationGroup } from "@/embed/contract";
import { useGroupFold } from "@/embed/folded";
import { hiddenCount, navigationAt, shownCount, shownRows, useEmbedShell } from "@/embed/store";
import { useHistoryStore } from "@/history/history-view";
import { useLaunchIssues } from "@/launch-checks/banner";
import { cn } from "@/lib/utils";
import { NewEntryMenu } from "@/orchestration/new-entry-menu";
import { OVERVIEW_STOP } from "@/shell/focus-regions";
import { useLayoutStore } from "@/stores/layout";
import { useThemeStore } from "@/theme/store";
import { MODE_PREFS, type ModePref } from "@/theme/theme";
import { switchTheme } from "@/theme/transition";

// A phone's menu in the `roomy` look: one plain column, the app's name at its head, every place a
// large row, and at its foot the person (their avatar, name and the word Settings on one button
// that opens their sheet) and one New pill.
// The places you go to rather than work in (the foot's places, History, Settings, the theme) are
// in the person's sheet, so nothing hides under the foot.

/** A round 44 px control: the menu's search, the avatar, the phone header's buttons. */
export const ROUND =
  "relative grid size-11 shrink-0 place-items-center rounded-full border border-border bg-card text-foreground outline-none transition-[background-color,scale] duration-(--dur-fast) ease-(--ease-out) hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring motion-safe:active:scale-[0.96] [&_svg]:size-5";

/** A row of the menu and of the person's sheet: tall, a large icon, the reading size. */
const ROW =
  "flex min-h-13 w-full min-w-0 items-center gap-4 rounded-xl px-3.5 text-left text-reading text-foreground outline-none transition-[background-color,scale] duration-(--dur-fast) ease-(--ease-out) hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset motion-safe:active:scale-[0.985] aria-[current=page]:bg-sidebar-row-active aria-[current=page]:font-medium [&_svg]:size-[1.375rem] [&_svg]:shrink-0";

/**
 * The person's button at the menu's foot: their avatar, their name and the word Settings in one
 * 52 px chip, quieter than the New pill beside it. It gives way to the pill and cuts a long name.
 */
const YOU =
  "flex h-13 min-w-0 items-center gap-2.5 rounded-full border border-border-strong bg-card pr-4 text-left text-foreground outline-none transition-[background-color,scale] duration-(--dur-fast) ease-(--ease-out) hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring motion-safe:active:scale-[0.97]";

/** A heading over a group of rows: plain words, quiet, with air above. */
const HEADING = "px-6 pt-5 pb-1.5 text-body text-muted-foreground";

/** The places at one placement, as the menu's rows under their groups' plain headings. */
function Places({ placement }: { placement: "main" | "foot" }) {
  const groups = navigationAt(
    useEmbedShell((s) => s.navigation),
    placement,
  );
  const list = useRef<HTMLElement>(null);
  const at = useCurrentDestination();
  // The current row in view when the menu opens: on a short phone it may be below the fold.
  useEffect(() => {
    if (at === undefined) return;
    list.current
      ?.querySelector<HTMLElement>('[aria-current="page"]')
      ?.scrollIntoView?.({ block: "nearest" });
  }, [at]);
  if (groups.length === 0) return null;
  return (
    <nav
      ref={list}
      aria-label={placement === "main" ? "Places" : "More places"}
      data-testid={placement === "main" ? "embed-navigation-main" : "embed-navigation"}
      data-placement={placement}
      className="flex flex-col"
    >
      {groups.map((group, index) => (
        <PhoneGroup
          key={group.id}
          group={group}
          // The first group needs no name under the menu's head: its places lead.
          named={index > 0 || placement === "foot"}
          at={at}
        />
      ))}
    </nav>
  );
}

/**
 * One group of the menu: its plain heading and its large rows. A collapsible group always shows its
 * heading, a button that opens and closes it; closed, it keeps the row the window is at, and the
 * heading counts what it hides.
 */
function PhoneGroup({
  group,
  named,
  at,
}: {
  group: ShellNavigationGroup;
  named: boolean;
  at: string | undefined;
}) {
  const fold = useGroupFold(group);
  const rows = useId();
  const items = shownRows(group, fold.open, at);
  const hidden = hiddenCount(group, fold.open, at);
  return (
    <section
      {...(group.label === undefined ? {} : { "aria-label": group.label })}
      data-testid="embed-navigation-group"
      data-open={fold.foldable ? String(fold.open) : undefined}
    >
      {fold.foldable ? (
        <h2 data-testid="embed-navigation-heading">
          <button
            type="button"
            {...{ [OVERVIEW_STOP]: "" }}
            data-testid="embed-navigation-toggle"
            aria-expanded={fold.open}
            aria-controls={rows}
            onClick={fold.toggle}
            className={cn(
              HEADING,
              "flex min-h-11 w-full items-center gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
            )}
          >
            <span className="min-w-0 flex-1 truncate">{group.label}</span>
            {hidden !== undefined && (
              <span
                data-testid="embed-navigation-hidden-count"
                className="shrink-0 text-status-needs tabular-nums"
              >
                {hidden}
              </span>
            )}
            <ChevronDown
              aria-hidden
              className={cn(
                "size-4 shrink-0 transition-transform duration-(--dur-fast)",
                !fold.open && "-rotate-90",
              )}
            />
          </button>
        </h2>
      ) : (
        group.label !== undefined &&
        named && (
          <h2 data-testid="embed-navigation-heading" className={HEADING}>
            {group.label}
          </h2>
        )
      )}
      <ul id={rows} className="flex flex-col gap-px px-2.5">
        {items.map((item) => {
          const current = item.to === at;
          const count = shownCount(item.count);
          return (
            <li key={item.id}>
              <Link
                {...linkTo(item.to)}
                {...{ [OVERVIEW_STOP]: "" }}
                data-testid="embed-navigation-item"
                aria-current={current ? "page" : undefined}
                className={ROW}
              >
                <ItemIcon item={item} className="size-[1.375rem] shrink-0" />
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {count !== undefined && (
                  <span
                    data-testid="embed-navigation-count"
                    className="shrink-0 text-body text-status-needs tabular-nums"
                  >
                    {count}
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * The menu's content in a phone's drawer, in the `roomy` look. Search is a round button beside the
 * name; it opens the command palette, as the field it replaces did.
 */
export function PhoneMenu() {
  const header = useEmbedShell((s) => s.sidebar.header);
  const paletteOpen = useLayoutStore((s) => s.paletteOpen);
  return (
    <aside
      aria-label="Menu"
      data-testid="overview-sidebar"
      data-surface="chrome"
      data-look="phone-menu"
      className="relative flex min-h-0 flex-1 flex-col bg-sidebar text-sidebar-foreground"
    >
      <div className="flex shrink-0 items-center gap-3 pt-[max(1rem,env(safe-area-inset-top))] pr-4 pb-1 pl-6">
        <div data-testid="embed-sidebar-header" className="flex min-w-0 flex-1 items-center">
          {header !== undefined && createElement(header, { placement: "drawer" })}
        </div>
        <button
          type="button"
          aria-label="Search"
          aria-haspopup="dialog"
          aria-expanded={paletteOpen}
          data-testid="overview-search"
          className={ROUND}
          onClick={() => useLayoutStore.getState().openPalette()}
        >
          <Search aria-hidden />
        </button>
      </div>
      <EmbedSwitcher placement="drawer" className="px-4 pb-2" />
      {/* The list scrolls above the foot, never under it: no row sits behind the avatar or New. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain pt-1 pb-3 [scrollbar-width:none]">
        <Places placement="main" />
      </div>
      <div
        data-testid="phone-menu-foot"
        className="flex shrink-0 items-center justify-between gap-2 border-t border-edge bg-sidebar px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]"
      >
        <YouButton />
        <NewEntryMenu pill />
      </div>
    </aside>
  );
}

const MODE_WORDS: Readonly<Record<ModePref, string>> = {
  system: "Auto",
  light: "Light",
  dark: "Dark",
};

/**
 * The person at the menu's foot: their avatar as the embedding app draws it, their name and
 * "Settings" in one button, and the sheet it opens from the bottom with who they are, the foot's places, History, Settings, the
 * theme and anything else the app put at its foot.
 */
function YouButton() {
  const account = useEmbedShell((s) => s.sidebar.account);
  const name = useEmbedShell((s) => s.sidebar.accountName);
  const [open, setOpen] = useState(false);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const historyOpen = useHistoryStore((s) => s.open);
  // A pick in the sheet that moves the page, or opens History, closes it.
  const at = useRef({ pathname, historyOpen });
  useEffect(() => {
    const before = at.current;
    at.current = { pathname, historyOpen };
    if (pathname !== before.pathname || (historyOpen && !before.historyOpen)) setOpen(false);
  }, [pathname, historyOpen]);
  const setup = useLaunchIssues().dismissed;
  const mode = useThemeStore((s) => s.mode);
  const inSettings = pathname.startsWith("/settings");
  return (
    <Drawer.Root open={open} onOpenChange={setOpen}>
      <Drawer.Trigger
        aria-label={name === undefined ? "Settings and more" : `${name}: Settings and more`}
        data-testid="phone-menu-you"
        className={YOU}
      >
        <span
          className={cn(
            "ml-0.5 grid size-[2.875rem] shrink-0 place-items-center overflow-hidden rounded-full text-body-strong",
            account === undefined && "[&_svg]:size-5",
          )}
        >
          {account === undefined ? (
            <Settings aria-hidden />
          ) : (
            createElement(account, { placement: "drawer" })
          )}
        </span>
        {/* The words say what the button holds: without them the avatar alone hid Settings. */}
        {account === undefined ? (
          <span className="truncate text-reading">Settings</span>
        ) : (
          <span className="flex min-w-0 flex-col">
            {name !== undefined && (
              <span data-testid="phone-menu-you-name" className="truncate text-body-strong">
                {name}
              </span>
            )}
            <span className="truncate text-body text-muted-foreground">Settings</span>
          </span>
        )}
      </Drawer.Trigger>
      <Drawer.Portal>
        <Drawer.Backdrop
          // Over the menu, itself a dialog: a nested backdrop is left out unless forced.
          forceRender
          className="fixed inset-0 z-50 scrim opacity-[calc(1-var(--drawer-swipe-progress,0))] transition-opacity duration-(--dur-base) data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 data-swiping:duration-0"
        />
        <Drawer.Viewport className="fixed inset-0 z-50 flex items-end justify-center">
          <Drawer.Popup
            data-surface="overlay"
            data-testid="phone-menu-you-sheet"
            aria-label="You"
            className="flex max-h-[85dvh] w-full max-w-xl translate-y-(--drawer-swipe-movement-y,0) flex-col rounded-t-xl border-t border-edge bg-popover pb-[max(1.25rem,env(safe-area-inset-bottom))] text-popover-foreground shadow-overlay outline-none transition-transform duration-(--dur-move-base) ease-out data-[ending-style]:translate-y-full data-[starting-style]:translate-y-full data-swiping:select-none"
          >
            <div
              aria-hidden
              className="mx-auto mt-2 mb-2 h-1 w-9 shrink-0 rounded-full bg-border-strong"
            />
            <Drawer.Content className="flex min-h-0 flex-col overflow-y-auto overscroll-contain">
              {account !== undefined && (
                <div data-testid="embed-account" className="flex min-w-0 px-5 pt-1 pb-3">
                  {createElement(account, { placement: "sidebar" })}
                </div>
              )}
              <Places placement="foot" />
              <div className="flex flex-col gap-px px-2.5">
                <button
                  type="button"
                  data-testid="overview-history"
                  aria-haspopup="dialog"
                  aria-expanded={historyOpen}
                  onClick={() => useHistoryStore.getState().show()}
                  className={ROW}
                >
                  <History aria-hidden />
                  <span className="flex-1 truncate">History</span>
                </button>
                <Link
                  to={setup.length === 0 ? "/settings" : "/settings/diagnostics"}
                  data-testid="overview-settings"
                  aria-current={inSettings ? "page" : undefined}
                  className={ROW}
                >
                  <Settings aria-hidden />
                  <span className="flex-1 truncate">Settings</span>
                  {setup.length > 0 && (
                    <span className="text-body text-status-needs">
                      {setup.length === 1 ? "1 to fix" : `${setup.length} to fix`}
                    </span>
                  )}
                </Link>
                <div className={cn(ROW, "hover:bg-transparent motion-safe:active:scale-100")}>
                  <SunMoon aria-hidden />
                  <span className="flex-1 truncate">Theme</span>
                  <div
                    role="radiogroup"
                    aria-label="Theme"
                    data-testid="phone-menu-theme"
                    className="flex shrink-0 gap-0.5 rounded-full border border-border bg-background p-1"
                  >
                    {MODE_PREFS.map((choice) => (
                      <button
                        key={choice}
                        type="button"
                        role="radio"
                        aria-checked={mode === choice}
                        onClick={() => switchTheme({ mode: choice })}
                        className="h-9 rounded-full px-3.5 text-body text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring aria-checked:bg-popover aria-checked:font-medium aria-checked:text-foreground aria-checked:shadow-raised"
                      >
                        {MODE_WORDS[choice]}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </Drawer.Content>
          </Drawer.Popup>
        </Drawer.Viewport>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
