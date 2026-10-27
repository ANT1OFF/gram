import type { ThreadId } from "@gram/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/** Threads whose unfolded strip is remembered; the least recently unfolded go first. */
const EXPANDED_LIMIT = 100;

interface PrStripFoldState {
  /** Threads whose PR strip shows every row; any other thread's starts folded. */
  expanded: readonly string[];
  setExpanded(threadId: ThreadId, expanded: boolean): void;
}

const sanitize = (raw: unknown): string[] =>
  Array.isArray(raw)
    ? raw.filter((id): id is string => typeof id === "string").slice(-EXPANDED_LIMIT)
    : [];

/** Whether each thread's PR strip is folded, kept on this machine only. */
export const usePrStripFold = create<PrStripFoldState>()(
  persist(
    (set) => ({
      expanded: [],
      setExpanded: (threadId, expanded) =>
        set((s) => {
          const others = s.expanded.filter((id) => id !== threadId);
          return { expanded: expanded ? sanitize([...others, threadId]) : others };
        }),
    }),
    {
      name: "gram.prStrip",
      version: 1,
      // `window`, not `globalThis`: under Node, reading `globalThis.localStorage` warns that it has no
      // backing file, while a missing `window` throws, which zustand takes as no storage.
      storage: createJSONStorage(() => window.localStorage),
      partialize: ({ expanded }) => ({ expanded }),
      merge: (persisted, current) => ({
        ...current,
        expanded: sanitize((persisted as { expanded?: unknown } | undefined)?.expanded),
      }),
    },
  ),
);
