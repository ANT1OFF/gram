import { describe, expect, it } from "vitest";

import { SEARCH_SNIPPET_MAX, searchRanges, searchSnippet } from "./fs-search.ts";

describe("searchRanges", () => {
  it("matches literally and case-insensitively by default", () => {
    expect(searchRanges("Retry a.b retry", "retry", {})).toEqual([
      { start: 0, end: 5 },
      { start: 10, end: 15 },
    ]);
    expect(searchRanges("a.b axb", "a.b", {})).toEqual([{ start: 0, end: 3 }]);
    expect(searchRanges("Retry retry", "retry", { caseSensitive: true })).toEqual([
      { start: 6, end: 11 },
    ]);
  });

  it("uses the regex when asked, and highlights nothing it can't compile", () => {
    expect(searchRanges("sleep retry", "sle+p|ret", { regex: true })).toEqual([
      { start: 0, end: 5 },
      { start: 6, end: 9 },
    ]);
    expect(searchRanges("a(b", "(", { regex: true })).toEqual([]);
    expect(searchRanges("abc", "x*", { regex: true })).toEqual([]);
  });
});

describe("searchSnippet", () => {
  it("keeps short lines whole and windows long ones around the first match", () => {
    expect(searchSnippet("const retry = 1;", "retry", {})).toEqual({
      text: "const retry = 1;",
      ranges: [{ start: 6, end: 11 }],
    });
    const line = `${"x".repeat(500)}retry${"y".repeat(500)}`;
    const snippet = searchSnippet(line, "retry", {});
    expect(snippet.text).toHaveLength(SEARCH_SNIPPET_MAX);
    expect(snippet.ranges).toEqual([{ start: 40, end: 45 }]);
    expect(snippet.text.slice(40, 45)).toBe("retry");
  });
});
