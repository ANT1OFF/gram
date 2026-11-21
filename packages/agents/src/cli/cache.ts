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
 * Runs of a command shared by key: an ask made while one runs waits for it, and its result answers
 * every ask of the same key for `reuseMs` after, so a burst of asks (a machine's status check and
 * a session opening at once) runs it once. Only a result `keep` accepts is reused; a failure, or
 * a result a later ask must see fresh, never is. `reset` drops every kept result.
 */
export const sharedRuns = <A, E>(
  reuseMs: number,
  keep: (result: A) => boolean,
  now: () => number = Date.now,
): Effect.Effect<{
  readonly run: (key: string, effect: Effect.Effect<A, E>) => Effect.Effect<A, E>;
  readonly reset: Effect.Effect<void>;
}> =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1);
    const kept = new Map<string, { readonly at: number; readonly result: A }>();
    return {
      run: (key, effect) =>
        lock.withPermits(1)(
          Effect.suspend(() => {
            const at = now();
            for (const [old, entry] of kept) if (at - entry.at >= reuseMs) kept.delete(old);
            const found = kept.get(key);
            if (found !== undefined) return Effect.succeed(found.result);
            return effect.pipe(
              Effect.tap((result) =>
                Effect.sync(() => {
                  if (keep(result)) kept.set(key, { at: now(), result });
                }),
              ),
            );
          }),
        ),
      reset: lock.withPermits(1)(Effect.sync(() => kept.clear())),
    };
  });
