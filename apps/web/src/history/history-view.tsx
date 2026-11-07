import { Dialog } from "@base-ui/react/dialog";
import { useState } from "react";
import { create } from "zustand";

import { lazyPart } from "@/lib/lazy-part";
import { returnFocusTo, useOpener } from "@/lib/use-return-focus";

import type { HistoryFilter } from "./history-model";

/** The list, its search and its preview, with the past sessions it reads. */
export const historyBody = lazyPart(() => import("./history-body"));

/** The History dialog, which its shortcut may close from inside while no other dialog lets it open. */
export const HISTORY_TEST_ID = "history";

interface HistoryState {
  readonly open: boolean;
  /** The chip it shows; kept between opens, so it opens where it was left. */
  readonly filter: HistoryFilter;
  toggle: () => void;
  /** What its search starts on when it next opens, then let go of: `show`'s `query`. */
  readonly seed?: string | undefined;
  /** Opens it, on `filter` when given, searching `query` when given. */
  show: (filter?: HistoryFilter, query?: string) => void;
  close: () => void;
  setFilter: (filter: HistoryFilter) => void;
}

/** Whether History is open, and on which chip. */
export const useHistoryStore = create<HistoryState>()((set) => ({
  open: false,
  filter: "all",
  toggle: () => set((s) => ({ open: !s.open })),
  show: (filter, query) => set((s) => ({ open: true, filter: filter ?? s.filter, seed: query })),
  close: () => set({ open: false }),
  setFilter: (filter) => set({ filter }),
}));

/**
 * History: every past chat in one list, searched by title and repo as you type and narrowed by
 * kind. A click, or ↑↓ and Return, opens a Gram thread where it is, or resumes an agent's past
 * session into a new one.
 */
export function HistoryView() {
  const requested = useHistoryStore((s) => s.open);
  // Opens once its body is in hand, which the shell preloads after first paint.
  const body = historyBody.useModule(requested);
  const open = requested && body !== undefined;
  const close = useHistoryStore((s) => s.close);
  const opener = useOpener(open);
  const [picked, setPicked] = useState(false);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
        else setPicked(false);
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 scrim transition-opacity duration-(--dur-fast) data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup
          data-testid={HISTORY_TEST_ID}
          data-surface="overlay"
          aria-label="History"
          // A thread just opened takes focus in its pane; only a dismissal hands it back.
          finalFocus={() => (picked ? false : returnFocusTo(opener)())}
          className="fixed top-[6%] left-1/2 z-50 flex h-[86vh] w-[min(72rem,94vw)] -translate-x-1/2 flex-col overflow-hidden rounded-lg border border-edge bg-popover text-popover-foreground shadow-modal transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0"
        >
          {open && <body.HistoryBody onPicked={() => setPicked(true)} />}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
