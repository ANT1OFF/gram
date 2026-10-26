// A TTL + in-flight cache for the GitHub polls on the hot path. The badge sweep and the review
// reads are the two calls that run per checkout per tick, so they are the two that get one.

import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

/**
 * How long a GitHub poll answer is reused. Deliberately under the badge sweep interval, so a
 * scheduled poll always reaches GitHub and no badge can freeze; long enough to collapse the burst
 * of extra lookups one user action or one agent turn fans out. A caller sweeping faster than this
 * sets `PrBadgeTtlMs` lower.
 */
export const PR_POLL_TTL_MS = 10_000;

export interface TtlCacheSpec<I, A, E, R> {
  /**
   * The cache key for `input`. Include every input the answer depends on, and the head SHA or
   * branch tip where one is known: a changed tip must be a new key, never a warm hit.
   */
  readonly key: (input: I) => string;
  readonly fetch: (input: I) => Effect.Effect<A, E, R>;
  readonly ttlMs?: number;
  /** Which successful answers are worth keeping. Every one, by default. */
  readonly keep?: (value: A) => boolean;
  /**
   * Whether the answer kept for `cached` may stand in for `input`, which has its key. Always, by
   * default. For what two inputs of one key can know differently, such as the state a caller has
   * seen the PR in: a refusal fetches again and the new answer takes the entry's place, so the key
   * stays one entry that every caller shares rather than one per thing known. A fetch in flight is
   * held to the same question, by the input that started it.
   */
  readonly reusable?: (input: I, cached: I) => boolean;
}

export interface TtlCache<I, A, E, R> {
  readonly get: (input: I) => Effect.Effect<A, E, R>;
  /** Drops every entry, for a write that invalidates whatever was read before it. */
  readonly clear: () => void;
}

/**
 * Wraps `fetch` so repeated lookups of one key within `ttlMs` reuse its answer, and callers arriving
 * while a key is in flight await that one call instead of starting their own.
 *
 * Failures are never kept: the shared attempt fails for everyone waiting on it and the next caller
 * retries, so a rate-limited minute can't be baked in for the rest of the TTL.
 */
export const makeTtlCache = <I, A, E, R>(spec: TtlCacheSpec<I, A, E, R>): TtlCache<I, A, E, R> => {
  const { key, fetch, ttlMs = PR_POLL_TTL_MS, keep, reusable } = spec;
  const entries = new Map<string, { readonly at: number; readonly value: A; readonly input: I }>();
  /**
   * A key's running fetch. `superseded` once an input that couldn't share it started its own: it
   * still answers whoever is waiting on it, but no longer writes the entry.
   */
  interface Flight {
    readonly deferred: Deferred.Deferred<A, E>;
    readonly input: I;
    superseded: boolean;
  }
  const inFlight = new Map<string, Flight>();
  const canReuse = (input: I, cached: I) => reusable === undefined || reusable(input, cached);
  /** Bumped by `clear`, so a fetch that began before it can't write its answer back afterwards. */
  let generation = 0;

  // Evicting, reading and claiming happen in one synchronous block: an `await` between them would
  // let a second fiber claim the same key and start a second fetch, which is the whole point.
  type Claim =
    | { readonly kind: "hit"; readonly value: A }
    | { readonly kind: "await"; readonly deferred: Deferred.Deferred<A, E> }
    | { readonly kind: "own"; readonly flight: Flight; readonly at: number };

  const claimUnsafe = (id: string, input: I, now: number): Claim => {
    for (const [other, entry] of entries) {
      if (now - entry.at >= ttlMs) entries.delete(other);
    }
    const hit = entries.get(id);
    if (hit !== undefined && canReuse(input, hit.input)) return { kind: "hit", value: hit.value };
    const pending = inFlight.get(id);
    if (pending !== undefined) {
      if (canReuse(input, pending.input)) return { kind: "await", deferred: pending.deferred };
      // Joining it would hand this caller an answer to a question it has just refused.
      pending.superseded = true;
    }
    const flight: Flight = { deferred: Deferred.makeUnsafe<A, E>(), input, superseded: false };
    inFlight.set(id, flight);
    return { kind: "own", flight, at: generation };
  };

  const get = (input: I): Effect.Effect<A, E, R> =>
    Effect.gen(function* () {
      const id = key(input);
      const claim = claimUnsafe(id, input, yield* Clock.currentTimeMillis);
      if (claim.kind === "hit") return claim.value;
      if (claim.kind === "await") return yield* Deferred.await(claim.deferred);

      const { flight } = claim;
      const value = yield* fetch(input).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (inFlight.get(id) === flight) inFlight.delete(id);
          }).pipe(Effect.andThen(Deferred.done(flight.deferred, exit))),
        ),
      );
      if (!flight.superseded && claim.at === generation && (keep === undefined || keep(value))) {
        entries.set(id, { at: yield* Clock.currentTimeMillis, value, input });
      }
      return value;
    });

  return {
    get,
    clear: () => {
      generation++;
      entries.clear();
      inFlight.clear();
    },
  };
};

const badgeCaches = new Set<{ readonly clear: () => void }>();

/** Puts a PR badge cache under `invalidatePrBadges`; the returned function takes it out again. */
export const trackBadgeCache = (cache: { readonly clear: () => void }): (() => void) => {
  badgeCaches.add(cache);
  return () => void badgeCaches.delete(cache);
};

/**
 * Drops every cached PR badge. Call after any write that changes what a badge lookup would return:
 * opening a PR moves no branch tip, so its key would otherwise keep answering "no PR" until the TTL
 * lapses. The writes in this package already do.
 */
export const invalidatePrBadges = (): void => {
  for (const cache of badgeCaches) cache.clear();
};
