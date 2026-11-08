import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";

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
  testId,
  title,
  description,
  onClose,
  returnFocus,
  initialFocus,
  className,
  children,
}: {
  testId: string;
  title: ReactNode;
  description?: ReactNode;
  onClose: () => void;
  returnFocus?: () => HTMLElement | null | undefined;
  /** Where focus goes on open; Base UI's default is the first tabbable element. */
  initialFocus?: Dialog.Popup.Props["initialFocus"];
  /** Extra classes on the popup, for a surface that lays it out differently (e.g. a phone sheet). */
  className?: string;
  children: ReactNode;
}) {
  const opener = useOpener(true);
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 scrim transition-opacity duration-(--dur-fast) data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
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
          <Dialog.Title className="font-heading text-title">{title}</Dialog.Title>
          {description !== undefined && (
            <Dialog.Description className="text-meta text-muted-foreground">
              {description}
            </Dialog.Description>
          )}
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export { Dialog };
