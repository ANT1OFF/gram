import { Dialog } from "@base-ui/react/dialog";

import { lazyPart } from "@/lib/lazy-part";
import { returnFocusTo, useOpener } from "@/lib/use-return-focus";
import { cn } from "@/lib/utils";
import { PHONE_SHEET } from "@/thread/dialog-shell";

import { useInboxStore } from "./inbox-store";

/** The Inbox's list, strip and detail; loaded apart from the shell. */
export const inboxBody = lazyPart(() => import("./inbox-body"));

export const INBOX_TEST_ID = "inbox";

/**
 * The Inbox: a dialog over the work, in every mode and at every window size. Quiet stays under it,
 * and so does the thread it was opened from.
 */
export function InboxView() {
  const requested = useInboxStore((s) => s.open);
  // Opens once its body is in hand, which the shell preloads after first paint.
  const body = inboxBody.useModule(requested);
  const open = requested && body !== undefined;
  const close = useInboxStore((s) => s.close);
  const opener = useOpener(open);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 scrim transition-opacity duration-(--dur-fast) data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup
          data-testid={INBOX_TEST_ID}
          data-surface="overlay"
          aria-label="Inbox"
          // The list first, where j/k move; the Later list or the empty state has none.
          initialFocus={() =>
            document.querySelector<HTMLElement>('[data-testid="inbox-list"]') ?? true
          }
          // A thread just opened takes focus in its pane; a dismissal hands it back.
          finalFocus={() =>
            useInboxStore.getState().leftForThread ? false : returnFocusTo(opener)()
          }
          className={cn(
            "fixed top-[6%] left-1/2 z-50 flex h-[min(44rem,86vh)] w-[min(68rem,94vw)] -translate-x-1/2 flex-col overflow-hidden rounded-lg border border-edge bg-popover text-popover-foreground shadow-overlay outline-none transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0",
            PHONE_SHEET,
          )}
        >
          {open && <body.InboxBody />}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
