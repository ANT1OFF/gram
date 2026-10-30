import type { ThreadId } from "@gram/contracts";
import { create } from "zustand";

const keyOf = (threadId: ThreadId, turn: string) => `${threadId}:${turn}`;

interface TurnFoldsState {
  open: ReadonlySet<string>;
  toggle(threadId: ThreadId, turn: string): void;
  /** Opens a fold something is about to scroll into, and leaves one that's open alone. */
  reveal(threadId: ThreadId, turn: string): void;
}

/**
 * The finished turns a reader opened. Here rather than in the row, which the transcript's list
 * unmounts on scroll and on leaving the thread, and only for as long as the app is open.
 */
export const useTurnFolds = create<TurnFoldsState>()((set) => ({
  open: new Set(),
  toggle: (threadId, turn) =>
    set((s) => {
      const key = keyOf(threadId, turn);
      const open = new Set(s.open);
      if (!open.delete(key)) open.add(key);
      return { open };
    }),
  reveal: (threadId, turn) =>
    set((s) => {
      const key = keyOf(threadId, turn);
      return s.open.has(key) ? s : { open: new Set(s.open).add(key) };
    }),
}));

export const isFoldOpen = (open: ReadonlySet<string>, threadId: ThreadId, turn: string): boolean =>
  open.has(keyOf(threadId, turn));
