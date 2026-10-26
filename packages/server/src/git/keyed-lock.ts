// Gram's locks keyed by the resource they guard (lint: `gram/no-adhoc-lock`): a workspace, a repo
// and base branch, a checkout, never a thread standing in for one. `makeKeyedLock` holds one permit
// per key; `makeAdmission` lets a capped number of jobs run at once, in arrival order.

import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

export interface KeyedLock<K> {
  /** Runs `effect` holding `key`'s permit, after whoever holds it or waited for it first. */
  readonly withLock: <A, E, R>(key: K, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /**
   * Runs `effect` holding every key in `keys`, each once, taken in sorted order: two callers that
   * hold more than one key never wait on each other.
   */
  readonly withLocks: <A, E, R>(
    keys: Iterable<K>,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  /** How many keys are held or waited on, which is all the lock keeps. */
  readonly size: () => number;
}

/**
 * One permit per key, kept only while somebody holds or waits for it: a thread's lock used to
 * outlive the thread for the server's lifetime. Counted in and out uninterruptibly, so an
 * interrupted waiter never leaves a key behind, nor drops one another caller still holds, which
 * would let two run under the same key.
 */
export const makeKeyedLock = <K>(): KeyedLock<K> => {
  const entries = new Map<K, { readonly lock: Semaphore.Semaphore; users: number }>();
  const withLock: KeyedLock<K>["withLock"] = (key, effect) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        let entry = entries.get(key);
        if (entry === undefined) {
          entry = { lock: Semaphore.makeUnsafe(1), users: 0 };
          entries.set(key, entry);
        }
        entry.users++;
        return entry;
      }),
      (entry) => entry.lock.withPermits(1)(effect),
      (entry) =>
        Effect.sync(() => {
          entry.users--;
          if (entry.users === 0 && entries.get(key) === entry) entries.delete(key);
        }),
    );
  return {
    withLock,
    withLocks: (keys, effect) =>
      [...new Set(keys)]
        .toSorted((a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0))
        .reduceRight((inner, key) => withLock(key, inner), effect),
    size: () => entries.size,
  };
};

export interface Admission<K> {
  /**
   * Runs `effect` once one of the `capacity` slots is free, after everything that queued before it.
   * Interrupted while it waits, it leaves the queue; interrupted once admitted, its slot goes on.
   */
  readonly inTurn: <A, E, R>(key: K, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /**
   * Takes a slot now, whatever the cap, for work already under way, and gives back `effect` freeing
   * it as it ends: the slot counts from this call, not from when the job is forked and starts.
   */
  readonly takeSlot: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<Effect.Effect<A, E, R>>;
  /** How many slots are taken. */
  readonly active: () => number;
}

/**
 * A FIFO cap on jobs at once, read from `capacity` each time a slot frees (a setting can change).
 * `onQueue` hears the keys still waiting, front first, whenever the line moves. The slot is taken
 * and given back uninterruptibly around the job, so neither an interrupted waiter nor a job
 * interrupted just as it was admitted can keep a slot.
 */
export const makeAdmission = <K>(
  capacity: Effect.Effect<number>,
  onQueue: (waiting: ReadonlyArray<K>) => void = () => {},
): Admission<K> => {
  let active = 0;
  const queue: Array<{ readonly key: K; readonly go: Deferred.Deferred<void> }> = [];
  const admitNext = Effect.gen(function* () {
    const room = yield* capacity;
    while (active < room && queue.length > 0) {
      const next = queue.shift()!;
      active++;
      yield* Deferred.succeed(next.go, undefined);
    }
    onQueue(queue.map((entry) => entry.key));
  });
  const leave = Effect.suspend(() => {
    active--;
    return admitNext;
  });
  return {
    inTurn: (key, effect) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const entry = { key, go: yield* Deferred.make<void>() };
          queue.push(entry);
          yield* admitNext;
          yield* restore(Deferred.await(entry.go)).pipe(
            Effect.onInterrupt(() =>
              Effect.suspend(() => {
                const at = queue.indexOf(entry);
                if (at === -1) return leave;
                queue.splice(at, 1);
                return admitNext;
              }),
            ),
          );
          return yield* restore(effect).pipe(Effect.ensuring(leave));
        }),
      ),
    takeSlot: (effect) =>
      Effect.sync(() => {
        active++;
        return effect.pipe(Effect.ensuring(leave));
      }),
    active: () => active,
  };
};
