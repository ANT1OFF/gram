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
