import { describe, expect, it } from "vitest";

import { awayEventOf, INTERRUPT_POLICY, interrupts, type AwayEvent } from "./interrupt-policy";

describe("interrupt policy", () => {
  it("lets only asks and failures interrupt", () => {
    const interrupting = (Object.keys(INTERRUPT_POLICY) as AwayEvent[]).filter((event) =>
      interrupts(event),
    );
    expect(interrupting.toSorted()).toEqual(["ask", "failure", "needsYou"]);
  });

  it("holds failures back at Asks only, and asks still interrupt", () => {
    const interrupting = (Object.keys(INTERRUPT_POLICY) as AwayEvent[]).filter((event) =>
      interrupts(event, "asks"),
    );
    expect(interrupting.toSorted()).toEqual(["ask", "needsYou"]);
    expect(interrupts("failure", "asksAndFailures")).toBe(true);
  });

  it("keeps merges, wakes, stage moves and progress for Since you left", () => {
    for (const event of ["merge", "done", "wake", "stage", "progress"] as const) {
      expect(INTERRUPT_POLICY[event]).toBe("sinceYouLeft");
      expect(interrupts(event)).toBe(false);
    }
    expect(interrupts("info")).toBe(false);
  });

  it("places each server notice by its kind", () => {
    expect(awayEventOf({ kind: "error" })).toBe("failure");
    expect(awayEventOf({ kind: "needsInput" })).toBe("needsYou");
    expect(awayEventOf({ kind: "done" })).toBe("done");
    expect(awayEventOf({ kind: "info" })).toBe("info");
    expect(interrupts(awayEventOf({ kind: "done" }))).toBe(false);
  });
});
