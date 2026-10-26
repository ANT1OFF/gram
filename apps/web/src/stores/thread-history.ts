import type { ThreadId, ThreadSummary } from "@gram/contracts";
import { create } from "zustand";

// Per window: each window keeps its own focus order, in memory. Closed threads live on the server
// (`threads.closed.*`), so ⌘⇧T reaches them across reloads and restarts.

interface ThreadHistoryState {
  /** Thread ids, most recently focused first. */
  readonly recent: readonly ThreadId[];
  /** Moves `threadId` to the front of `recent`. */
  touch(threadId: ThreadId): void;
  /** Drops a thread that left the list from the focus order. */
  forget(threadId: ThreadId): void;
}

export const useThreadHistory = create<ThreadHistoryState>()((set) => ({
  recent: [],
  touch: (threadId) =>
    set((s) =>
      s.recent[0] === threadId
        ? s
        : { recent: [threadId, ...s.recent.filter((id) => id !== threadId)] },
    ),
  forget: (threadId) => set((s) => ({ recent: s.recent.filter((id) => id !== threadId) })),
}));

/** The Ctrl+Tab order: most recently focused first, then the rest by last activity. */
export function switchOrder(
  recent: readonly ThreadId[],
  summaries: Iterable<ThreadSummary>,
): ThreadId[] {
  const all = [...summaries];
  const known = new Set(all.map((s) => s.thread.id));
  const seen = recent.filter((id) => known.has(id));
  const rest = all
    .filter((s) => !seen.includes(s.thread.id))
    .toSorted((a, b) => b.thread.lastActivityAt - a.thread.lastActivityAt)
    .map((s) => s.thread.id);
  return [...seen, ...rest];
}
