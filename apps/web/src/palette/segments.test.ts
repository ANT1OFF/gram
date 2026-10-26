import { describe, expect, it } from "vitest";

import { highlightSegments } from "./segments";

describe("highlightSegments", () => {
  it("splits text into plain and matched runs", () => {
    expect(highlightSegments("fix flaky test", [{ start: 4, end: 9 }])).toEqual([
      { text: "fix ", match: false },
      { text: "flaky", match: true },
      { text: " test", match: false },
    ]);
  });

  it("sorts, clamps and doesn't repeat overlapping ranges", () => {
    expect(
      highlightSegments("abcdef", [
        { start: 4, end: 99 },
        { start: 0, end: 2 },
        { start: 1, end: 3 },
      ]),
    ).toEqual([
      { text: "ab", match: true },
      { text: "c", match: true },
      { text: "d", match: false },
      { text: "ef", match: true },
    ]);
  });

  it("leaves text without highlights whole", () => {
    expect(highlightSegments("plain")).toEqual([{ text: "plain", match: false }]);
  });
});
