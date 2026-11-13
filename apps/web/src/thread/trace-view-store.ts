import type { ThreadId } from "@gram/contracts";
import { create } from "zustand";

// Which thread shows its trace in place of its conversation, and of which turn. Each window keeps
// its own, in memory only: a reload opens the conversation.

interface TraceViewState {
  /** The turn each thread's trace shows; a thread absent from it shows its conversation. */
  readonly open: Readonly<Record<string, { readonly turn: string | undefined }>>;
  /** Shows `threadId`'s trace at `turn`, or at its latest turn with tool calls when absent. */
  show: (threadId: ThreadId, turn?: string) => void;
  close: (threadId: ThreadId) => void;
}

export const useTraceViewStore = create<TraceViewState>()((set) => ({
  open: {},
  show: (threadId, turn) => set((s) => ({ open: { ...s.open, [threadId]: { turn } } })),
  close: (threadId) =>
    set((s) => {
      if (s.open[threadId] === undefined) return s;
      const { [threadId]: _closed, ...open } = s.open;
      return { open };
    }),
}));
