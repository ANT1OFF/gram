import type { ThreadId } from "@gram/contracts";
import { create } from "zustand";

interface AllActivityState {
  /** Orchestrator threads whose chat shows every digest and reply, unfolded. */
  readonly shown: ReadonlySet<ThreadId>;
  set(threadId: ThreadId, shown: boolean): void;
}

/**
 * "Show all activity" on an orchestrator's chat: off, what changed nothing for the user folds into
 * its update; on, the whole stream as it was sent. Per thread, for as long as the app is open, as
 * the transcript's opened folds are. Only the view changes: the agent's digests are the same.
 */
export const useAllActivity = create<AllActivityState>()((set) => ({
  shown: new Set(),
  set: (threadId, shown) =>
    set((s) => {
      if (s.shown.has(threadId) === shown) return s;
      const next = new Set(s.shown);
      if (shown) next.add(threadId);
      else next.delete(threadId);
      return { shown: next };
    }),
}));
