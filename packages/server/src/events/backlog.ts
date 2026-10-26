import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";

/** The depth past which a lossless queue's backlog is logged, and doubles from for the next line. */
export const BACKLOG_LOG_FLOOR = 1_000;

/**
 * The depth and high-water mark of one lossless, unbounded queue, measured only when something is
 * offered or taken, so an idle queue costs nothing. It warns at `floor` and at every doubling past
 * it, and says so once the backlog has fallen back under half the floor.
 */
export class BacklogGauge {
  readonly name: string;
  readonly floor: number;
  #highWater = 0;
  #nextWarnAt: number;

  constructor(name: string, floor: number = BACKLOG_LOG_FLOOR) {
    this.name = name;
    this.floor = floor;
    this.#nextWarnAt = floor;
  }

  /** The deepest the queue has been since it was made. */
  get highWater(): number {
    return this.#highWater;
  }

  /** Records `depth`, returning the log line it is owed, if any, for the caller to run. */
  observe(depth: number, oldestAgeMs?: number): Effect.Effect<void> | undefined {
    if (depth > this.#highWater) this.#highWater = depth;
    if (depth >= this.#nextWarnAt) {
      while (depth >= this.#nextWarnAt) this.#nextWarnAt *= 2;
      return Effect.logWarning("internal backlog growing").pipe(
        Effect.annotateLogs({
          queue: this.name,
          depth,
          highWater: this.#highWater,
          ...(oldestAgeMs === undefined ? {} : { oldestAgeMs }),
        }),
      );
    }
    // Half the floor, so a backlog hovering at the floor doesn't log on every offer.
    if (this.#nextWarnAt > this.floor && depth < this.floor / 2) {
      this.#nextWarnAt = this.floor;
      return Effect.logInfo("internal backlog drained").pipe(
        Effect.annotateLogs({ queue: this.name, depth, highWater: this.#highWater }),
      );
    }
    return undefined;
  }
}

/** Which items of a `CoalescingQueue` may stand in for one another. */
export interface Coalescing<A> {
  /** What `item` is about, or `undefined` for an item about nothing in particular. */
  readonly subjectOf: (item: A) => string | undefined;
  /**
   * For an item whose handler only reads the latest state of its subject, the kind under which a
   * later item of the same subject supersedes it; `undefined` for one that must be handled as sent.
   */
  readonly replaceableAs: (item: A) => string | undefined;
  /**
   * Of a replaceable item, every field its handler compares with what it saw last, as one string. A
   * later item supersedes a waiting one only when the two agree on it, so a change the handler acts
   * on is never folded into the state after it. One string for every item of a kind whose handler
   * compares nothing; absent when no kind's does.
   */
  readonly transitionOf?: ((item: A) => string) | undefined;
}

interface Slot<A> {
  item: A;
  readonly at: number;
  readonly subject: string | undefined;
  readonly kind: string | undefined;
  readonly transition: string | undefined;
  next: Slot<A> | undefined;
}

export interface CoalescingQueue<A> {
  offer(item: A): Effect.Effect<void>;
  /** The oldest item, waiting for one if there is none. */
  readonly take: Effect.Effect<A>;
  /** Items waiting, counting each coalesced run once. */
  readonly depth: () => number;
  readonly gauge: BacklogGauge;
}

/**
 * An unbounded FIFO that never drops what it must deliver, but keeps only one waiting item per
 * replaceable kind, subject and transition. A replaceable item offered while one of its kind and
 * subject waits, and agrees with it on `transitionOf`, takes that item's place in the line, so it is
 * handled no later than the first would have been, with the newest state; one that disagrees queues
 * behind it. Any other item about the same subject closes the run: what comes after it
 * queues behind it, so one subject's items are handled in the order they were sent, less only the
 * replaceable ones a later one superseded before it was taken.
 */
export const makeCoalescingQueue = <A>(
  name: string,
  coalescing: Coalescing<A>,
  floor?: number,
): Effect.Effect<CoalescingQueue<A>> =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<Slot<A>>();
    const gauge = new BacklogGauge(name, floor);
    /** Each subject's waiting replaceable items, by kind. */
    const waiting = new Map<string, Map<string, Slot<A>>>();
    // The same slots as `queue`, oldest first, so the oldest's age can be read without taking it.
    let head: Slot<A> | undefined;
    let tail: Slot<A> | undefined;
    let depth = 0;

    const observe = (now: number) =>
      gauge.observe(depth, head === undefined ? undefined : now - head.at) ?? Effect.void;

    const offer = (item: A) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) => {
        const subject = coalescing.subjectOf(item);
        const kind = subject === undefined ? undefined : coalescing.replaceableAs(item);
        const transition = kind === undefined ? undefined : coalescing.transitionOf?.(item);
        if (subject !== undefined && kind !== undefined) {
          const waitingSlot = waiting.get(subject)?.get(kind);
          if (waitingSlot !== undefined && waitingSlot.transition === transition) {
            waitingSlot.item = item;
            return Effect.void;
          }
        } else if (subject !== undefined) {
          waiting.delete(subject);
        }
        // A replaceable item that differs from the waiting one in a transition queues behind it,
        // and is the one later items of its kind may supersede.
        const slot: Slot<A> = { item, at: now, subject, kind, transition, next: undefined };
        if (subject !== undefined && kind !== undefined) {
          const kinds = waiting.get(subject) ?? new Map<string, Slot<A>>();
          kinds.set(kind, slot);
          waiting.set(subject, kinds);
        }
        if (tail === undefined) head = slot;
        else tail.next = slot;
        tail = slot;
        depth += 1;
        Queue.offerUnsafe(queue, slot);
        return observe(now);
      });

    const take = Queue.take(queue).pipe(
      Effect.flatMap((slot) => {
        head = slot.next;
        if (head === undefined) tail = undefined;
        slot.next = undefined;
        depth -= 1;
        if (slot.subject !== undefined && slot.kind !== undefined) {
          const kinds = waiting.get(slot.subject);
          if (kinds?.get(slot.kind) === slot) {
            kinds.delete(slot.kind);
            if (kinds.size === 0) waiting.delete(slot.subject);
          }
        }
        return Effect.flatMap(Clock.currentTimeMillis, observe).pipe(Effect.as(slot.item));
      }),
    );

    return { offer, take, depth: () => depth, gauge };
  });
