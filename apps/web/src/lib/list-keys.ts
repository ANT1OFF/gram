import type { KeyboardEvent } from "react";

/** How far PageUp / PageDown move in a list. */
export const PAGE_STEP = 8;

/**
 * The next active index in a list of `count` items for `key`: ↑ / ↓ wrap, Home / End jump to the
 * ends, PageUp / PageDown move a page and stop at the ends. `undefined` for any other key.
 */
export function listIndexForKey(key: string, active: number, count: number): number | undefined {
  if (count === 0) return undefined;
  switch (key) {
    case "ArrowDown":
      return (active + 1) % count;
    case "ArrowUp":
      return (active - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    case "PageDown":
      return Math.min(active + PAGE_STEP, count - 1);
    case "PageUp":
      return Math.max(active - PAGE_STEP, 0);
    default:
      return undefined;
  }
}

/**
 * Keys for a hand-built radiogroup, like native radios: one Tab stop, and the arrows (or Home /
 * End) move to and choose the next option. Give each radio `tabIndex={checked ? 0 : -1}`.
 */
export function radioGroupKeyDown<T>(
  event: KeyboardEvent<HTMLElement>,
  values: readonly T[],
  current: T,
  choose: (value: T) => void,
): void {
  const count = values.length;
  const index = Math.max(values.indexOf(current), 0);
  const next =
    event.key === "ArrowRight" || event.key === "ArrowDown"
      ? (index + 1) % count
      : event.key === "ArrowLeft" || event.key === "ArrowUp"
        ? (index - 1 + count) % count
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? count - 1
            : undefined;
  if (next === undefined || count === 0) return;
  event.preventDefault();
  choose(values[next]!);
  event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
}
