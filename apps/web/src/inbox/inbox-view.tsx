import { Dialog } from "@base-ui/react/dialog";

import { lazyPart } from "@/lib/lazy-part";
import { returnFocusTo, useOpener } from "@/lib/use-return-focus";

import { useInboxDock } from "./inbox-dock";
import { useInboxStore } from "./inbox-store";

/** The Inbox's list, strip and detail, for the dialog and the dock alike. */
export const inboxBody = lazyPart(() => import("./inbox-body"));

export const INBOX_TEST_ID = "inbox";

/** The Inbox as a dialog: in Quiet, and where the window has no room to dock it. */
export function InboxView() {
  const docked = useInboxDock() !== undefined;
  const requested = useInboxStore((s) => s.open) && !docked;
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
          // A thread just opened takes focus in its pane; a dismissal hands it back. Docked instead
          // (the window widened), the dock has it.
          finalFocus={() =>
            useInboxStore.getState().leftForThread || useInboxStore.getState().open
              ? false
              : returnFocusTo(opener)()
          }
          className="fixed top-[6%] left-1/2 z-50 flex h-[min(44rem,86vh)] w-[min(68rem,94vw)] -translate-x-1/2 flex-col overflow-hidden rounded-lg border border-edge bg-popover text-popover-foreground shadow-overlay outline-none transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0"
        >
          {open && <body.InboxBody />}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * The Inbox docked in the side panel's column (`inbox-body`'s `InboxDock`). Until its code is in
 * hand, which the shell preloads after first paint, the column shows the dock's empty frame.
 */
export function InboxDock() {
  const body = inboxBody.useModule(true);
  if (body !== undefined) return <body.InboxDock />;
  return (
    <aside
      data-surface="chrome"
      aria-busy
      className="flex min-h-0 flex-1 flex-col overflow-hidden border-l border-shell-divider bg-panel outline-none"
    >
      <div className="h-(--titlebar-height) shrink-0 [-webkit-app-region:drag]" />
    </aside>
  );
}
