import type { ThreadSuggestions } from "@gram/contracts";
import { create } from "zustand";

/** One thread's suggested replies, for the turn they answer. */
export interface SuggestionEntry {
  readonly turnId: string;
  readonly replies: readonly string[];
  /**
   * The suggestion ⌥↓ / ⌥↑ moved to, kept while what's typed still fits it, so taking it a word at
   * a time stays on it; otherwise the first that fits shows.
   */
  readonly chosen: string | undefined;
  /** Esc put them away for the rest of this turn. */
  readonly dismissed: boolean;
  /** Counted as shown, once a turn. */
  readonly counted: boolean;
  /** Counted as taken, whole or in part, once a turn. */
  readonly taken: boolean;
  /**
   * The server took these back (`ThreadSuggestions.stale`: the plan they answered was edited):
   * nothing shows, and the composer asks again once the user is looking.
   */
  readonly stale: boolean;
  /** Counts the times they were taken back this turn, so the composer asks once after each. */
  readonly takenBack: number;
}

interface SuggestionsState {
  readonly byThread: Readonly<Record<string, SuggestionEntry>>;
  /** Moves on each `reset`, so a composer that asked before it asks again. */
  readonly generation: number;
  /**
   * Takes a turn's suggestions. The same turn's again keeps where the user had got to; with other
   * replies (made again for an edited plan) they replace the old, still dismissed or counted. A
   * `stale` offer takes the turn's back.
   */
  offer(suggestions: ThreadSuggestions): void;
  /** A new turn or message: the suggestions answered the one before. */
  clear(threadId: string): void;
  /** Every thread's, for a snapshot that may have skipped turns. */
  reset(): void;
  /** Moves to `chosen`, or back to the first that fits with `undefined`. */
  choose(threadId: string, chosen: string | undefined): void;
  dismiss(threadId: string): void;
  /** Marks the turn's suggestions shown; true the first time. */
  count(threadId: string): boolean;
  /** Marks the turn's suggestions taken; true the first time. */
  take(threadId: string): boolean;
}

const update = (
  byThread: SuggestionsState["byThread"],
  threadId: string,
  patch: Partial<SuggestionEntry>,
): SuggestionsState["byThread"] => {
  const current = byThread[threadId];
  return current === undefined ? byThread : { ...byThread, [threadId]: { ...current, ...patch } };
};

const sameReplies = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((reply, i) => reply === b[i]);

export const useSuggestionsStore = create<SuggestionsState>()((set, get) => ({
  byThread: {},
  generation: 0,
  offer: ({ threadId, turnId, replies, stale }) =>
    set((s) => {
      const known = s.byThread[threadId];
      const same = known?.turnId === turnId;
      // Taking back another turn's, or none, takes nothing: the composer asks for a turn it lacks.
      if (stale === true) {
        if (!same) return s;
        const entry = {
          ...known,
          replies: [],
          chosen: undefined,
          stale: true,
          takenBack: known.takenBack + 1,
        };
        return { byThread: { ...s.byThread, [threadId]: entry } };
      }
      if (same && !known.stale && sameReplies(known.replies, replies)) return s;
      const entry: SuggestionEntry = {
        turnId,
        replies,
        chosen: undefined,
        dismissed: same && known.dismissed,
        counted: same && known.counted,
        taken: same && known.taken,
        stale: false,
        takenBack: same ? known.takenBack : 0,
      };
      return { byThread: { ...s.byThread, [threadId]: entry } };
    }),
  clear: (threadId) =>
    set((s) => {
      if (s.byThread[threadId] === undefined) return s;
      const { [threadId]: _gone, ...rest } = s.byThread;
      return { byThread: rest };
    }),
  reset: () => set((s) => ({ byThread: {}, generation: s.generation + 1 })),
  choose: (threadId, chosen) =>
    set((s) => ({ byThread: update(s.byThread, threadId, { chosen }) })),
  dismiss: (threadId) =>
    set((s) => ({ byThread: update(s.byThread, threadId, { dismissed: true }) })),
  count: (threadId) => {
    const entry = get().byThread[threadId];
    if (entry === undefined || entry.counted) return false;
    set((s) => ({ byThread: update(s.byThread, threadId, { counted: true }) }));
    return true;
  },
  take: (threadId) => {
    const entry = get().byThread[threadId];
    if (entry === undefined || entry.taken) return false;
    set((s) => ({ byThread: update(s.byThread, threadId, { taken: true }) }));
    return true;
  },
}));
