import type { ThreadId } from "@gram/contracts";
import { useId, type KeyboardEvent } from "react";

import { lazyPart } from "@/lib/lazy-part";
import { returnFocusTo, useOpener } from "@/lib/use-return-focus";
import { cn } from "@/lib/utils";
import { useCloseOnNavigate } from "@/settings/workspace-sheet";
import { useOpenThread } from "@/shell/thread-switcher";
import { Dialog } from "@/thread/dialog-shell";

import { usePeekStore } from "./peek-store";

/** What the sheet shows of a worker or a PR, loaded after the shell's first paint. */
const peekSheetBody = lazyPart(() => import("./peek-sheet-body"));

export const PEEK_SHEET_TEST_ID = "peek-sheet";

/** Opens the worker's full view, in place of the sheet. */
export function useOpenFull() {
  const open = useOpenThread();
  const close = usePeekStore((s) => s.close);
  return (threadId: ThreadId) => {
    close();
    open(threadId);
  };
}

/**
 * A worker or a PR in a sheet over the right of the pane it was opened from, a step short of the
 * worker's full view. It only
 * reads: it sends nothing and never holds the worker. Esc closes it and gives focus back; ⏎ on a
 * worker opens its full view.
 */
export function PeekSheet() {
  const requested = usePeekStore((s) => s.open);
  // Opens once its body is in hand, which the shell preloads after first paint.
  const body = peekSheetBody.useModule(requested);
  const open = requested && body !== undefined;
  const target = usePeekStore((s) => s.target);
  const container = usePeekStore((s) => s.container);
  const close = usePeekStore((s) => s.close);
  const opener = useOpener(open);
  const titleId = useId();
  const openFull = useOpenFull();
  useCloseOnNavigate(open, close);
  // In the pane while it is on the page, else over the window.
  const inPane = container?.isConnected === true;
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Enter" || target?.kind !== "worker") return;
    if (event.target instanceof Element && event.target.closest("button, a, input, textarea"))
      return;
    event.preventDefault();
    openFull(target.threadId);
  };
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <Dialog.Portal container={inPane ? container : undefined}>
        <Dialog.Backdrop
          className={cn(
            "inset-0 z-40 scrim transition-opacity duration-(--dur-fast) data-[ending-style]:opacity-0 data-[starting-style]:opacity-0",
            inPane ? "absolute" : "fixed",
          )}
        />
        <Dialog.Popup
          data-testid={PEEK_SHEET_TEST_ID}
          data-kind={target?.kind}
          data-thread-id={target?.threadId}
          data-surface="overlay"
          aria-labelledby={titleId}
          finalFocus={returnFocusTo(opener)}
          onKeyDown={onKeyDown}
          className={cn(
            "inset-y-2 end-2 z-50 flex w-[min(26rem,calc(100%-1rem))] flex-col overflow-hidden rounded-lg border border-edge bg-popover text-reading text-popover-foreground shadow-overlay outline-none transition-[translate,opacity] duration-(--dur-move-base) ease-(--ease-out) data-[ending-style]:translate-x-6 data-[ending-style]:opacity-0 data-[starting-style]:translate-x-6 data-[starting-style]:opacity-0",
            inPane ? "absolute" : "fixed",
          )}
        >
          {target !== undefined && body !== undefined && (
            <body.PeekBody target={target} titleId={titleId} onOpenFull={openFull} />
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
