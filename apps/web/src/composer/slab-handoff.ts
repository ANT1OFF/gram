import type { ThreadId } from "@gram/contracts";
import { create } from "zustand";

import type { SlabOrigin } from "@/motion";

/** How long a handoff waits for the thread's composer to mount before it is dropped. */
const HANDOFF_MS = 3000;

interface SlabHandoffState {
  /** The thread `/new` just created, whose composer the hero's prompt box moves into. */
  threadId: ThreadId | undefined;
  /** Where the hero's prompt box was when it was sent. */
  from: SlabOrigin | undefined;
  hand(threadId: ThreadId, from: SlabOrigin): void;
  done(): void;
}

let timer: ReturnType<typeof setTimeout> | undefined;

/** Which thread's composer takes over the hero's slab: one thread, once, right after `/new`. */
export const useSlabHandoff = create<SlabHandoffState>()((set) => ({
  threadId: undefined,
  from: undefined,
  hand: (threadId, from) => {
    clearTimeout(timer);
    // Dropped if the move never runs (motion off, or the thread opened somewhere else), so a
    // later remount of that composer doesn't fly in from where the hero was.
    timer = setTimeout(() => set({ threadId: undefined, from: undefined }), HANDOFF_MS);
    set({ threadId, from });
  },
  done: () => {
    clearTimeout(timer);
    set({ threadId: undefined, from: undefined });
  },
}));
