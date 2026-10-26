// The recurring-poll side of the rate-limit policy: how long until the next pass, given how many
// passes in a row GitHub refused and how much quota is left. `@gram/git`'s `backoffDelayMs`
// owns the ramp itself; this owns the per-loop counter, the pre-emptive slowdown and the logging.

import { backoffDelayMs, type RateLimitSignal } from "@gram/git";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

/** What one poll's worth of quota headroom does to the cadence. */
const QUOTA_LOW_FRACTION = 0.25;
const QUOTA_CRITICAL_FRACTION = 0.1;
export const QUOTA_LOW_MULTIPLIER = 4;
export const QUOTA_CRITICAL_MULTIPLIER = 8;

/** Slowdown while the app is on screen but not in the foreground. */
export const IDLE_MULTIPLIER = 4;

/**
 * Slowdown while no window is showing, when only threads with a watch on are polled: three minutes
 * at the default 15 s sweep. A branch's PR lookup costs about six GraphQL points, so a watched thread
 * spends some 120 of the hour's 5,000 here, against 1,440 at the base cadence.
 */
export const HIDDEN_MULTIPLIER = 12;

/** How much an app at `level` stretches the base cadence. */
export const activityMultiplier = (level: "active" | "idle" | "hidden" | "paused"): number =>
  level === "idle" ? IDLE_MULTIPLIER : level === "hidden" ? HIDDEN_MULTIPLIER : 1;

/**
 * Sweeps per PR lookup for a watched thread whose chips are off screen while a window at `level` is
 * showing, so it is asked about at the hidden cadence rather than the badge one. Counted in sweeps,
 * not seconds, so quota thinning and a rate-limit backoff stretch it as they stretch the sweep.
 */
export const offScreenWatchSweeps = (level: "active" | "idle" | "hidden" | "paused"): number =>
  Math.max(1, Math.ceil(HIDDEN_MULTIPLIER / activityMultiplier(level)));

/**
 * How much to stretch the base cadence for a poll with `headroom` (in [0, 1]) of its tightest quota
 * left. Below a tenth of the hourly allowance the cadence is cut hard: at 15 s a sweep this is the
 * difference between running out in minutes and lasting the hour.
 */
export const quotaMultiplier = (headroom: number): number => {
  if (headroom <= QUOTA_CRITICAL_FRACTION) return QUOTA_CRITICAL_MULTIPLIER;
  if (headroom <= QUOTA_LOW_FRACTION) return QUOTA_LOW_MULTIPLIER;
  return 1;
};

export interface PollBackoffShape {
  /** Records that the pass just finished was rate-limited, and returns how long to wait. */
  readonly limited: (signal: RateLimitSignal | undefined) => Effect.Effect<Duration.Duration>;
  /** Records a clean pass; returns the base cadence, stretched by `multiplier`. */
  readonly recovered: (multiplier: number) => Effect.Effect<Duration.Duration>;
  /** Passes in a row GitHub refused; 0 while healthy. */
  readonly consecutive: Effect.Effect<number>;
}

/**
 * A backoff counter for one recurring poll. `name` identifies the loop in the log — the two loops
 * hit different GitHub limits (GraphQL points, the much stricter search limit) and must ramp
 * independently, so they never share one of these.
 */
export const makePollBackoff = (
  name: string,
  base: Duration.Duration,
  options: { readonly jitter?: () => number } = {},
): Effect.Effect<PollBackoffShape> =>
  Effect.sync(() => {
    const jitter = options.jitter ?? Math.random;
    let consecutive = 0;
    return {
      limited: (signal) =>
        Effect.suspend(() => {
          consecutive += 1;
          // Never below the base cadence: the ramp starts at a minute, and a poll that normally
          // runs every five would otherwise speed up on being refused.
          const delay = Math.max(
            Duration.toMillis(base),
            backoffDelayMs(consecutive, {
              ...(signal === undefined ? {} : { signal }),
              jitter: jitter(),
            }),
          );
          return Effect.logWarning("github rate-limited a poll; backing off").pipe(
            Effect.annotateLogs({
              poll: name,
              consecutive,
              kind: signal?.kind ?? "unknown",
              retryInMs: delay,
            }),
            Effect.as(Duration.millis(delay)),
          );
        }),
      recovered: (multiplier) =>
        Effect.suspend(() => {
          const recovering = consecutive > 0;
          consecutive = 0;
          const delay = Duration.times(base, Math.max(1, multiplier));
          return (
            recovering
              ? Effect.logInfo("github poll recovered; back to the normal cadence").pipe(
                  Effect.annotateLogs({ poll: name }),
                )
              : Effect.void
          ).pipe(Effect.as(delay));
        }),
      consecutive: Effect.sync(() => consecutive),
    };
  });
