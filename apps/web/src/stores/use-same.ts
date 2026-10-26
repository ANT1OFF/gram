import { useRef } from "react";

import { keepSame } from "@/lib/same-data";

/**
 * `select`, handing back its last result while a new one reads the same (`sameData`), as
 * `useShallow` does one level deep: `useThreadsStore(useSame((s) => …))` re-renders only when what
 * it derives reads differently, and sits out every other change to the store. For an
 * always-mounted view that derives a little from the whole thread map, which changes many times a
 * second while threads work.
 */
export function useSame<S, T>(select: (state: S) => T): (state: S) => T {
  const last = useRef<{ value: T } | undefined>(undefined);
  return (state) => {
    const next = select(state);
    const kept = keepSame(last.current?.value, next);
    if (last.current?.value !== kept) last.current = { value: kept };
    return kept;
  };
}
