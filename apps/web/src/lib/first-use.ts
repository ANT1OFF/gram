import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/** Gram's own words that carry a first-use explanation (`EXPLAIN`), by their key there. */
export type TermId = "solo" | "takeOver" | "quiet" | "dreams";

interface FirstUseState {
  /** The terms whose explanation was shown once, on this machine. */
  readonly seen: Readonly<Partial<Record<TermId, true>>>;
  see: (term: TermId) => void;
}

/**
 * Which of Gram's terms the user has had explained. Until a term's explanation has opened once, the
 * word carries a dotted underline that says there is one (`Term`); after, it reads as plain text and
 * the explanation stays on its hover.
 */
export const useFirstUse = create<FirstUseState>()(
  persist(
    (set) => ({
      seen: {},
      see: (term) =>
        set((s) => (s.seen[term] === true ? s : { seen: { ...s.seen, [term]: true } })),
    }),
    {
      name: "gram.first-use",
      storage: createJSONStorage(() => localStorage),
      partialize: ({ seen }) => ({ seen }),
    },
  ),
);

/** Records that `term` was explained once its explanation opens. */
export const seeTerm = (term: TermId) => useFirstUse.getState().see(term);
