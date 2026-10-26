import type { DiffFile } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { buildDiffTree, treeOrder } from "./diff-tree-model";
import { countHunks, lineRange, parseHunks, splitRows } from "./patch";

describe("parseHunks", () => {
  it("numbers context, added and removed lines per hunk", () => {
    const [hunk, second] = parseHunks(
      [
        '@@ -12,4 +12,5 @@ describe("retry")',
        " const op = flaky(2);",
        "-await sleep(100);",
        "+const clock = useFakeTimers();",
        "+await clock.tickAsync(100);",
        " expect(ok);",
        "@@ -40 +41 @@",
        "-a",
        "+b",
        "",
      ].join("\n"),
    );

    expect(hunk).toMatchObject({
      oldStart: 12,
      oldLines: 4,
      newStart: 12,
      newLines: 5,
      section: 'describe("retry")',
    });
    expect(hunk!.lines).toEqual([
      { kind: "ctx", text: "const op = flaky(2);", oldNo: 12, newNo: 12 },
      { kind: "del", text: "await sleep(100);", oldNo: 13 },
      { kind: "add", text: "const clock = useFakeTimers();", newNo: 13 },
      { kind: "add", text: "await clock.tickAsync(100);", newNo: 14 },
      { kind: "ctx", text: "expect(ok);", oldNo: 14, newNo: 15 },
    ]);
    expect(second).toMatchObject({ oldStart: 40, oldLines: 1, newStart: 41, newLines: 1 });
    expect(second!.lines).toEqual([
      { kind: "del", text: "a", oldNo: 40 },
      { kind: "add", text: "b", newNo: 41 },
    ]);
  });

  it("keeps no-newline markers as notes and ignores text before the first hunk", () => {
    const [hunk] = parseHunks("junk\n@@ -0,0 +1 @@\n+x\n\\ No newline at end of file");
    expect(hunk!.lines).toEqual([
      { kind: "add", text: "x", newNo: 1 },
      { kind: "note", text: "No newline at end of file" },
    ]);
  });

  it("returns no hunks for an empty patch", () => {
    expect(parseHunks("")).toEqual([]);
  });
});

describe("splitRows", () => {
  it("pairs each run of removals with the additions after it, padding the shorter side", () => {
    const [hunk] = parseHunks(
      [
        "@@ -1,5 +1,5 @@",
        " a",
        "-b",
        "-c",
        "+B",
        " d",
        "+e",
        "-f",
        "+F",
        "\\ No newline at end of file",
      ].join("\n"),
    );
    const rows = splitRows(hunk!.lines).map((row) =>
      row.kind === "note"
        ? `note:${row.text}`
        : `${row.left?.text ?? "_"}|${row.right?.text ?? "_"}`,
    );
    // An addition before a removal is its own change: `e` pairs with nothing.
    expect(rows).toEqual([
      "a|a",
      "b|B",
      "c|_",
      "d|d",
      "_|e",
      "f|F",
      "note:No newline at end of file",
    ]);
  });

  it("counts hunks without parsing", () => {
    expect(countHunks("@@ -1 +1 @@\n-a\n+b\n@@ -9,2 +9,2 @@ f()\n x")).toBe(2);
    expect(countHunks("")).toBe(0);
  });
});

const file = (path: string): DiffFile => ({
  path,
  status: "modified",
  additions: 1,
  deletions: 0,
  patch: "",
  binary: false,
  tooLarge: false,
});

describe("buildDiffTree", () => {
  it("puts folders first, compacts lone subfolders and lists files in the tree's order", () => {
    const nodes = buildDiffTree(
      ["README.md", "apps/web/src/a.ts", "apps/web/src/b/c.ts", "apps/web/src/b/d.ts", "z.ts"].map(
        file,
      ),
    );
    const shape = (list: typeof nodes): unknown[] =>
      list.map((node) =>
        node.kind === "file" ? node.name : { [node.name]: shape(node.children) },
      );
    expect(shape(nodes)).toEqual([
      { "apps/web/src": [{ b: ["c.ts", "d.ts"] }, "a.ts"] },
      "README.md",
      "z.ts",
    ]);
    expect(treeOrder(nodes).map((f) => f.path)).toEqual([
      "apps/web/src/b/c.ts",
      "apps/web/src/b/d.ts",
      "apps/web/src/a.ts",
      "README.md",
      "z.ts",
    ]);
  });
});

describe("lineRange", () => {
  const [hunk] = parseHunks("@@ -10,3 +10,3 @@\n a\n-b\n+B\n c\n-d\n\\ No newline at end of file");

  it("numbers a range by the new file, with each line's sign in the snippet", () => {
    expect(lineRange(hunk!, 2, 0)).toEqual({
      side: "new",
      start: 10,
      end: 11,
      snippet: " a\n-b\n+B",
    });
  });

  it("numbers removed lines alone by the old file, leaving out notes", () => {
    expect(lineRange(hunk!, 4, 5)).toEqual({ side: "old", start: 13, end: 13, snippet: "-d" });
  });
});
