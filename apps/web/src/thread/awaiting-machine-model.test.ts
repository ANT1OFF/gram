import { describe, expect, it } from "vitest";

import {
  elapsedClock,
  failureSentence,
  machineWait,
  startingHint,
  waitsWords,
  WAIT_WORDS,
} from "./awaiting-machine-model";

const failed = (at: number) => ({
  createdAt: 1_000,
  awaitingMachine: { since: 1_000, failed: { at, message: "No." } },
});

describe("a thread's wait for its machine", () => {
  it("is none for a thread that doesn't wait", () => {
    expect(machineWait({ createdAt: 1_000 })).toBeUndefined();
  });

  it("is starting from the thread's own start", () => {
    // The wait is stamped a moment before the thread is.
    expect(machineWait({ createdAt: 1_005, awaitingMachine: { since: 1_000 } })).toEqual({
      state: "starting",
      since: 1_000,
    });
  });

  it("is starting again once the wait was begun again, counted from the new try", () => {
    expect(machineWait({ createdAt: 1_000, awaitingMachine: { since: 400_000 } })).toEqual({
      state: "again",
      since: 400_000,
    });
  });

  it("has failed in the platform's own sentence", () => {
    expect(
      machineWait({
        createdAt: 1_000,
        awaitingMachine: {
          since: 1_000,
          failed: { at: 9_000, message: "The machine couldn't be started: no capacity." },
        },
      }),
    ).toEqual({
      state: "failed",
      since: 1_000,
      sentence: "The machine couldn't be started: no capacity.",
    });
  });

  it("reads as starting again after the person asked, until a newer failure", () => {
    const asked = { at: 12_000, after: 9_000 };
    expect(machineWait(failed(9_000), asked)).toEqual({ state: "again", since: 12_000 });
    // The new try failed too: its failure is said, not the try.
    expect(machineWait(failed(20_000), asked)?.state).toBe("failed");
    // The server began the wait again: its own time stands.
    expect(machineWait({ createdAt: 1_000, awaitingMachine: { since: 12_500 } }, asked)).toEqual({
      state: "again",
      since: 12_500,
    });
  });
});

describe("the failure's sentence", () => {
  it("keeps the first sentence of the server's own, whose tail the next line says", () => {
    expect(
      failureSentence(
        "No machine started for this thread. What you sent is kept, and goes once one has.",
      ),
    ).toBe(WAIT_WORDS.failed);
  });

  it("leaves another sentence whole, and falls back when there is none", () => {
    expect(failureSentence(" No capacity in this region. ")).toBe("No capacity in this region.");
    expect(failureSentence("   ")).toBe(WAIT_WORDS.failed);
  });
});

describe("the wait's words", () => {
  it("counts what waits", () => {
    expect(waitsWords(0)).toBeUndefined();
    expect(waitsWords(1)).toBe("1 message waits");
    expect(waitsWords(3)).toBe("3 messages wait");
    expect(startingHint(0)).toBe("Its machine is starting");
    expect(startingHint(1)).toBe("Its machine is starting · 1 message waits");
  });

  it("writes the elapsed time as a clock", () => {
    expect(elapsedClock(-5)).toBe("0:00");
    expect(elapsedClock(42_999)).toBe("0:42");
    expect(elapsedClock(7 * 60_000 + 5_000)).toBe("7:05");
    expect(elapsedClock(3_723_000)).toBe("1:02:03");
  });
});
