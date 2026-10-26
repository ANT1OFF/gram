import { describe, expect, it } from "vitest";

import { activeStreamingIds } from "./streaming";

describe("activeStreamingIds", () => {
  it("keeps streaming ids while a turn is in progress", () => {
    for (const status of ["starting", "running", "needsApproval", "needsInput"] as const) {
      expect([...activeStreamingIds(status, ["a1"])]).toEqual(["a1"]);
    }
  });

  it("drops a stream that never closed once the turn is over", () => {
    for (const status of ["idle", "cold", "ended", "error"] as const) {
      expect(activeStreamingIds(status, ["a1"]).size).toBe(0);
    }
    expect(activeStreamingIds(undefined, ["a1"]).size).toBe(0);
  });

  it("keeps a background subagent's transcript streaming after the turn", () => {
    const nested = new Set(["sub1"]);
    expect([...activeStreamingIds("idle", ["a1", "sub1"], nested)]).toEqual(["sub1"]);
    expect(activeStreamingIds("idle", ["a1"], nested).size).toBe(0);
  });
});
