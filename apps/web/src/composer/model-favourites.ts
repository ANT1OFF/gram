import type { AgentKind } from "@gram/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/** Favourites kept; the least recently starred go first past it. */
const FAVOURITE_LIMIT = 200;

const keyOf = (agent: AgentKind, model: string) => `${agent}:${model}`;

interface ModelFavouritesState {
  /** `agent:model` keys, the most recently starred last. */
  keys: readonly string[];
  toggle(agent: AgentKind, model: string): void;
}

const sanitize = (raw: unknown): string[] =>
  Array.isArray(raw)
    ? raw.filter((key): key is string => typeof key === "string").slice(-FAVOURITE_LIMIT)
    : [];

/** The models starred in the composer's model picker, per agent, kept on this machine only. */
export const useModelFavourites = create<ModelFavouritesState>()(
  persist(
    (set) => ({
      keys: [],
      toggle: (agent, model) =>
        set((s) => {
          const key = keyOf(agent, model);
          return s.keys.includes(key)
            ? { keys: s.keys.filter((k) => k !== key) }
            : { keys: sanitize([...s.keys, key]) };
        }),
    }),
    {
      name: "gram.modelFavourites",
      version: 1,
      // `window`, not `globalThis`: under Node, reading `globalThis.localStorage` warns that it has no
      // backing file, while a missing `window` throws, which zustand takes as no storage.
      storage: createJSONStorage(() => window.localStorage),
      partialize: ({ keys }) => ({ keys }),
      merge: (persisted, current) => ({
        ...current,
        keys: sanitize((persisted as { keys?: unknown } | undefined)?.keys),
      }),
    },
  ),
);

/** Whether `model` is starred for `agent`, as a predicate over model ids. */
export function useIsFavourite(agent: AgentKind): (model: string) => boolean {
  const keys = useModelFavourites((s) => s.keys);
  return (model) => keys.includes(keyOf(agent, model));
}
