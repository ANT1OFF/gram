import type { ThreadId } from "@gram/contracts";
import { create } from "zustand";

interface TraceViewState {
  readonly open: Readonly<Record<string, { readonly turn: string | undefined }>>;
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
