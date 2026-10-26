import type { ThreadId } from "@gram/contracts";
import { create } from "zustand";

interface StashMenuState {
  /** The thread whose "Stashed drafts" list is open, from its button or ⌘K. */
  openFor: ThreadId | undefined;
  open(threadId: ThreadId): void;
  close(): void;
}

export const useStashMenuStore = create<StashMenuState>()((set) => ({
  openFor: undefined,
  open: (threadId) => set({ openFor: threadId }),
  close: () => set({ openFor: undefined }),
}));
