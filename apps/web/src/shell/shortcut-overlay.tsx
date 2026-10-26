import { Dialog } from "@base-ui/react/dialog";

import { ShortcutList } from "@/palette/shortcut-list";
import { useLayoutStore } from "@/stores/layout";

/** `?`: every registered shortcut, generated from the keyboard registry. */
export function ShortcutOverlay() {
  const open = useLayoutStore((s) => s.overlayOpen);
  const setOpen = useLayoutStore((s) => s.setOverlayOpen);

  return (
    <Dialog.Root open={open} onOpenChange={(next) => setOpen(next)}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-scrim transition-opacity duration-(--dur-fast) data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup
          data-testid="shortcut-overlay"
          className="fixed top-1/2 left-1/2 z-50 max-h-[80vh] w-[min(40rem,90vw)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-lg transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0"
        >
          <Dialog.Title className="mb-3 font-heading text-base font-medium">
            Keyboard shortcuts
          </Dialog.Title>
          <ShortcutList />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
