import { describe, expect, it } from "vitest";
import {
  ASK_WINDOW_MS,
  ASKS_PER_WINDOW,
  ASKS_WAITING_MOST,
  ASKS_WAITING_PER_THREAD,
  makeAskLimits,
  REFUSALS_IN_A_ROW,
} from "./limits.ts";

const limits = (paused = false) => {
  const clock = { now: 1_800_000_000_000 };
  let pauses = 0;
  const made = makeAskLimits(
    () => clock.now,
    { paused },
    () => {
      pauses += 1;
    },
  );
  return { clock, limits: made, pauses: () => pauses };
};

describe("how much a server may ask", () => {
  it("lets three asks wait per thread and eight in all", () => {
    const { limits: asks } = limits();
    for (let index = 0; index < ASKS_WAITING_PER_THREAD; index += 1)
      expect(asks.admit("t1")).toBe("ok");
    expect(asks.admit("t1")).toBe("too-many-requests");
    expect(asks.admit("t2")).toBe("ok");
    asks.settled("t1", "allowed");
    expect(asks.admit("t1")).toBe("ok");
    for (const thread of ["t3", "t4", "t5", "t6"]) expect(asks.admit(thread)).toBe("ok");
    expect(asks.waiting()).toBe(ASKS_WAITING_MOST);
    expect(asks.admit("t7")).toBe("too-many-requests");
  });

  it("counts asks per server whatever threads they name, and forgets them after ten minutes", () => {
    const { limits: asks, clock } = limits();
    for (let index = 0; index < ASKS_PER_WINDOW; index += 1) {
      expect(asks.admit(`t${index}`)).toBe("ok");
      asks.settled(`t${index}`, "allowed");
      clock.now += 1000;
    }
    expect(asks.admit("another")).toBe("too-many-requests");
    expect(asks.refusedUnasked()).toBe("too-many-requests");
    clock.now += ASK_WINDOW_MS - ASKS_PER_WINDOW * 1000 + 1;
    expect(asks.admit("another")).toBe("ok");
  });

  it("counts requests refused for their path against the same allowance", () => {
    const { limits: asks } = limits();
    for (let index = 0; index < ASKS_PER_WINDOW; index += 1)
      expect(asks.refusedUnasked()).toBe("ok");
    expect(asks.refusedUnasked()).toBe("too-many-requests");
    expect(asks.admit("t1")).toBe("too-many-requests");
  });

  it("pauses after three in a row refused or unanswered, until the pause is lifted", () => {
    const { limits: asks, pauses } = limits();
    for (const outcome of ["refused", "unanswered", "allowed", "refused", "unanswered"] as const) {
      expect(asks.admit("t1")).toBe("ok");
      asks.settled("t1", outcome);
    }
    expect(asks.paused()).toBe(false);
    expect(asks.admit("t1")).toBe("ok");
    asks.settled("t1", "refused");
    expect(asks.paused()).toBe(true);
    expect(pauses()).toBe(1);
    expect(asks.admit("t1")).toBe("paused");
    expect(asks.refusedUnasked()).toBe("paused");
    asks.lift();
    expect(asks.admit("t1")).toBe("ok");
    // The count starts again: one more refusal isn't three.
    asks.settled("t1", "refused");
    expect(asks.paused()).toBe(false);
  });

  it("doesn't hold a withdrawn ask against the person, or for them", () => {
    const { limits: asks } = limits();
    for (let index = 0; index < REFUSALS_IN_A_ROW - 1; index += 1) {
      asks.admit("t1");
      asks.settled("t1", "refused");
    }
    for (let index = 0; index < 5; index += 1) {
      asks.admit("t1");
      asks.settled("t1", "withdrawn");
    }
    expect(asks.paused()).toBe(false);
    asks.admit("t1");
    asks.settled("t1", "unanswered");
    expect(asks.paused()).toBe(true);
  });

  it("starts paused when it was left paused", () => {
    const { limits: asks } = limits(true);
    expect(asks.admit("t1")).toBe("paused");
  });
});
