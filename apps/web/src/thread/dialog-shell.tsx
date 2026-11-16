import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { createContext, useContext, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { returnFocusTo, useOpener } from "@/lib/use-return-focus";
import { cn } from "@/lib/utils";

/**
 * On a phone (below `sm`), a big dialog's popup (the Inbox, History, the palette) as a full-screen
 * sheet: the whole window, square, its rows 48 px and every button a 44 px target. Added after the
 * popup's own classes; every class is `phone:`, so wider windows keep the dialog as it was.
 */
export const PHONE_SHEET = cn(
  "phone:inset-0 phone:top-0 phone:left-0 phone:h-dvh phone:max-h-none phone:w-full phone:translate-x-0",
  "phone:rounded-none phone:border-0 phone:bg-background phone:shadow-none",
  "phone:pt-[env(safe-area-inset-top)] phone:pb-[env(safe-area-inset-bottom)]",
  "phone:data-[ending-style]:scale-100 phone:data-[starting-style]:scale-100",
  "phone:[&_[role=option]]:min-h-12 phone:[&_button]:min-h-11 phone:[&_button]:min-w-11",
);

/**
 * A phone sheet's header: its title and a 44 px Close, 52 px tall, with what else it needs (its
 * `children`) between them. The sheet's one title, so it is the dialog's.
 */
export function PhoneSheetHeader({
  title,
  closeLabel = "Close",
  testId = "sheet-close",
  children,
}: {
  title: ReactNode;
  closeLabel?: string;
  testId?: string;
  children?: ReactNode;
}) {
  return (
    <header
      data-testid="sheet-header"
      className="flex h-13 shrink-0 items-center gap-1 border-b border-border bg-surface-1 pr-1 pl-4"
    >
      <Dialog.Title className="min-w-0 flex-1 truncate font-heading text-title">
        {title}
      </Dialog.Title>
      {children}
      <Dialog.Close
        render={
          <Button
            size="icon"
            variant="ghost"
            aria-label={closeLabel}
            data-testid={testId}
            className="size-11"
          />
        }
      >
        <X aria-hidden className="size-icon-bar" />
      </Dialog.Close>
    </header>
  );
}

/** The window's dim behind a dialog or a sheet, fading with it. */
// On the popups' own layer: each backdrop comes just before its popup in the page, so a dialog
// opened beside an open sheet (not inside it) dims and covers the sheet as well as the page.
export const DIALOG_BACKDROP =
  "fixed inset-0 z-50 scrim transition-opacity duration-(--dur-fast) data-[ending-style]:opacity-0 data-[starting-style]:opacity-0";

/** Whether what renders here is inside one of these overlays, so a dialog opened in it is nested. */
const InsideOverlay = createContext(false);

/** Wraps an overlay's content, so the dialogs opened from it know they are nested. */
export function OverlayContent({ children }: { children: ReactNode }) {
  return <InsideOverlay value>{children}</InsideOverlay>;
}

/**
 * An overlay's backdrop. On its own, the scrim over the window. Nested in another overlay, Base
 * UI draws no backdrop and the overlay under it dims itself, so this is a clear one in its place:
 * a click on what is under the dialog lands here, outside the dialog, and closes the dialog alone
 * rather than acting on the overlay under it.
 */
export function OverlayBackdrop() {
  const nested = useContext(InsideOverlay);
  return nested ? (
    <Dialog.Backdrop forceRender data-slot="nested-backdrop" className="fixed inset-0 z-50" />
  ) : (
    <Dialog.Backdrop className={DIALOG_BACKDROP} />
  );
}

/**
 * A sheet's popup: the window's height less a margin, against its end edge, sliding in from it.
 * `SHEET_WIDE` for one that holds a page of settings. A dialog opened from the sheet dims the
 * sheet under it as the scrim dims the window: Base UI draws no second backdrop for a nested one.
 * A click on the dimmed sheet lands on the dialog's own clear backdrop (`OverlayBackdrop`) and
 * closes only the dialog.
 */
export const SHEET_POPUP =
  "fixed inset-y-2 end-2 z-50 flex w-[min(28rem,calc(100vw-1rem))] flex-col overflow-hidden rounded-lg border border-edge bg-popover text-popover-foreground shadow-overlay outline-none transition-[translate,opacity] duration-(--dur-move-base) ease-(--ease-out) after:pointer-events-none after:absolute after:inset-0 after:rounded-lg after:opacity-0 after:transition-opacity after:duration-(--dur-fast) after:scrim data-[ending-style]:translate-x-6 data-[ending-style]:opacity-0 data-[nested-dialog-open]:after:opacity-100 data-[starting-style]:translate-x-6 data-[starting-style]:opacity-0";
export const SHEET_WIDE = "w-[min(36rem,calc(100vw-1rem))]";

/**
 * A sheet's header: its title, what sits beside it (a count, a state), what acts on the whole
 * sheet, and Close. The sheet's one title, so it is the dialog's. Close is a 44 px target on a
 * phone, as a phone sheet's is.
 */
export function SheetHeader({
  title,
  titleId,
  beside,
  actions,
  closeLabel = "Close",
}: {
  title: ReactNode;
  /** The title's id, for a popup that names itself by it. */
  titleId?: string;
  /** After the title, on its line: a badge, a count. */
  beside?: ReactNode;
  /** Before Close: a menu of what acts on the whole sheet. */
  actions?: ReactNode;
  closeLabel?: string;
}) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4 phone:h-13 phone:pr-1">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <Dialog.Title id={titleId} className="min-w-0 truncate font-heading text-title">
          {title}
        </Dialog.Title>
        {beside}
      </div>
      {actions}
      <Dialog.Close
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={closeLabel}
            className="phone:size-11"
          />
        }
      >
        <X aria-hidden />
      </Dialog.Close>
    </header>
  );
}

