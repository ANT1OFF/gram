import type { ThreadId, ThreadWakes } from "@gram/contracts";

/** `threads.wakes` and `thread.cancelWake`: the wakes plain threads set themselves. */
export interface ThreadWakesApi {
  /** Every plain thread's pending wakes, soonest first. */
  listThreadWakes(): Promise<ThreadWakes>;
  /** Drops the thread's wake `id`, or with no `id` all of them. */
  cancelThreadWake(threadId: ThreadId, id?: string): Promise<{ readonly cancelled: number }>;
}
