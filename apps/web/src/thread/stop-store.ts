import type { ThreadId } from "@gram/contracts";
import { create } from "zustand";

import type { Api } from "@/api/types";

// When the user last pressed Stop on each thread, so the turn it ends can say "Stopped by you". A
// turn ended by a restart, a pause or the orchestrator says only "Stopped". Kept for the session:
// after a reload, a stop reads as "Stopped".

interface StopState {
  readonly stoppedAt: Readonly<Record<string, number>>;
  stopped(threadId: ThreadId, at: number): void;
}

export const useStopStore = create<StopState>()((set) => ({
  stoppedAt: {},
  stopped: (threadId, at) => set((s) => ({ stoppedAt: { ...s.stoppedAt, [threadId]: at } })),
}));

/** Stops the thread's turn as the user, which its stop receipt then names. */
export const stopTurn = (api: Pick<Api, "interrupt">, threadId: ThreadId): Promise<void> => {
  useStopStore.getState().stopped(threadId, Date.now());
  return api.interrupt(threadId);
};
