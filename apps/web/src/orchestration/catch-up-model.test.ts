import { describe, expect, it } from "vitest";

import { reportLine } from "./board-model";
import { repeatsReport } from "./catch-up-model";

describe("repeatsReport", () => {
  const report = "0.9 notes cover undo, empty states and the new shortcuts.";

  it("hides a catch-up that only repeats the last report, the view's Last report line", () => {
    // Round 8: "Since you looked 0.9 notes cover undo…" over "Last report · 0.9 notes cover undo…".
    expect(repeatsReport(report, report)).toBe(true);
    expect(repeatsReport("0.9 notes cover undo, empty states and the new shortcuts", report)).toBe(
      true,
    );
    // The report's own summary, clipped as the card clips it.
    const long = `${report} ${"More detail. ".repeat(30)}`;
    expect(repeatsReport(reportLine(long, 220), long)).toBe(true);
  });

  it("keeps a catch-up that says something the report doesn't", () => {
    expect(repeatsReport("Opened #142; waiting on checks.", report)).toBe(false);
    expect(repeatsReport("Opened #142; waiting on checks.", undefined)).toBe(false);
  });
});
