import type { ThreadId } from "@gram/contracts";
import { create } from "zustand";

interface StashMenuState {
  openFor: ThreadId | undefined;
  open(threadId: ThreadId): void;
  close(): void;
}

export const useStashMenuStore = create<StashMenuState>()((set) => ({
  openFor: undefined,
  open: (threadId) => set({ openFor: threadId }),
  close: () => set({ openFor: undefined }),
}));
