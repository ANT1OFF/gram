import type {
  MessageId,
  ThreadId,
  WaitId,
  WaitItem,
  WaitKind,
  WaitListState,
} from "@gram/contracts";

/** What waits on the user in a thread: open items ride in `ThreadSummary.waits`. */
export interface WaitsApi {
  /**
   * Marks an item done, or with `undo` reopens it. Resolves to the item as it then is; the thread's
   * open items also arrive as `thread.waits`. The agent hears of it with the next message.
   */
  resolveWait(threadId: ThreadId, id: WaitId, undo?: boolean): Promise<WaitItem>;
  /** Keeps a helper's suggestion as an item of the thread's own, counted from then on. */
  keepWait(threadId: ThreadId, id: WaitId): Promise<WaitItem>;
  /**
   * "Add to Waiting on you" on a message: a `draft` unless `kind` says otherwise, titled from the
   * message's first line unless `title` names it, anchored there. Resolves to the item added.
   */
  addWait(
    threadId: ThreadId,
    messageId: MessageId,
    options?: { readonly kind?: WaitKind; readonly title?: string },
  ): Promise<WaitItem>;
  /** The thread's items, oldest first: the open ones, or with `all` the resolved ones kept too. */
  listWaits(threadId: ThreadId, state?: WaitListState): Promise<readonly WaitItem[]>;
}
