// The app's share of GitHub's hourly allowances, kept from what GitHub's own response headers say.
//
// The token is shared: agents in the app's terminals, other sessions and the user's own shell all run
// `gh` against the same 5,000 an hour, and none of that is visible here except as `remaining` falling
// faster than this app spent it. So the policy is about what is left, never about what we spent:
//
//   - a tenth of every allowance is never touched by anything the app does on its own;
//   - background polling plans to use at most half of what is spendable before the reset, and slows
//     down as that shrinks rather than running dry and stopping;
//   - once GitHub has refused, nothing asks again until the reset time it gave: GitHub's guidance is
//     that an integration which keeps requesting while limited may be banned, and the answer is known.
//
// What the user asks for by hand is only ever held back by the last of these.

import type { RateLimitReading } from "@gram/git";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** The share of every allowance the app leaves for whatever else uses the token. */
const RESERVE_FRACTION = 0.1;

/**
 * The share of an allowance below which background polling stops asking for what only a wake needs
 * beyond the badge, a bound PR's reviews: that goes first, so the badges and CI last longer.
 */
const EXTRAS_FRACTION = 2 * RESERVE_FRACTION;

/** The share of what is spendable before the reset that background polling plans to use. */
const BACKGROUND_SHARE = 0.5;

/** How long after the reset time to wait before asking again: GitHub's clock isn't ours. */
const RESET_SLACK_MS = 2_000;

/** How often an unchanged allowance is written to the log. */
const LOG_EVERY_MS = 10 * 60_000;

/**
 * Who a `gh` run is for. `interactive` is the default, so anything not marked is treated as the user
 * waiting on it; pollers mark themselves `background` with `asBackground`.
 */
export type GhPriority = "interactive" | "background";

export const GhPriority = Context.Reference<GhPriority>("@gram/server/GhPriority", {
  defaultValue: () => "interactive",
});

/** Runs `effect` as background work: held to the reserve, and paced. */
export const asBackground = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provideService(effect, GhPriority, "background");

export type Admission =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      /** `exhausted`: GitHub is refusing. `reserved`: what is left is being kept for other tools. */
      readonly reason: "exhausted" | "reserved";
      /** Epoch milliseconds at which the allowance resets. */
      readonly resetAtMs: number;
    };

export interface BudgetWindow extends RateLimitReading {
  /** Epoch milliseconds the reading was taken at. */
  readonly at: number;
}

const reserveOf = (window: BudgetWindow): number => Math.ceil(window.limit * RESERVE_FRACTION);

/** Whether a run at `priority` may spend from `window` at `now`; pure, for the policy's tests. */
export const admit = (
  window: BudgetWindow | undefined,
  priority: GhPriority,
  now: number,
): Admission => {
  if (window === undefined) return { allowed: true };
  const resetAtMs = window.resetAt * 1000 + RESET_SLACK_MS;
  if (now >= resetAtMs) return { allowed: true };
  if (window.remaining <= 0) return { allowed: false, reason: "exhausted", resetAtMs };
  if (priority === "background" && window.remaining <= reserveOf(window)) {
    return { allowed: false, reason: "reserved", resetAtMs };
  }
  return { allowed: true };
};

/** Whether polling may still ask for its extras from `window` (`EXTRAS_FRACTION`); pure. */
export const affordsExtras = (window: BudgetWindow | undefined): boolean =>
  window === undefined || window.remaining > Math.ceil(window.limit * EXTRAS_FRACTION);

/**
 * How long a background poll costing about `cost` should wait before its next pass, given a `base`
 * cadence it never runs faster than. Spreads half of what is spendable over the time to the reset, so
 * a draining allowance stretches the wait smoothly; with nothing spendable the wait is to the reset.
 */
export const paceBackground = (
  window: BudgetWindow | undefined,
  base: Duration.Duration,
  cost: number,
  now: number,
): Duration.Duration => {
  if (window === undefined) return base;
  const untilResetMs = window.resetAt * 1000 + RESET_SLACK_MS - now;
  if (untilResetMs <= 0) return base;
  const spendable = window.remaining - reserveOf(window);
  if (spendable <= 0) return Duration.max(base, Duration.millis(untilResetMs));
  const paced = (Math.max(1, cost) * untilResetMs) / (spendable * BACKGROUND_SHARE);
  return Duration.max(base, Duration.millis(Math.min(paced, untilResetMs)));
};

/** Which tenth of the allowance is left: a line is logged as each is crossed. */
const bandOf = (window: BudgetWindow) =>
  window.limit <= 0 ? 0 : Math.floor((window.remaining / window.limit) * 10);

export class GhBudget extends Context.Service<
  GhBudget,
  {
    /** Records what a response's headers said. An older reading of a window never replaces a newer. */
    readonly observe: (reading: RateLimitReading) => Effect.Effect<void>;
    /** The allowance as last reported, or `undefined` when unknown or past its reset. */
    readonly window: (resource: string) => Effect.Effect<BudgetWindow | undefined>;
    /**
     * Holds every allowance for `seconds`: GitHub's secondary limiter answered, and it punishes the
     * request rate as a whole, not one allowance.
     */
    readonly hold: (seconds: number) => Effect.Effect<void>;
    readonly admit: (resource: string, priority: GhPriority) => Effect.Effect<Admission>;
    readonly paceBackground: (
      resource: string,
      base: Duration.Duration,
      cost: number,
    ) => Effect.Effect<Duration.Duration>;
  }
>()("@gram/server/GhBudget") {
  static readonly layer = Layer.sync(GhBudget, () => {
    const windows = new Map<string, BudgetWindow>();
    const logged = new Map<string, { readonly at: number; readonly band: number }>();
    let heldUntilMs = 0;

    const current = (resource: string, now: number): BudgetWindow | undefined => {
      const window = windows.get(resource);
      if (window === undefined) return undefined;
      if (now < window.resetAt * 1000 + RESET_SLACK_MS) return window;
      windows.delete(resource);
      return undefined;
    };

    return {
      observe: (reading) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const previous = windows.get(reading.resource);
          // Responses land out of order: within one window, the lower `remaining` is the later one.
          if (
            previous !== undefined &&
            previous.resetAt === reading.resetAt &&
            previous.remaining < reading.remaining
          ) {
            return;
          }
          const window: BudgetWindow = { ...reading, at: now };
          windows.set(reading.resource, window);
          const last = logged.get(reading.resource);
          const band = bandOf(window);
          if (last !== undefined && last.band === band && now - last.at < LOG_EVERY_MS) return;
          logged.set(reading.resource, { at: now, band });
          yield* Effect.logInfo("github allowance").pipe(
            Effect.annotateLogs({
              resource: reading.resource,
              remaining: reading.remaining,
              limit: reading.limit,
              resetInSeconds: Math.max(0, Math.round(reading.resetAt - now / 1000)),
            }),
          );
        }),
      window: (resource) => Effect.map(Clock.currentTimeMillis, (now) => current(resource, now)),
      hold: (seconds) =>
        Effect.map(Clock.currentTimeMillis, (now) => {
          heldUntilMs = Math.max(heldUntilMs, now + Math.max(1, seconds) * 1000);
        }),
      admit: (resource, priority) =>
        Effect.map(Clock.currentTimeMillis, (now) =>
          now < heldUntilMs
            ? { allowed: false, reason: "exhausted", resetAtMs: heldUntilMs }
            : admit(current(resource, now), priority, now),
        ),
      paceBackground: (resource, base, cost) =>
        Effect.map(Clock.currentTimeMillis, (now) =>
          paceBackground(current(resource, now), base, cost, now),
        ),
    };
  });
}
