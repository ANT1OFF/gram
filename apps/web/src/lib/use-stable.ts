import { useRef, useState } from "react";

/**
 * `value`, or the one returned last while `equal` says they are the same: a list rebuilt on every
 * streamed frame keeps its identity while its contents don't change, so what is memoized on it
 * stays memoized. A changed value is kept as state from this render, as React allows for state
 * derived from props.
 */
export function useStable<T>(value: T, equal: (previous: T, next: T) => boolean): T {
  const [kept, setKept] = useState(value);
  if (kept === value || equal(kept, value)) return kept;
  setKept(() => value);
  return value;
}

/**
 * `selector`, returning what it returned last while `equal` says the new selection is the same: a
 * store subscriber whose selection reads the same after a change doesn't re-render, as with
 * zustand's `useShallow`, for a selection that is rebuilt rather than picked.
 */
export function useStableSelector<S, T>(
  selector: (state: S) => T,
  equal: (previous: T, next: T) => boolean,
): (state: S) => T {
  const kept = useRef<{ value: T }>(undefined);
  return (state) => {
    const next = selector(state);
    if (kept.current !== undefined && equal(kept.current.value, next)) return kept.current.value;
    kept.current = { value: next };
    return next;
  };
}
