import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { admit, affordsExtras, GhBudget, paceBackground, type BudgetWindow } from "./budget.ts";

const BASE = Duration.seconds(15);

/** A GraphQL window of 5,000 with `remaining` left, resetting `inSeconds` after time zero. */
const window = (remaining: number, inSeconds = 3600): BudgetWindow => ({
  resource: "graphql",
  limit: 5000,
  remaining,
  used: 5000 - remaining,
  resetAt: inSeconds,
  at: 0,
});

describe("admit", () => {
  it("lets everything through while the allowance is unknown or comfortable", () => {
    expect(admit(undefined, "background", 0)).toEqual({ allowed: true });
    expect(admit(window(4000), "background", 0)).toEqual({ allowed: true });
  });

  it("keeps the last tenth from background work, never from the user", () => {
    expect(admit(window(500), "background", 0)).toMatchObject({
      allowed: false,
      reason: "reserved",
    });
    expect(admit(window(501), "background", 0)).toEqual({ allowed: true });
    expect(admit(window(1), "interactive", 0)).toEqual({ allowed: true });
  });

  it("holds everyone once GitHub is refusing, until the reset it named", () => {
    expect(admit(window(0, 600), "interactive", 0)).toEqual({
      allowed: false,
      reason: "exhausted",
      resetAtMs: 602_000,
    });
    expect(admit(window(0, 600), "interactive", 602_000)).toEqual({ allowed: true });
  });
});

describe("affordsExtras", () => {
  it("drops a bound PR's reviews once a fifth is left, before the reserve holds anything", () => {
    expect(affordsExtras(undefined)).toBe(true);
    expect(affordsExtras(window(1001))).toBe(true);
    expect(affordsExtras(window(1000))).toBe(false);
    expect(admit(window(1000), "background", 0)).toEqual({ allowed: true });
  });
});

/** The background pace, in whole seconds, for `window(remaining, inSeconds)`. */
const seconds = (remaining: number, inSeconds: number, cost = 2) =>
  Math.round(Duration.toSeconds(paceBackground(window(remaining, inSeconds), BASE, cost, 0)));

describe("paceBackground", () => {
  it("never runs faster than the base cadence", () => {
    expect(Duration.toSeconds(paceBackground(undefined, BASE, 2, 0))).toBe(15);
    expect(seconds(5000, 3600)).toBe(15);
    expect(seconds(2500, 3600)).toBe(15);
  });

  it("stretches smoothly as what is spendable shrinks", () => {
    // 200 spendable over 20 minutes, half of it for polling: a 2-point sweep every 24 s.
    expect(seconds(700, 1200)).toBe(24);
    expect(seconds(520, 1200)).toBe(240);
    // The same shortfall matters less with the reset close.
    expect(seconds(520, 60)).toBe(15);
  });

  it("waits for the reset once only the reserve is left", () => {
    expect(seconds(500, 1200)).toBe(1202);
    expect(seconds(0, 1200)).toBe(1202);
  });

  it("forgets a window that has reset", () => {
    expect(Duration.toSeconds(paceBackground(window(0, 600), BASE, 2, 700_000))).toBe(15);
  });
});

const reading = (remaining: number, resetAt: number) => ({
  resource: "graphql",
  limit: 5000,
  remaining,
  used: 5000 - remaining,
  resetAt,
});

describe("GhBudget", () => {
  it.effect("keeps the later reading of a window when responses land out of order", () =>
    Effect.gen(function* () {
      const budget = yield* GhBudget;
      yield* budget.observe(reading(4000, 3600));
      yield* budget.observe(reading(4010, 3600));
      expect((yield* budget.window("graphql"))?.remaining).toBe(4000);
      // A new window starts full again.
      yield* budget.observe(reading(4990, 7200));
      expect((yield* budget.window("graphql"))?.remaining).toBe(4990);
    }).pipe(Effect.provide(GhBudget.layer)),
  );

  it.effect("meters each allowance on its own, and drops a window at its reset", () =>
    Effect.gen(function* () {
      const budget = yield* GhBudget;
      yield* budget.observe(reading(0, 600));
      expect((yield* budget.admit("graphql", "interactive")).allowed).toBe(false);
      expect((yield* budget.admit("core", "background")).allowed).toBe(true);

      yield* TestClock.adjust(Duration.seconds(603));
      expect(yield* budget.window("graphql")).toBeUndefined();
      expect((yield* budget.admit("graphql", "background")).allowed).toBe(true);
    }).pipe(Effect.provide(GhBudget.layer)),
  );
});
