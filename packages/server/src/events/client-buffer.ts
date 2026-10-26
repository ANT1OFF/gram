import type { ServerEvent } from "@gram/contracts";

/** What `take` hands the consumer. */
export interface Taken<A> {
  readonly items: ReadonlyArray<A>;
  /** Events were dropped since the last take; the consumer must resync before `items`. */
  readonly overflowed: boolean;
}

/**
 * One client's outbound events, bounded. A client that keeps up gets every event. Past `capacity`
 * the buffer compacts: each key keeps only its latest item (full state supersedes), unkeyed items
 * stay. If it's still full, it clears and ignores offers until the next take, which reports the
 * overflow so the consumer resyncs from a snapshot instead of replaying a stale backlog.
 */
export class ClientBuffer<A> {
  readonly capacity: number;
  readonly keyOf: (item: A) => string | undefined;
  #queued: Array<A> = [];
  #overflowed = false;

  constructor(capacity: number, keyOf: (item: A) => string | undefined = () => undefined) {
    this.capacity = capacity;
    this.keyOf = keyOf;
  }

  /** Nothing to take: no queued items and no pending resync. */
  get isEmpty(): boolean {
    return this.#queued.length === 0 && !this.#overflowed;
  }

  offer(item: A): void {
    if (this.#overflowed) return;
    this.#queued.push(item);
    if (this.#queued.length > this.capacity) this.#compact();
  }

  take(): Taken<A> {
    const taken = { items: this.#queued, overflowed: this.#overflowed };
    this.#queued = [];
    this.#overflowed = false;
    return taken;
  }

  #compact() {
    const latest = new Map<string, number>();
    this.#queued.forEach((item, index) => {
      const key = this.keyOf(item);
      if (key !== undefined) latest.set(key, index);
    });
    this.#queued = this.#queued.filter((item, index) => {
      const key = this.keyOf(item);
      return key === undefined || latest.get(key) === index;
    });
    if (this.#queued.length > this.capacity) {
      this.#queued = [];
      this.#overflowed = true;
    }
  }
}

/**
 * Full-state events coalesce per thread under pressure, and a workspace's invalidations into one;
 * everything else is kept in order.
 */
export const serverEventKey = (event: ServerEvent): string | undefined => {
  switch (event.type) {
    case "thread.upsert":
      return `${event.type}:${event.thread.id}`;
    case "thread.status":
    case "thread.queue":
    case "thread.identity":
    case "thread.usage":
    case "thread.plan":
    case "thread.waits":
    case "thread.ports":
    case "thread.terminalProcesses":
    case "thread.background":
    case "thread.lapsedConnectors":
    case "git.state":
      return `${event.type}:${event.threadId}`;
    // Each read is the task's whole tail so far.
    case "thread.backgroundOutput":
      return `${event.type}:${event.threadId}:${event.taskId}`;
    // A ledger moves with every worker, and the event only says "refetch": the last one will do.
    case "orchestration.changed":
    case "memory.changed":
    case "outputs.changed":
      return `${event.type}:${event.workspaceId}`;
    default:
      return undefined;
  }
};
