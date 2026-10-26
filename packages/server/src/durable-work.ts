// Gram's one shape for work that must survive a quit or a crash: save the intent, perform it, mark
// it done, and on the next start perform whatever is still saved. Each site keeps its own storage
// (an outbox field, a table row); this holds the order and the rules that make it safe.
//
// - The intent is saved before `attempt` is called, with whatever decided it, so a crash after the
//   decision never loses the work.
// - One attempt at a time per key, and the intent is re-read under that key's lock: a retry never
//   races the attempt it retries, and work already done is never done again.
// - `perform` is told when it is a `retry` (after a restart or an interruption), when it may already
//   have happened before the crash; it checks for that and reports the work done without redoing it.
// - The intent is marked done only once `perform` says so. A failure or `undefined` leaves it saved
//   for the next attempt.

import * as Effect from "effect/Effect";
import { makeKeyedLock } from "./git/keyed-lock.ts";

export interface DurableWork<K, I> {
  /**
   * Performs the saved intent at `key`, once: re-read under the key's lock, and skipped when it is
   * no longer owed. The item as it stands after, `undefined` when there is none.
   */
  readonly attempt: (key: K, retry: boolean) => Effect.Effect<I | undefined>;
  /**
   * Attempts each of `keys` as a retry, in order, for start. `settled` hears each item the attempt
   * finished, as it stands after.
   */
  readonly resume: (
    keys: ReadonlyArray<K>,
    settled?: (item: I) => Effect.Effect<void>,
  ) => Effect.Effect<void>;
}

export const makeDurableWork = <K, I, D>(options: {
  /** The lock key for `key`, naming the resource itself. */
  readonly lockKey: (key: K) => string;
  /** The intent at `key` as stored now. */
  readonly read: (key: K) => Effect.Effect<I | undefined>;
  /** Whether `item` still owes its work. */
  readonly owed: (item: I) => boolean;
  /** The work: what came of it, or `undefined` to leave it owed for the next attempt. */
  readonly perform: (item: I, retry: boolean, key: K) => Effect.Effect<D | undefined>;
  /** Records the work done, returning the item as stored after. */
  readonly markDone: (item: I, outcome: D, key: K) => Effect.Effect<I>;
}): DurableWork<K, I> => {
  const locks = makeKeyedLock<string>();
  const attempt = (key: K, retry: boolean): Effect.Effect<I | undefined> =>
    locks.withLock(
      options.lockKey(key),
      Effect.gen(function* () {
        const current = yield* options.read(key);
        if (current === undefined || !options.owed(current)) return current;
        const outcome = yield* options.perform(current, retry, key);
        return outcome === undefined ? current : yield* options.markDone(current, outcome, key);
      }),
    );
  return {
    attempt,
    resume: (keys, settled) =>
      Effect.forEach(
        keys,
        (key) =>
          attempt(key, true).pipe(
            Effect.flatMap((item) =>
              item === undefined || options.owed(item) || settled === undefined
                ? Effect.void
                : settled(item),
            ),
          ),
        { discard: true },
      ),
  };
};
