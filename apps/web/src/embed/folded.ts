import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { ShellNavigationGroup } from "./contract";
import { foldable, groupOpen } from "./store";

// Collapsible navigation groups as the person last left them, by the group's id, kept on this
// device. A group nobody has opened or closed starts as the embedding app says.

interface FoldedState {
  /** Open (true) or closed (false), by group id; a group left out was never touched. */
  open: Readonly<Record<string, boolean>>;
  set(id: string, open: boolean): void;
}

const sanitize = (raw: unknown): Record<string, boolean> =>
  typeof raw === "object" && raw !== null
    ? Object.fromEntries(
        Object.entries(raw).filter(
          (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
        ),
      )
    : {};

export const useFoldedGroups = create<FoldedState>()(
  persist(
    (set) => ({
      open: {},
      set: (id, open) => set((s) => ({ open: { ...s.open, [id]: open } })),
    }),
    {
      name: "gram.embedNavigationOpen",
      version: 1,
      // `window`, not `globalThis`: see model-favourites.ts.
      storage: createJSONStorage(() => window.localStorage),
      partialize: ({ open }) => ({ open }),
      merge: (persisted, current) => ({
        ...current,
        open: sanitize((persisted as { open?: unknown } | undefined)?.open),
      }),
    },
  ),
);

/** A group's fold: whether it folds, whether it is open, and the way to open or close it. */
export function useGroupFold(group: ShellNavigationGroup) {
  const kept = useFoldedGroups((s) => s.open[group.id]);
  const set = useFoldedGroups((s) => s.set);
  const open = groupOpen(group, kept);
  return { foldable: foldable(group), open, toggle: () => set(group.id, !open) };
}
