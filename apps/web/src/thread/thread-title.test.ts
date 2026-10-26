import { describe, expect, it } from "vitest";

import { threadDisplayTitle } from "./thread-title";

describe("threadDisplayTitle", () => {
  it("names a thread by its title, and one without a title or not loaded as Untitled", () => {
    expect(threadDisplayTitle({ title: "Fix the meter" })).toBe("Fix the meter");
    expect(threadDisplayTitle({ title: "" })).toBe("Untitled");
    expect(threadDisplayTitle(undefined)).toBe("Untitled");
  });
});
