/**
 * Where a client of a thread feed can resume from, which `thread.subscribe` takes as `afterRev`.
 * The feed store drives it with the events it applies, and the server's resume tests drive it with
 * the same events, so both check one set of rules.
 *
 * The server sends a resumed subscription every message stored after `afterRev`, then replays the
 * messages still streaming from their first chunk. A client holds every stored message up to the
 * revision of its last `caughtUp` or `message`. That doesn't cover a message it was folding from
 * chunks when the subscription ended: the message may have been stored since, or never stored,
 * if the server restarted. So for each fold the cursor keeps a revision below every stored write of
 * its message, resumes from below the lowest, and drops any such message the next head doesn't
 * send, since the server has no row for it.
 */
export class FeedCursor {
  #rev: number | undefined;
  /**
   * For each active fold, a revision its message's stored rows are all newer than, or `undefined`
   * when that isn't known, which only the full history can settle.
   */
  readonly #openedAt = new Map<string, number | undefined>();
  #head:
    | {
        /** The `afterRev` this subscription asked for. */
        readonly requested: number | undefined;
        resumed: boolean;
        /** The folds active when the last subscription ended, with their bounds. */
        carried: ReadonlyMap<string, number | undefined>;
        /** The messages this head sent, stored or replayed. */
        readonly received: Set<string>;
      }
    | undefined;

  /** Between a subscription's first event and its `caughtUp`. */
  get inHead(): boolean {
    return this.#head !== undefined;
  }

  /** The `afterRev` for a new subscription, or `undefined` for the full history. */
  resumeRev(): number | undefined {
    if (this.#rev === undefined) return undefined;
    let from = this.#rev;
    for (const bound of this.#pending().values()) {
      if (bound === undefined) return undefined;
      from = Math.min(from, bound);
    }
    return from;
  }

  /** A subscription starts; every fold it had is dropped, to be replayed. */
  subscribed(): void {
    const carried = this.#pending();
    const requested = this.resumeRev();
    this.#openedAt.clear();
    this.#head = { requested, resumed: false, carried, received: new Set() };
  }

  /**
   * The whole history arrived as `messages`, in a head or as a live replace-all (a rewind), which
   * starts a head of its own; every fold is dropped.
   */
  replaced(): void {
    this.#openedAt.clear();
    if (this.#head === undefined) {
      this.#head = {
        requested: undefined,
        resumed: false,
        carried: new Map(),
        received: new Set(),
      };
    } else {
      this.#head.resumed = false;
      this.#head.carried = new Map();
    }
  }

  /** The head is `resumed`, with these messages. */
  resumed(ids: Iterable<string>): void {
    if (this.#head === undefined) return;
    this.#head.resumed = true;
    for (const id of ids) this.#head.received.add(id);
  }

  message(rev: number): void {
    this.#rev = rev;
  }

  /**
   * A fold opens for `id`; `held` when the client already has a message with that id. Returns
   * whether the fold continues that message, which it never does in a head: a head replays a
   * message from its first chunk.
   */
  opened(id: string, held: boolean): boolean {
    const head = this.#head;
    if (head === undefined) {
      // A message new to the client has had no row stored before the revision it holds.
      this.#openedAt.set(id, held ? undefined : this.#rev);
      return held;
    }
    head.received.add(id);
    // One carried over keeps its bound, and one the client didn't have began after the revision
    // resumed from. A full head's are unknown.
    const bound = !head.resumed
      ? undefined
      : head.carried.has(id)
        ? head.carried.get(id)
        : held
          ? undefined
          : head.requested;
    this.#openedAt.set(id, bound);
    return false;
  }

  closed(id: string): void {
    this.#openedAt.delete(id);
  }

  /** The head is complete as of `rev`. Returns the messages to drop, which the server doesn't have. */
  caughtUp(rev: number): ReadonlyArray<string> {
    const head = this.#head;
    this.#head = undefined;
    this.#rev = rev;
    if (head === undefined || !head.resumed) return [];
    return [...head.carried.keys()].filter((id) => !head.received.has(id));
  }

  /** Forgets everything: the next subscription starts from the full history. */
  clear(): void {
    this.#rev = undefined;
    this.#openedAt.clear();
    this.#head = undefined;
  }

  /** The folds a new subscription has to account for: active ones, and those a cut-short head owed. */
  #pending(): Map<string, number | undefined> {
    const all = new Map(this.#openedAt);
    const head = this.#head;
    for (const [id, bound] of head?.carried ?? []) {
      if (!head!.received.has(id) && !all.has(id)) all.set(id, bound);
    }
    return all;
  }
}
