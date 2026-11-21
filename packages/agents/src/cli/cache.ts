import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

/**
 * Cache only successful results, so a missing CLI can be retried without restarting Gram.
 * Serialize discovery and reset: an in-flight read finishes before its cached value is dropped.
 */
export const resettableOnSuccess = <A, E>(
  effect: Effect.Effect<A, E>,
): Effect.Effect<{
  readonly get: Effect.Effect<A, E>;
  readonly reset: Effect.Effect<void>;
}> =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1);
    let value: { readonly ok: A } | undefined;
    return {
      get: lock.withPermits(1)(
        Effect.suspend(() =>
          value !== undefined
            ? Effect.succeed(value.ok)
            : effect.pipe(Effect.tap((ok) => Effect.sync(() => void (value = { ok })))),
        ),
      ),
      // Under the lock, so a read under way finishes first and its value is the one dropped.
      reset: lock.withPermits(1)(
        Effect.sync(() => {
          value = undefined;
        }),
      ),
    };
  });

/**
 * Runs shared by key while they run: an ask made while one with its key runs waits for that run's
 * result (success, failure or interruption), so a burst of asks (a machine's status check, a
 * session's sign-in and account) runs it once. A finished run is never reused: the next ask runs
 * afresh.
 */
export const sharedWhileRunning = <A, E>(): {
  readonly run: (key: string, effect: Effect.Effect<A, E>) => Effect.Effect<A, E>;
} => {
  const running = new Map<string, Deferred.Deferred<A, E>>();
  return {
    run: (key, effect) =>
      Effect.suspend(() => {
        const joined = running.get(key);
        if (joined !== undefined) return Deferred.await(joined);
        const deferred = Deferred.makeUnsafe<A, E>();
        running.set(key, deferred);
        return effect.pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => running.delete(key)).pipe(
              Effect.andThen(Deferred.done(deferred, exit)),
            ),
          ),
        );
      }),
  };
};
