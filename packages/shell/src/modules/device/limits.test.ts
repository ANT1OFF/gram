import { describe, expect, it } from "vitest";
import {
  type Admitted,
  ASK_WINDOW_MS,
  ASKS_PER_WINDOW,
  ASKS_WAITING_MOST,
  ASKS_WAITING_PER_THREAD,
  type AskLimits,
  type AskOutcome,
  makeAskLimits,
  REFUSALS_IN_A_ROW,
} from "./limits.ts";

const limits = (paused = false) => {
  const clock = { now: 1_000_000 };
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

const admitted = (asks: AskLimits, thread: string): Admitted => {
  const answer = asks.admit(thread);
  if (typeof answer === "string") throw new Error(`not admitted: ${answer}`);
  return answer;
};

const ask = (asks: AskLimits, thread: string, outcome: AskOutcome) =>
  admitted(asks, thread).settle(outcome);

describe("how much a server may ask", () => {
  it("lets three asks wait per thread and eight in all", () => {
    const { limits: asks } = limits();
    const first = admitted(asks, "t1");
    for (let index = 1; index < ASKS_WAITING_PER_THREAD; index += 1) admitted(asks, "t1");
    expect(asks.admit("t1")).toBe("too-many-requests");
    admitted(asks, "t2");
    first.settle("allowed");
    admitted(asks, "t1");
    for (const thread of ["t3", "t4", "t5", "t6"]) admitted(asks, thread);
    expect(asks.waiting()).toBe(ASKS_WAITING_MOST);
    expect(asks.admit("t7")).toBe("too-many-requests");
  });

  it("counts an answer once, whatever is called after", () => {
    const { limits: asks } = limits();
    const first = admitted(asks, "t1");
    admitted(asks, "t1");
    admitted(asks, "t1");
    first.settle("allowed");
    first.settle("allowed");
    first.settle("refused");
    expect(asks.waiting()).toBe(2);
    admitted(asks, "t1");
    expect(asks.admit("t1")).toBe("too-many-requests");
    expect(asks.paused()).toBe(false);
  });

  it("counts asks per server whatever threads they name, and forgets them after ten minutes", () => {
    const { limits: asks, clock } = limits();
    for (let index = 0; index < ASKS_PER_WINDOW; index += 1) {
      ask(asks, `t${index}`, "allowed");
      clock.now += 1000;
    }
    expect(asks.admit("another")).toBe("too-many-requests");
    expect(asks.refusedUnasked()).toBe("too-many-requests");
    clock.now += ASK_WINDOW_MS - ASKS_PER_WINDOW * 1000 - 1;
    expect(asks.admit("another")).toBe("too-many-requests");
    clock.now += 1;
    expect(typeof asks.admit("another")).toBe("object");
  });

  it("counts requests refused for their path against the same allowance", () => {
    const { limits: asks } = limits();
    for (let index = 0; index < ASKS_PER_WINDOW; index += 1)
      expect(asks.refusedUnasked()).toBe("ok");
    expect(asks.refusedUnasked()).toBe("too-many-requests");
    expect(asks.admit("t1")).toBe("too-many-requests");
  });

  it("pauses once after three in a row refused, unanswered or withdrawn, until lifted", () => {
    const { limits: asks, pauses } = limits();
    for (const outcome of ["refused", "unanswered", "allowed", "withdrawn", "refused"] as const)
      ask(asks, "t1", outcome);
    expect(asks.paused()).toBe(false);
    ask(asks, "t1", "unanswered");
    expect(asks.paused()).toBe(true);
    expect(pauses()).toBe(1);
    expect(asks.admit("t1")).toBe("paused");
    expect(asks.refusedUnasked()).toBe("paused");
    asks.lift();
    // The count starts again: one more refusal isn't three.
    ask(asks, "t1", "refused");
    expect(asks.paused()).toBe(false);
  });

  it("pauses a server that takes back every ask just before it would time out", () => {
    const { limits: asks, clock } = limits();
    for (let index = 0; index < REFUSALS_IN_A_ROW; index += 1) {
      const waiting = admitted(asks, `t${index}`);
      clock.now += 4 * 60_000 + 59_000;
      waiting.settle("withdrawn");
    }
    expect(asks.paused()).toBe(true);
  });

  it("doesn't hold an ask stopped by the device against the server, or for it", () => {
    const { limits: asks } = limits();
    for (let index = 0; index < REFUSALS_IN_A_ROW - 1; index += 1) ask(asks, "t1", "refused");
    for (let index = 0; index < 5; index += 1) ask(asks, "t1", "stopped");
    expect(asks.paused()).toBe(false);
    ask(asks, "t1", "unanswered");
    expect(asks.paused()).toBe(true);
  });

  it("starts paused when it was left paused", () => {
    const { limits: asks } = limits(true);
    expect(asks.admit("t1")).toBe("paused");
  });
});
