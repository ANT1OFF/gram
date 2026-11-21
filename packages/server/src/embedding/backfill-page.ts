import type { StoredMessage } from "../persistence/thread-store.ts";

/** A page of a thread's stored messages, read after `afterSeq` and at most `limit` long. */
export interface BackfillRead {
  readonly page: ReadonlyArray<StoredMessage>;
  readonly afterSeq: number;
  readonly limit: number;
}

/** What a page records: its events, and where the thread goes on from, or `"done"`. */
export interface BackfillStep<E> {
  readonly events: ReadonlyArray<E>;
  readonly afterSeq: number | "done";
}

/**
 * What one step of the event sink's backfill makes of a page of a thread's stored messages: as
 * many as one batch carries, and one at least, up to the first that is still streaming. A reply
 * stored mid-stream is part of one, so the backfill waits at it, and it goes when it settles.
 */
export const backfillPage = <E>(
  { page, afterSeq, limit }: BackfillRead,
  options: {
    /** Whether a message is stored only in part, as it streams. */
    readonly streaming: (messageId: string) => boolean;
    readonly event: (stored: StoredMessage) => E;
    readonly batchBytes: number;
    /** Whether it is to be sent: one that went as it changed is at the receiver as it is now. */
    readonly owed: (stored: StoredMessage) => boolean;
  },
): BackfillStep<E> => {
  const streams = page.findIndex((stored) => options.streaming(stored.message.id));
  const ready = streams === -1 ? page : page.slice(0, streams);
  let bytes = 0;
  let taken = 0;
  const events: Array<E> = [];
  for (const stored of ready) {
    const event = options.event(stored);
    bytes += JSON.stringify(event).length;
    if (taken > 0 && bytes > options.batchBytes) break;
    taken++;
    if (options.owed(stored)) events.push(event);
  }
  if (taken === page.length && page.length < limit) return { events, afterSeq: "done" };
  return { events, afterSeq: taken === 0 ? afterSeq : page[taken - 1]!.seq };
};
