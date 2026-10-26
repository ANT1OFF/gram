import { describe, expect, it } from "vitest";
import { appendTail, dropOldest, makeBoundedList, makeLineCutter } from "./bounded.ts";

describe("makeLineCutter", () => {
  it("splits chunks into lines, keeps each to its cap while it arrives, and hands over the last", () => {
    const lines: Array<[string, boolean]> = [];
    const cutter = makeLineCutter((text, cut) => void lines.push([text, cut]), 4);
    cutter.write("ab\r\ncd");
    cutter.write("efgh\nij");
    // A line that never ends stays at the cap however much more of it comes.
    cutter.write("x".repeat(100_000));
    cutter.end();
    expect(lines).toEqual([
      ["ab", false],
      ["cdef", true],
      ["ijxx", true],
    ]);
  });
});

describe("makeBoundedList", () => {
  it("drops the oldest past either cap, in the caller's own array", () => {
    const items: Array<string> = [];
    const list = makeBoundedList(items, { maxItems: 3, maxSize: 6, sizeOf: (s) => s.length });
    for (const item of ["aa", "bb", "cc", "d"]) list.push(item);
    expect(items).toEqual(["bb", "cc", "d"]);
    list.push("eeee");
    expect(items).toEqual(["d", "eeee"]);
    // One item over the size cap on its own isn't kept, and the list doesn't break.
    list.push("f".repeat(7));
    expect(items).toEqual([]);
  });
});

describe("appendTail", () => {
  it("keeps the last characters, whichever side is longer", () => {
    expect(appendTail("abc", "de", 4)).toBe("bcde");
    expect(appendTail("abc", "defgh", 4)).toBe("efgh");
    expect(appendTail("", "", 4)).toBe("");
  });
});

const olderFirst = (a: { at: number }, b: { at: number }) => a.at - b.at;

describe("dropOldest", () => {
  const files = [
    { name: "new", at: 3, bytes: 5 },
    { name: "old", at: 1, bytes: 5 },
    { name: "mid", at: 2, bytes: 5 },
  ];

  it("drops the oldest until both caps hold, and nothing when they already do", () => {
    expect(dropOldest(files, { olderFirst, maxItems: 2 }).map((f) => f.name)).toEqual(["old"]);
    expect(
      dropOldest(files, { olderFirst, maxSize: 5, sizeOf: (f) => f.bytes }).map((f) => f.name),
    ).toEqual(["old", "mid"]);
    expect(dropOldest(files, { olderFirst, maxItems: 3 })).toEqual([]);
  });

  it("never drops a pinned item, which still counts", () => {
    const drop = dropOldest(files, {
      olderFirst,
      maxSize: 4,
      sizeOf: (f) => f.bytes,
      pinned: (f) => f.name === "old",
    });
    expect(drop.map((f) => f.name)).toEqual(["mid", "new"]);
  });
});
