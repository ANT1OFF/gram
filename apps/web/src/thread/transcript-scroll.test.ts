import { describe, expect, it } from "vitest";

import { beginScrollGesture, consumeScrollGesture } from "./transcript-scroll";

const viewport = (scrollTop = 500) => ({
  scrollTop,
  scrollHeight: 1100,
  clientHeight: 600,
  clientWidth: 800,
});

describe("outer follow gesture", () => {
  it("consumes partial wheel movement instead of retaining forward permission for a later clamp", () => {
    const start = viewport(452);
    const input = beginScrollGesture("wheel", start, 1, 0);
    const partial = consumeScrollGesture(input, viewport(468), start.scrollTop, 1, 20);
    expect(partial).toEqual({ resume: false, gesture: undefined });
    expect(consumeScrollGesture(partial.gesture, viewport(), 468, 1, 40).resume).toBe(false);
  });

  it("recognizes actual forward wheel movement reaching the unchanged outer end", () => {
    const start = viewport(468);
    const input = beginScrollGesture("wheel", start, 1, 0);
    expect(consumeScrollGesture(input, viewport(), start.scrollTop, 1, 20)).toEqual({
      resume: true,
      gesture: undefined,
    });
  });

  it("allows native key animation across frames, then consumes it on reaching the end", () => {
    const start = viewport(400);
    const input = beginScrollGesture("key", start, 1, 0);
    const moving = consumeScrollGesture(input, viewport(450), 400, 1, 20);
    expect(moving.resume).toBe(false);
    expect(moving.gesture).toBe(input);
    expect(consumeScrollGesture(moving.gesture, viewport(), 450, 1, 100)).toEqual({
      resume: true,
      gesture: undefined,
    });
  });

  it.each(["wheel", "key", "pointer", "touch"] as const)(
    "refuses a %s token after layout clamping or resize",
    (kind) => {
      const start = viewport(468);
      const input = beginScrollGesture(kind, start, 1, 0);
      const clamped = { ...start, clientHeight: 660, scrollTop: 440 };
      expect(consumeScrollGesture(input, clamped, start.scrollTop, 1, 20)).toEqual({
        resume: false,
        gesture: undefined,
      });
    },
  );

  it("refuses measurement/anchor revision changes even when total dimensions are unchanged", () => {
    const start = viewport(468);
    const input = beginScrollGesture("key", start, 1, 0);
    expect(consumeScrollGesture(input, viewport(), start.scrollTop, 2, 20)).toEqual({
      resume: false,
      gesture: undefined,
    });
  });

  it("retires an expired or backward-interrupted token", () => {
    const start = viewport(468);
    const input = beginScrollGesture("key", start, 1, 0);
    expect(consumeScrollGesture(input, viewport(), start.scrollTop, 1, 601).resume).toBe(false);
    expect(
      consumeScrollGesture(input, viewport(450), start.scrollTop, 1, 20).gesture,
    ).toBeUndefined();
  });

  it("does not infer manual return from a bare forward scroll event", () => {
    expect(consumeScrollGesture(undefined, viewport(), 468, 1, 20)).toEqual({
      resume: false,
      gesture: undefined,
    });
  });
});
