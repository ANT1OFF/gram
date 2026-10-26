// @vitest-environment happy-dom
import type { ThreadId } from "@gram/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { liveSnoozes, snoozed, STUCK_SNOOZE_MS, useStuckSnoozes } from "./stuck-snooze";

const a = "a" as ThreadId;
const b = "b" as ThreadId;

describe("stuck snoozes", () => {
  beforeEach(() => useStuckSnoozes.setState({ until: {} }));

  it("keeps a worker's card away for a day, then lets it back", () => {
    useStuckSnoozes.getState().snooze(a, 1_000);
    const { until } = useStuckSnoozes.getState();
    expect(snoozed(until, a, 1_000 + STUCK_SNOOZE_MS - 1)).toBe(true);
    expect(snoozed(until, a, 1_000 + STUCK_SNOOZE_MS)).toBe(false);
    expect(snoozed(until, b, 1_000)).toBe(false);
  });

  it("drops ended snoozes and anything that isn't a time", () => {
    expect(liveSnoozes({ a: 500, b: 2_000, c: "soon" }, 1_000)).toEqual({ b: 2_000 });
    expect(liveSnoozes(null, 1_000)).toEqual({});
    expect(liveSnoozes([3_000], 1_000)).toEqual({});
  });

  it("forgets ended snoozes when it adds one", () => {
    useStuckSnoozes.setState({ until: { [b]: 10 } });
    useStuckSnoozes.getState().snooze(a, 1_000);
    expect(Object.keys(useStuckSnoozes.getState().until)).toEqual([a]);
  });
});
