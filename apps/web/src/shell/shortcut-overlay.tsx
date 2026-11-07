import { Dialog } from "@base-ui/react/dialog";
import { Search } from "lucide-react";
import { useState } from "react";

import { returnFocusTo, useOpener } from "@/lib/use-return-focus";
import { ShortcutList } from "@/palette/shortcut-list";
import { useLayoutStore } from "@/stores/layout";

/**
 * `?` and ⌘/: every shortcut, from the keyboard catalog, grouped by area. The field filters by
 * name, area or keys.
 */
export function ShortcutOverlay() {
  const open = useLayoutStore((s) => s.overlayOpen);
  const setOpen = useLayoutStore((s) => s.setOverlayOpen);
  // Opened from a key with no trigger: closing gives the focus back to where typing was.
  const opener = useOpener(open);

  return (
    <Dialog.Root open={open} onOpenChange={(next) => setOpen(next)}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 scrim transition-opacity duration-(--dur-fast) data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup
          data-testid="shortcut-overlay"
          finalFocus={returnFocusTo(opener)}
          className="fixed top-1/2 left-1/2 z-50 flex max-h-[80vh] w-[min(44rem,90vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-edge bg-popover text-popover-foreground shadow-overlay transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0"
        >
          {open && <ShortcutSheet />}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The sheet's content, mounted while it is open, so it opens with the field empty every time. */
function ShortcutSheet() {
  const [query, setQuery] = useState("");
  return (
    <>
      <div className="flex flex-col gap-3 border-b border-border px-4 pt-4 pb-3">
        <Dialog.Title className="font-heading text-title">Keyboard shortcuts</Dialog.Title>
        <label className="flex h-8 items-center gap-2 rounded-xs border border-border bg-background px-2 focus-within:focus-ring">
          <Search aria-hidden className="size-icon-row shrink-0 text-muted-foreground" />
          <input
            autoFocus
            aria-label="Filter shortcuts"
            placeholder="Filter by name, area or keys…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-muted-foreground"
          />
        </label>
      </div>
      <div className="min-h-0 overflow-y-auto p-4">
        <ShortcutList query={query} />
      </div>
      <p className="border-t border-border px-4 py-1.5 text-caption text-muted-foreground">
        Change them in Settings → Keyboard
      </p>
    </>
  );
}
