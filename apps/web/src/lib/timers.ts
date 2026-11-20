import { useCallback, useEffect, useState } from "react";

/** `value`, once it has held still for `ms` (at once when `ms` is 0): a search box's query. */
export function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    if (ms <= 0) return;
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return ms <= 0 ? value : debounced;
}

/**
 * A mark shown for `ms` and then cleared, such as "Copied": `flash(value)` shows `value`, and a
 * second flash restarts the time.
 */
export function useFlash<T = true>(ms: number): [T | undefined, (value: T) => void] {
  const [shown, setShown] = useState<{ value: T } | undefined>();
  useEffect(() => {
    if (!shown) return;
    const timer = setTimeout(() => setShown(undefined), ms);
    return () => clearTimeout(timer);
  }, [shown, ms]);
  const flash = useCallback((value: T) => setShown({ value }), []);
  return [shown?.value, flash];
}

/** Resolves once the browser has drawn the next frame, for work that awaits a paint in a loop. */
export const painted = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()));
