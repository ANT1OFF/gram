import { Dialog } from "@base-ui/react/dialog";

import { lazyPart } from "@/lib/lazy-part";
import { returnFocusTo, useOpener } from "@/lib/use-return-focus";
import { cn } from "@/lib/utils";
import { useLayoutStore } from "@/stores/layout";
import { PHONE_SHEET } from "@/thread/dialog-shell";
import { useThreadDialogs } from "@/thread/thread-dialogs-store";

/** What the palette shows, with the commands, searches and stores it reaches into. */
export const paletteBody = lazyPart(() => import("./palette-body"));

/**
 * `⌘K`: go to places (Workers, Memory, Quiet, the Inbox…), threads, workers, features and PRs; `>`
 * or the Actions filter for commands; More… opens it scoped. Unfiltered it opens short, recent
 * destinations first, each group capped with Show more.
 */
export function CommandPalette() {
  const requested = useLayoutStore((s) => s.paletteOpen);
  const initialQuery = useLayoutStore((s) => s.paletteQuery);
  const initialScope = useLayoutStore((s) => s.paletteScope);
  const closePalette = useLayoutStore((s) => s.closePalette);
  // Opens once its body is in hand, which the shell preloads after first paint.
  const body = paletteBody.useModule(requested);
  const open = requested && body !== undefined;
  // Opened from a shortcut or the store, with no trigger to return to.
  const opener = useOpener(open);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) closePalette();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 scrim transition-opacity duration-(--dur-fast) data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup
          data-testid="command-palette"
          data-surface="overlay"
          aria-label="Command palette"
          finalFocus={() => {
            // A palette action can open a thread dialog before this popup's exit ends. Returning
            // focus to the opener then steals that dialog's first keystroke (real e2e clone flow).
            if (useThreadDialogs.getState().dialog !== undefined) return false;
            return returnFocusTo(opener)();
          }}
          className={cn(
            "fixed top-[15%] left-1/2 z-50 flex max-h-[70vh] w-[min(36rem,90vw)] -translate-x-1/2 flex-col overflow-hidden rounded-lg border border-edge bg-popover text-popover-foreground shadow-overlay transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0",
            PHONE_SHEET,
          )}
        >
          {open && (
            <body.PaletteBody
              initialQuery={initialQuery}
              initialScope={initialScope}
              onDone={closePalette}
            />
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
