import type { ThreadId } from "@gram/contracts";

/** A card a shared decision (`sharedCard`) waits on, by the thread that raised it. */
export interface PendingCard {
  readonly threadId: ThreadId;
}

const pendingCards = new WeakMap<object, Map<string, PendingCard>>();

/** The cards a gate is waiting on now, by their shared key: one map per gate. */
export const pendingCardsOf = (gate: object): Map<string, PendingCard> => {
  const known = pendingCards.get(gate);
  if (known !== undefined) return known;
  const made = new Map<string, PendingCard>();
  pendingCards.set(gate, made);
  return made;
};
