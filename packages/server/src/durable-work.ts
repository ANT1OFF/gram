import * as Effect from "effect/Effect";
import { makeKeyedLock } from "./git/keyed-lock.ts";
import { asRecorded, type RecordedActor } from "./host/ownership.ts";

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
  /** Who `item` is for, as it was saved with it (`recordActor`); absent for the server's own. */
  readonly actor: (item: I, key: K) => Effect.Effect<RecordedActor | undefined>;
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
        const actor = yield* options.actor(current, key);
        const outcome = yield* asRecorded(actor)(options.perform(current, retry, key));
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
