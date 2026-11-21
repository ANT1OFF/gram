import type { ThreadId } from "@gram/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

const EXPANDED_LIMIT = 100;

interface PrStripFoldState {
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
      storage: createJSONStorage(() => window.localStorage),
      partialize: ({ expanded }) => ({ expanded }),
      merge: (persisted, current) => ({
        ...current,
        expanded: sanitize((persisted as { expanded?: unknown } | undefined)?.expanded),
      }),
    },
  ),
);
