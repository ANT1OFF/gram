import type { ThreadId } from "@gram/contracts";
import { create } from "zustand";

/**
 * The lapsed connectors the user dismissed the notice for, per thread. A connector leaves the list
 * once it is no longer lapsed, so lapsing again brings its notice back.
 */
export const useLapsedDismissals = create<{
  readonly byThread: Readonly<Record<string, ReadonlyArray<string>>>;
  dismiss(threadId: ThreadId, name: string): void;
  /** Keeps only the dismissals of connectors still in `lapsed`. */
  prune(threadId: ThreadId, lapsed: ReadonlyArray<string>): void;
  /**
   * `prune` for every thread at once, from a snapshot's lapsed connectors by thread: a thread it
   * leaves out has none, so a thread reopened later under the same id starts with no dismissals.
   */
  reconcile(lapsedByThread: Readonly<Record<string, ReadonlyArray<string>>>): void;
}>((set) => ({
  byThread: {},
  dismiss: (threadId, name) =>
    set((s) => ({
      byThread: { ...s.byThread, [threadId]: [...(s.byThread[threadId] ?? []), name] },
    })),
  prune: (threadId, lapsed) =>
    set((s) => {
      const kept = (s.byThread[threadId] ?? []).filter((name) => lapsed.includes(name));
      return kept.length === (s.byThread[threadId] ?? []).length
        ? s
        : { byThread: { ...s.byThread, [threadId]: kept } };
    }),
  reconcile: (lapsedByThread) =>
    set((s) => ({
      byThread: Object.fromEntries(
        Object.entries(s.byThread).flatMap(([threadId, names]) => {
          const kept = names.filter((name) => lapsedByThread[threadId]?.includes(name));
          return kept.length === 0 ? [] : [[threadId, kept]];
        }),
      ),
    })),
}));
