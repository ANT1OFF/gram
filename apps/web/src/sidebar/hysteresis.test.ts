import { describe, expect, it, vi } from "vitest";

import { createStatusHold } from "./hysteresis";

describe("createStatusHold", () => {
  it("holds a move for the delay unless it is one that shows at once, and drops a move back", () => {
    vi.useFakeTimers();
    const hold = createStatusHold<string, string>(5_000, (_from, to) => to === "urgent");
    const shown = () => Object.fromEntries(hold.store.getState().shown);
    hold.update(new Map([["w", "working"]]));
    expect(shown()).toEqual({ w: "working" });

    hold.update(new Map([["w", "idle"]]));
    vi.advanceTimersByTime(4_000);
    expect(shown()).toEqual({ w: "working" });
    // Back before the hold is up: nothing moved.
    hold.update(new Map([["w", "working"]]));
    vi.advanceTimersByTime(2_000);
    expect(shown()).toEqual({ w: "working" });

    hold.update(new Map([["w", "idle"]]));
    // The same target again doesn't restart the wait.
    vi.advanceTimersByTime(3_000);
    hold.update(new Map([["w", "idle"]]));
    vi.advanceTimersByTime(2_000);
    expect(shown()).toEqual({ w: "idle" });

    hold.update(new Map([["w", "urgent"]]));
    expect(shown()).toEqual({ w: "urgent" });
    hold.update(new Map());
    expect(shown()).toEqual({});
    hold.dispose();
    vi.useRealTimers();
  });
});
