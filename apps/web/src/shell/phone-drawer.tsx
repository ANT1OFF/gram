import { Dialog } from "@base-ui/react/dialog";
import { useRouterState } from "@tanstack/react-router";
import { Menu as MenuIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { create } from "zustand";

import { Button } from "@/components/ui/button";
import { useHistoryStore } from "@/history/history-view";
import { useInboxStore } from "@/inbox/inbox-store";
import { OverviewSidebar } from "@/orchestration/overview-sidebar";
import { useLayoutStore } from "@/stores/layout";

interface PhoneDrawerState {
  readonly open: boolean;
  setOpen(open: boolean): void;
}

/** The phone's drawer of threads: open or not. Local, never stored. */
export const usePhoneDrawer = create<PhoneDrawerState>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

/** The data attribute the drawer's column carries, which the overview's rows take their phone shape from. */
export const PHONE_DRAWER = "data-phone-drawer";

/**
 * The phone header's first button: the drawer with every thread, which the overview sidebar is on
 * a wider window.
 */
export function PhoneMenuButton() {
  const open = usePhoneDrawer((s) => s.open);
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Threads"
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
          aria-label="Threads"
          data-testid="phone-drawer"
          {...{ [PHONE_DRAWER]: "" }}
          className="fixed inset-y-0 left-0 z-50 flex w-[min(21.25rem,88vw)] flex-col shadow-overlay outline-none transition-[translate] duration-(--dur-move-base) ease-(--ease-out) data-[ending-style]:-translate-x-full data-[starting-style]:-translate-x-full"
        >
          <OverviewSidebar phone />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