/**
 * A sheet from the window's end edge over a dimmed window, for what is read or changed beside the
 * page (a member, an agent's settings): its title, what acts on it and a Close at the top, then
 * its body, which scrolls (by keyboard too: it is a Tab stop of its own). It stays mounted while
 * closed, so it slides away with its content; closing (Esc, the backdrop, Close) calls `onClose`,
 * and focus goes back to what had it.
 */
export function Sheet({
  open,
  onClose,
  title,
  description,
  beside,
  actions,
  wide = false,
  testId,
  closeLabel = "Close",
  returnFocus,
  className,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** One line under the header on what the sheet is for; it describes the dialog too. */
  description?: ReactNode;
  /** After the title, on its line: a badge, a count. */
  beside?: ReactNode;
  /** In the header, before Close: a menu of what acts on the whole sheet. */
  actions?: ReactNode;
  /** 36 rem rather than 28, for a page of settings. */
  wide?: boolean;
  testId?: string;
  closeLabel?: string;
  returnFocus?: () => HTMLElement | null | undefined;
  /** Extra classes on the body. */
  className?: string;
  children: ReactNode;
}) {
  const opener = useOpener(open);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <OverlayBackdrop />
        <Dialog.Popup
          data-testid={testId}
          data-surface="overlay"
          finalFocus={returnFocusTo(opener, returnFocus)}
          className={cn(SHEET_POPUP, wide && SHEET_WIDE)}
        >
          <OverlayContent>
            <SheetHeader title={title} beside={beside} actions={actions} closeLabel={closeLabel} />
            <div
              // Scrolls by keyboard where it holds nothing to focus, as a page read in it may.
              tabIndex={0}
              className={cn(
                "min-h-0 flex-1 overflow-y-auto p-5 outline-none focus-visible:focus-ring-inset",
                className,
              )}
            >
              {description !== undefined && (
                <Dialog.Description className="mb-4 text-meta text-muted-foreground">
                  {description}
                </Dialog.Description>
              )}
              {children}
            </div>
          </OverlayContent>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * A centred modal with the app's dialog chrome; closing (Esc, backdrop, Cancel) calls `onClose`.
 * These dialogs open from menus, the palette and shortcuts rather than a trigger, so closing gives
 * focus back to what had it before, or to `returnFocus()` when that's gone.
 *
 * It never runs past the window: below its 20% top it stops a margin short of the bottom and
 * scrolls. A body that can grow scrolls itself instead, with its actions after it, so they stay
 * in view (see `ReportIssueForm`).
 */
export function DialogShell({
  open = true,
  testId,
  title,
  description,
  onClose,
  returnFocus,
  initialFocus,
  className,
  children,
}: {
  /**
   * Whether it shows. Left out, it shows while mounted: mount it to open it. Given, it stays
   * mounted and plays its closing fade.
   */
  open?: boolean;
  testId?: string;
  title: ReactNode;
  description?: ReactNode;
  onClose: () => void;
  returnFocus?: () => HTMLElement | null | undefined;
  /**
   * Where focus goes on open; Base UI's default is the first tabbable element. Give it for a long
   * body whose first control sits at its end, so the dialog doesn't open scrolled to the bottom.
   */
  initialFocus?: Dialog.Popup.Props["initialFocus"];
  /** Extra classes on the popup, for a surface that lays it out differently (e.g. a phone sheet). */
  className?: string;
  children: ReactNode;
}) {
  const opener = useOpener(open);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <OverlayBackdrop />
        <Dialog.Popup
          data-testid={testId}
          data-surface="overlay"
          finalFocus={returnFocusTo(opener, returnFocus)}
          initialFocus={initialFocus}
          className={cn(
            "fixed top-[20%] left-1/2 z-50 flex max-h-[calc(80dvh-1.5rem)] w-[min(32rem,90vw)] -translate-x-1/2 flex-col gap-4 overflow-y-auto overscroll-contain rounded-lg border border-edge bg-popover p-5 text-popover-foreground shadow-modal transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0",
            className,
          )}
        >
          <OverlayContent>
            <Dialog.Title className="font-heading text-title">{title}</Dialog.Title>
            {description !== undefined && (
              <Dialog.Description className="text-meta text-muted-foreground">
                {description}
              </Dialog.Description>
            )}
            {children}
          </OverlayContent>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export { Dialog };
