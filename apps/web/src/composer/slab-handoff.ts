import type { ThreadId } from "@gram/contracts";
import { create } from "zustand";

import type { SlabOrigin } from "@/motion";

const HANDOFF_MS = 3000;

interface SlabHandoffState {
  threadId: ThreadId | undefined;
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
    timer = setTimeout(() => set({ threadId: undefined, from: undefined }), HANDOFF_MS);
    set({ threadId, from });
  },
  done: () => {
    clearTimeout(timer);
    set({ threadId: undefined, from: undefined });
  },
}));
