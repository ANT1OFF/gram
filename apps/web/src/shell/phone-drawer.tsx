import { Dialog } from "@base-ui/react/dialog";
import { useRouterState } from "@tanstack/react-router";
import { Menu as MenuIcon } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { create } from "zustand";

import { Button } from "@/components/ui/button";
import { useHistoryStore } from "@/history/history-view";
import { useInboxStore } from "@/inbox/inbox-store";
import { OverviewSidebar } from "@/orchestration/overview-sidebar";
import { useLayoutStore } from "@/stores/layout";
import {
  shownCount,
  shownNavigation,
  useEmbedShell,
  useRoomySidebar,
  useThreadsListed,
} from "@/embed/store";
import { attentionWords } from "@/embed/attention";
import { cn } from "@/lib/utils";
import { PhoneMenu, ROUND } from "@/shell/phone-menu";

interface PhoneDrawerState {
  readonly open: boolean;
  setOpen(open: boolean): void;
}

/** The phone's drawer of threads: open or not. Local, never stored. */
export const usePhoneDrawer = create<PhoneDrawerState>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

/** The places in the menu with a count above 0, which its button marks with a dot. */
function useMenuCounts(): readonly { label: string; count: number }[] {
  const groups = useEmbedShell((s) => s.navigation);
  return useMemo(
    () =>
      shownNavigation(groups).flatMap((group) =>
        group.items.flatMap((item) => {
          const count = shownCount(item.count);
          return count === undefined ? [] : [{ label: item.label, count }];
        }),
      ),
    [groups],
  );
}

/** The data attribute the drawer's column carries, which the overview's rows take their phone shape from. */
export const PHONE_DRAWER = "data-phone-drawer";

/** The drawer's name: its threads, or, where an app in front of Gram leaves them out, its menu. */
const useDrawerName = () => (useThreadsListed() ? "Threads" : "Menu");

/**
 * The phone header's first button: the drawer with every thread, which the overview sidebar is on
 * a wider window.
 */
export function PhoneMenuButton() {
  const open = usePhoneDrawer((s) => s.open);
  const name = useDrawerName();
  const roomy = useRoomySidebar();
  // In the roomy look the button is round, and carries the Inbox's dot: what needs you is a row
  // of the menu behind it, not a button of its own in the header.
  const attention = useEmbedShell((s) => s.attention);
  const counted = useMenuCounts();
  const hostCount = shownCount(attention?.count);
  const words =
    hostCount !== undefined
      ? attentionWords(hostCount, attention?.label)
      : counted.map((item) => `${item.label} ${item.count}`).join(", ");
  const waiting = roomy && words !== "";
  if (roomy)
    return (
      <button
        type="button"
        aria-label={waiting ? `${name}, ${words}` : name}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="phone-menu"
        className={ROUND}
        onClick={() => usePhoneDrawer.getState().setOpen(true)}
      >
        <MenuIcon aria-hidden />
        {waiting && (
          <span
            aria-hidden
            data-testid="phone-menu-dot"
            className="absolute top-2 right-2 size-2.5 rounded-full bg-status-needs-mark ring-2 ring-card"
          />
        )}
      </button>
    );
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={name}
      aria-haspopup="dialog"
      aria-expanded={open}
      data-testid="phone-menu"
      className="size-11 shrink-0 text-muted-foreground"
      onClick={() => usePhoneDrawer.getState().setOpen(true)}
    >
      <MenuIcon aria-hidden />
    </Button>
  );
}

/**
 * Closes the drawer once what was picked in it takes over: a move to another page (a row, a
 * workspace, New task, Settings) or a sheet it opened (Search, Needs you, History).
 */
function useCloseOnPick(open: boolean) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const palette = useLayoutStore((s) => s.paletteOpen);
  const history = useHistoryStore((s) => s.open);
  const inbox = useInboxStore((s) => s.open);
  const at = useRef({ pathname, palette, history, inbox });
  useEffect(() => {
    const before = at.current;
    at.current = { pathname, palette, history, inbox };
    if (!open) return;
    const moved =
      pathname !== before.pathname ||
      (palette && !before.palette) ||
      (history && !before.history) ||
      (inbox && !before.inbox);
    if (moved) usePhoneDrawer.getState().setOpen(false);
  }, [open, pathname, palette, history, inbox]);
}

/**
 * The phone's overview: the sidebar's own content as a drawer from the left over the page, a scrim
 * behind it. A tap on the scrim, Escape or a pick in it closes it.
 */
export function PhoneDrawer() {
  const open = usePhoneDrawer((s) => s.open);
  const setOpen = usePhoneDrawer((s) => s.setOpen);
  const name = useDrawerName();
  const roomy = useRoomySidebar();
  useCloseOnPick(open);
  // Leaving the phone layout (a tablet turned to landscape) closes it, so it doesn't come back open.
  useEffect(() => () => usePhoneDrawer.getState().setOpen(false), []);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Backdrop
          data-testid="phone-drawer-scrim"
          className="fixed inset-0 z-40 scrim transition-opacity duration-(--dur-fast) data-[ending-style]:opacity-0 data-[starting-style]:opacity-0"
        />
        <Dialog.Popup
          aria-label={name}
          data-testid="phone-drawer"
          {...{ [PHONE_DRAWER]: "" }}
          className={cn(
            "fixed inset-y-0 left-0 z-50 flex w-[min(21.25rem,88vw)] flex-col shadow-overlay outline-none transition-[translate] duration-(--dur-move-base) ease-(--ease-out) data-[ending-style]:-translate-x-full data-[starting-style]:-translate-x-full",
            roomy && "w-[min(22.5rem,86vw)]",
          )}
        >
          {roomy ? <PhoneMenu /> : <OverviewSidebar phone />}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
