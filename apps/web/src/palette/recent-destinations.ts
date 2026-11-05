import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/** How many destinations the palette remembers going to. */
const KEPT = 5;

interface RecentDestinationsState {
  /** Destination ids (`go:…`), the most recent first. */
  readonly ids: readonly string[];
  visit: (id: string) => void;
}

/**
 * The palette's destinations gone to lately, on this machine, so its unfiltered view leads with
 * them as Recent and suggests the rest.
 */
export const useRecentDestinations = create<RecentDestinationsState>()(
  persist(
    (set) => ({
      ids: [],
      visit: (id) =>
        set((s) => ({ ids: [id, ...s.ids.filter((each) => each !== id)].slice(0, KEPT) })),
    }),
    {
      name: "gram.palette.recent",
      storage: createJSONStorage(() => localStorage),
      partialize: ({ ids }) => ({ ids }),
    },
  ),
);
