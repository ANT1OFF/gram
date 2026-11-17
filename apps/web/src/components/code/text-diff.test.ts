import { describe, expect, it } from "vitest";

import { foldUnchanged, lineDiff, wordSpans } from "./text-diff";

const shape = (before: string, after: string) =>
  lineDiff(before, after)!.map((line) =>
    line.kind === "same"
      ? `  ${line.before}:${line.after} ${line.text}`
      : line.kind === "add"
        ? `+ -:${line.after} ${line.text}`
        : `- ${line.before}:- ${line.text}`,
  );

const wide = (word: string) => Array.from({ length: 300 }, () => word).join(" ");

describe("lineDiff", () => {
  it("numbers each line on the sides it is on, removed lines before what replaced them", () => {
    expect(shape("a\nb\nc\nd", "a\nB\nc\nd\ne")).toEqual([
      "  1:1 a",
      "- 2:- b",
      "+ -:2 B",
      "  3:3 c",
      "  4:4 d",
      "+ -:5 e",
    ]);
  });

  it("treats an empty text as no lines", () => {
    expect(shape("", "x\ny")).toEqual(["+ -:1 x", "+ -:2 y"]);
    expect(shape("x", "")).toEqual(["- 1:- x"]);
    expect(lineDiff("", "")).toEqual([]);
  });

  it("refuses texts past its line limit rather than freezing", () => {
    const long = Array.from({ length: 11 }, (_, index) => `${index}`).join("\n");
    expect(lineDiff(long, "x", { maxLines: 10 })).toBeUndefined();
    expect(lineDiff("x", long, { maxLines: 10 })).toBeUndefined();
    expect(lineDiff(long, long, { maxLines: 11 })).toHaveLength(11);
  });

  it("draws a change too large to match as removed then added, keeping the ends both share", () => {
    const a = Array.from({ length: 2100 }, (_, index) => `a${index}`);
    const b = Array.from({ length: 2100 }, (_, index) => `b${index}`);
    const lines = lineDiff(["top", ...a, "end"].join("\n"), ["top", ...b, "end"].join("\n"))!;
    expect(lines[0]).toMatchObject({ kind: "same", text: "top" });
    expect(lines.at(-1)).toMatchObject({ kind: "same", text: "end", before: 2102, after: 2102 });
    expect(lines.slice(1, 2101).every((line) => line.kind === "del")).toBe(true);
    expect(lines.slice(2101, 4201).every((line) => line.kind === "add")).toBe(true);
  });

  it("marks the words that changed within a pair of changed lines when asked", () => {
    const lines = lineDiff("const a = 1;\nkeep", "const b = 1;\nkeep", { words: true })!;
    const del = lines.find((line) => line.kind === "del")!;
    const add = lines.find((line) => line.kind === "add")!;
    expect(del.kind === "del" && del.spans).toEqual([
      { text: "const ", changed: false },
      { text: "a", changed: true },
      { text: " = 1;", changed: false },
    ]);
    expect(add.kind === "add" && add.spans?.filter((span) => span.changed)).toEqual([
      { text: "b", changed: true },
    ]);
    expect(lineDiff("a", "b")!.every((line) => line.kind === "same" || !line.spans)).toBe(true);
  });

  it("leaves words out for a line too long to compare", () => {
    const lines = lineDiff(wide("x"), wide("y"), { words: true })!;
    expect(lines.every((line) => line.kind === "same" || line.spans === undefined)).toBe(true);
    expect(wordSpans("a b", "a c")).toBeDefined();
  });
});

describe("foldUnchanged", () => {
  it("folds unchanged runs away from changes, but never a single line", () => {
    const before = Array.from({ length: 20 }, (_, index) => `${index + 1}`).join("\n");
    const after = before.replace("10", "ten");
    const rows = foldUnchanged(lineDiff(before, after)!, 3);
    expect(rows[0]).toEqual({ kind: "fold", from: 0, count: 6 });
    expect(rows.at(-1)).toEqual({ kind: "fold", from: 14, count: 7 });
    expect(rows.filter((row) => row.kind !== "fold")).toHaveLength(8);
    const short = foldUnchanged(lineDiff("1\n2\n3", "1\n2\nx")!, 1);
    expect(short.map((row) => row.kind)).toEqual(["same", "same", "del", "add"]);
  });
});
