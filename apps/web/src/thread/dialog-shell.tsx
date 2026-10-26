import { Dialog } from "@base-ui/react/dialog";
import type { ReactNode } from "react";

import { returnFocusTo, useOpener } from "@/lib/use-return-focus";
import { cn } from "@/lib/utils";

/**
 * A centred modal with the app's dialog chrome; closing (Esc, backdrop, Cancel) calls `onClose`.
 * These dialogs open from menus, the palette and shortcuts rather than a trigger, so closing gives
 * focus back to what had it before, or to `returnFocus()` when that's gone.
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
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-scrim transition-opacity duration-(--dur-fast) data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup
          data-testid={testId}
          data-surface="overlay"
          finalFocus={returnFocusTo(opener, returnFocus)}
          initialFocus={initialFocus}
          className={cn(
            "fixed top-[20%] left-1/2 z-50 flex w-[min(32rem,90vw)] -translate-x-1/2 flex-col gap-4 rounded-lg border border-border bg-popover p-5 text-popover-foreground shadow-lg transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0",
            className,
          )}
        >
          <Dialog.Title className="font-heading text-base font-medium">{title}</Dialog.Title>
          {description !== undefined && (
            <Dialog.Description className="text-xs text-muted-foreground">
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
