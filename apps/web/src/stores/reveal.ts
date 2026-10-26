import type { ThreadId } from "@gram/contracts";
import { create } from "zustand";

interface RevealRequest {
  threadId: ThreadId;
  messageId: string;
  nonce: number;
}

interface RevealState {
  request: RevealRequest | undefined;
  reveal(threadId: ThreadId, messageId: string): void;
  /** Clears the request once a thread view has scrolled to it; a newer request is kept. */
  done(nonce: number): void;
}

/** A message to scroll to and flash once its thread view has it, e.g. a search hit from ⌘K. */
export const useRevealStore = create<RevealState>()((set) => ({
  request: undefined,
  reveal: (threadId, messageId) => set({ request: { threadId, messageId, nonce: Date.now() } }),
  done: (nonce) => set((s) => (s.request?.nonce === nonce ? { request: undefined } : {})),
}));

export interface RequestRevealRequest {
  threadId: ThreadId;
  requestId: string;
}

/**
 * A pending request to show among its thread's cards, e.g. from a Needs you jump: an approval queue
 * that holds it shows that one, once.
 */
export const useRequestRevealStore = create<{
  request: RequestRevealRequest | undefined;
  reveal(threadId: ThreadId, requestId: string): void;
  /** Taken by the queue that shows it. */
  clear(): void;
}>()((set) => ({
  request: undefined,
  reveal: (threadId, requestId) => set({ request: { threadId, requestId } }),
  clear: () => set({ request: undefined }),
}));
