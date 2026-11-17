import { describe, expect, it } from "vitest";

import { columns, findAll, indent, lineOf, lineStarts } from "./editing";

const apply = (value: string, start: number, end: number, outdent = false) => {
  const edit = indent({ value, start, end }, 2, outdent);
  return {
    value: value.slice(0, edit.from) + edit.insert + value.slice(edit.to),
    start: edit.start,
    end: edit.end,
  };
};

describe("find", () => {
  it("finds every match case-insensitively, without overlaps, up to a limit", () => {
    expect(findAll("Foo foo FOO", "foo")).toEqual([0, 4, 8]);
    expect(findAll("aaaa", "aa")).toEqual([0, 2]);
    expect(findAll("a a a", "a", 2)).toEqual([0, 2]);
    expect(findAll("text", "")).toEqual([]);
  });

  it("places an offset on its line and column, tabs to their stops", () => {
    const starts = lineStarts("ab\n\ncd");
    expect(starts).toEqual([0, 3, 4]);
    expect([0, 2, 3, 4, 5].map((offset) => lineOf(starts, offset))).toEqual([0, 0, 1, 2, 2]);
    expect(columns("\tx", 4)).toBe(5);
    expect(columns("ab\tx", 4)).toBe(5);
  });
});

describe("indent", () => {
  it("types spaces for Tab within a line, over what is selected", () => {
    expect(apply("ab", 1, 1)).toEqual({ value: "a  b", start: 3, end: 3 });
    expect(apply("abc", 1, 2)).toEqual({ value: "a  c", start: 3, end: 3 });
  });

  it("indents and outdents every line a selection touches", () => {
    expect(apply("a\nb\nc", 0, 3)).toEqual({ value: "  a\n  b\nc", start: 2, end: 7 });
    expect(apply("  a\n  b\nc", 2, 7, true)).toEqual({ value: "a\nb\nc", start: 0, end: 3 });
    expect(apply("   a", 3, 3, true)).toEqual({ value: " a", start: 1, end: 1 });
    expect(apply("\tx", 1, 1, true)).toEqual({ value: "x", start: 0, end: 0 });
    expect(apply("x", 0, 0, true)).toEqual({ value: "x", start: 0, end: 0 });
  });

  it("leaves the line after a selection ending at its start alone", () => {
    expect(apply("a\nb\nc", 0, 2).value).toBe("  a\nb\nc");
  });
});
