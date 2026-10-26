import { useState } from "react";

const NONE: ReadonlySet<string> = new Set();

/**
 * The ids in `next` that `previous` didn't hold. For a list that loads, filling from empty is the
 * list loading rather than its items arriving, so that counts for none unless `fromEmpty` says the
 * list is one that starts empty and is added to (a composer's attachments).
 */
export const arrivalsOf = (
  previous: ReadonlySet<string>,
  next: readonly string[],
  fromEmpty = false,
): ReadonlySet<string> =>
  previous.size === 0 && !fromEmpty ? NONE : new Set(next.filter((id) => !previous.has(id)));

/**
 * Which of a list's items are new since it last changed, so only they animate in. Nothing is new on
 * the first render, and an item that merely moves between two lists under the same id (a thread
 * changing status group) is not new either: it glides, and fading it in as well would read as a
 * flicker.
 */
export function useArrivals(ids: readonly string[], fromEmpty = false): ReadonlySet<string> {
  const key = ids.join("\n");
  const [seen, setSeen] = useState({ key, ids: new Set(ids), arrivals: NONE });
  if (seen.key === key) return seen.arrivals;
  // Derived during render, so the answer is there on the very render that mounts the new item.
  const arrivals = arrivalsOf(seen.ids, ids, fromEmpty);
  setSeen({ key, ids: new Set(ids), arrivals });
  return arrivals;
}
