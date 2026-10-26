import { describe, expect, it } from "vitest";

import { findMatches, nextActive, type FindRow } from "./find-model";

const row = (text: string, wrapped = false): FindRow => ({
  text,
  wrapped,
  columns: [
    ...[...text].flatMap((char, i) => Array.from({ length: char.length }, () => i)),
    [...text].length,
  ],
});

const query = (term: string, extra: { caseSensitive?: boolean; regex?: boolean } = {}) => ({
  term,
  caseSensitive: false,
  regex: false,
  ...extra,
});

describe("findMatches", () => {
  it("finds every match in order, case-insensitively unless asked", () => {
    const rows = [row("echo: needle one"), row("hay"), row("Needle two, needle three")];
    expect(findMatches(rows, query("needle"))).toEqual([
      [{ row: 0, column: 6, width: 6 }],
      [{ row: 2, column: 0, width: 6 }],
      [{ row: 2, column: 12, width: 6 }],
    ]);
    expect(findMatches(rows, query("needle", { caseSensitive: true }))).toHaveLength(2);
  });

  it("treats a plain term literally and a regex as one", () => {
    const rows = [row("a.c abc")];
    expect(findMatches(rows, query("a.c"))).toEqual([[{ row: 0, column: 0, width: 3 }]]);
    expect(findMatches(rows, query("a.c", { regex: true }))).toHaveLength(2);
    expect(findMatches(rows, query("(", { regex: true }))).toEqual([]);
    expect(findMatches(rows, query("x*", { regex: true }))).toEqual([]);
    expect(findMatches(rows, query(""))).toEqual([]);
  });

  it("matches across a soft wrap but not across a line break", () => {
    const rows = [row("xxxxxxxnee"), row("dle yyyyyy", true), row("nee"), row("dle")];
    expect(findMatches(rows, query("needle"))).toEqual([
      [
        { row: 0, column: 7, width: 3 },
        { row: 1, column: 0, width: 3 },
      ],
    ]);
  });

  it("measures in cells, which a wide character takes two of", () => {
    const wide: FindRow = {
      text: "日本 ok 語",
      wrapped: false,
      columns: [0, 2, 4, 5, 6, 7, 8, 10],
    };
    expect(findMatches([wide], query("ok"))).toEqual([[{ row: 0, column: 5, width: 2 }]]);
    expect(findMatches([wide], query("本"))).toEqual([[{ row: 0, column: 2, width: 2 }]]);
    expect(findMatches([wide], query("語"))).toEqual([[{ row: 0, column: 8, width: 2 }]]);
    expect(findMatches([wide], query("ok 語"))).toEqual([[{ row: 0, column: 5, width: 5 }]]);
  });
});

describe("nextActive", () => {
  const matches = findMatches([row("a"), row("a a"), row("b"), row("a")], query("a"));

  it("starts a fresh find at what is on screen", () => {
    expect(nextActive(matches, undefined, "next", 0)).toBe(0);
    expect(nextActive(matches, undefined, "next", 2)).toBe(3);
    expect(nextActive(matches, undefined, "next", 9)).toBe(0);
    expect(nextActive([], undefined, "next", 0)).toBe(-1);
  });

  it("steps both ways and wraps", () => {
    expect(nextActive(matches, matches[0], "next", 0)).toBe(1);
    expect(nextActive(matches, matches[3], "next", 0)).toBe(0);
    expect(nextActive(matches, matches[0], "previous", 0)).toBe(3);
    expect(nextActive(matches, matches[2], "previous", 0)).toBe(1);
  });

  it("stays put while typing extends the match, and moves on once it no longer matches there", () => {
    expect(nextActive(matches, matches[2], "incremental", 0)).toBe(2);
    const gone = [[{ row: 1, column: 1, width: 1 }]];
    expect(nextActive(matches, gone[0], "incremental", 0)).toBe(2);
    expect(nextActive(matches, gone[0], "next", 0)).toBe(2);
    expect(nextActive(matches, gone[0], "previous", 0)).toBe(1);
  });
});
