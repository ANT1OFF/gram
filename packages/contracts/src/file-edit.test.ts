import { describe, expect, it } from "vitest";

import {
  fileDiffHunks,
  fileEditsOf,
  hunkCounts,
  replacementHunk,
  unifiedDiffHunks,
  wholeFileHunks,
} from "./file-edit.ts";
import { languageFor } from "./languages.ts";

const PATCH = [
  {
    oldStart: 41,
    oldLines: 3,
    newStart: 41,
    newLines: 6,
    lines: [" a", "-b", "+c", "+d", "+e", "+f", " g"],
  },
];

describe("fileEditsOf: Claude", () => {
  it("reads an Edit's structured patch, numbered, with its counts", () => {
    const [edit, ...rest] = fileEditsOf(
      "Edit",
      { file_path: "/r/a.ts", old_string: "b", new_string: "c\nd\ne\nf" },
      { filePath: "/r/a.ts", structuredPatch: PATCH, originalFile: null },
    );
    expect(rest).toEqual([]);
    expect(edit).toEqual({
      path: "/r/a.ts",
      kind: "modify",
      hunks: PATCH,
      numbered: true,
      additions: 4,
      deletions: 1,
    });
  });

  it("falls back to the replaced strings for a subagent's Edit, unnumbered", () => {
    const [edit] = fileEditsOf(
      "Edit",
      { file_path: "/r/a.ts", old_string: "keep\nold", new_string: "keep\nnew\nmore" },
      "The file /r/a.ts has been updated successfully.",
    );
    expect(edit?.numbered).toBe(false);
    expect(edit?.hunks).toEqual([
      {
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 3,
        lines: [" keep", "-old", "+new", "+more"],
      },
    ]);
    expect([edit?.additions, edit?.deletions]).toEqual([2, 1]);
  });

  it("shows an Edit still running from its input", () => {
    const [edit] = fileEditsOf(
      "Edit",
      { file_path: "/r/a.ts", old_string: "x", new_string: "y" },
      undefined,
    );
    expect([edit?.kind, edit?.additions, edit?.deletions]).toEqual(["modify", 1, 1]);
  });

  it("reads a MultiEdit's patch, or each of its replacements without one", () => {
    expect(
      fileEditsOf("MultiEdit", { file_path: "/r/a.ts", edits: [] }, { structuredPatch: PATCH })[0]
        ?.hunks,
    ).toEqual(PATCH);
    const [edit] = fileEditsOf(
      "MultiEdit",
      {
        file_path: "/r/a.ts",
        edits: [
          { old_string: "a", new_string: "b" },
          { old_string: "c", new_string: "c\nd" },
        ],
      },
      undefined,
    );
    expect(edit?.hunks.map((hunk) => hunk.lines)).toEqual([
      ["-a", "+b"],
      [" c", "+d"],
    ]);
    expect([edit?.additions, edit?.deletions, edit?.numbered]).toEqual([2, 1, false]);
  });

  it("reads a new file's Write as all added", () => {
    const [edit] = fileEditsOf(
      "Write",
      { file_path: "/r/new.ts", content: "one\ntwo\n" },
      {
        type: "create",
        filePath: "/r/new.ts",
        content: "one\ntwo\n",
        structuredPatch: [],
        originalFile: null,
      },
    );
    expect(edit).toMatchObject({ kind: "create", additions: 2, deletions: 0, numbered: true });
    expect(edit?.hunks).toEqual([
      { oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ["+one", "+two"] },
    ]);
  });

  it("reads an overwrite's patch, or diffs it against the original", () => {
    expect(
      fileEditsOf(
        "Write",
        { file_path: "/r/a.ts", content: "" },
        { type: "update", structuredPatch: PATCH },
      )[0],
    ).toMatchObject({ kind: "modify", additions: 4, deletions: 1 });
    const [diffed] = fileEditsOf(
      "Write",
      { file_path: "/r/a.ts", content: "a\nB\nc\n" },
      { type: "update", structuredPatch: [], originalFile: "a\nb\nc\n" },
    );
    expect(diffed?.hunks).toEqual([
      { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [" a", "-b", "+B", " c"] },
    ]);
  });

  it("calls a Write it can't compare a write, unless its result says it created the file", () => {
    expect(fileEditsOf("Write", { file_path: "/r/a.ts", content: "x" }, undefined)[0]?.kind).toBe(
      "write",
    );
    expect(
      fileEditsOf(
        "Write",
        { file_path: "/r/a.ts", content: "x" },
        "File created successfully at: /r/a.ts",
      )[0],
    ).toMatchObject({ kind: "create", additions: 1 });
  });

  it("has nothing for other tools or a call that doesn't name its file yet", () => {
    expect(fileEditsOf("Bash", { command: "ls" }, undefined)).toEqual([]);
    expect(fileEditsOf("Edit", {}, undefined)).toEqual([]);
    expect(fileEditsOf("Write", undefined, undefined)).toEqual([]);
  });
});

describe("fileEditsOf: Codex", () => {
  it("reads each change of a patch, its moves and whole-file adds and deletes", () => {
    const edits = fileEditsOf(
      "Edit",
      {
        file_path: "/r/a.ts",
        changes: [
          {
            path: "/r/a.ts",
            kind: { type: "update", move_path: null },
            diff: "@@ -1 +1 @@\n-a\n+b\n",
          },
          { path: "/r/b.ts", kind: { type: "update", move_path: "/r/c.ts" }, diff: "" },
          { path: "/r/new.ts", kind: { type: "add" }, diff: "x\n" },
          { path: "/r/old.ts", kind: { type: "delete" }, diff: "y\nz\n" },
          { path: "/r/bad.ts", kind: { type: "rename" }, diff: "" },
        ],
      },
      { type: "update", structuredPatch: [] },
    );
    expect(edits.map((edit) => [edit.path, edit.kind, edit.additions, edit.deletions])).toEqual([
      ["/r/a.ts", "modify", 1, 1],
      ["/r/b.ts", "modify", 0, 0],
      ["/r/new.ts", "create", 1, 0],
      ["/r/old.ts", "delete", 0, 2],
    ]);
    expect(edits[1]?.movedTo).toBe("/r/c.ts");
    expect("movedTo" in edits[0]!).toBe(false);
  });

  it("reads a Codex Write, stored as an update that adds everything, as a new file", () => {
    const [edit] = fileEditsOf(
      "Write",
      { file_path: "/r/new.ts", content: "x\ny\n" },
      { type: "update", structuredPatch: wholeFileHunks("x\ny\n", "+") },
    );
    expect(edit).toMatchObject({ kind: "create", additions: 2, deletions: 0 });
  });
});

describe("hunks", () => {
  it("counts additions and removals, not context", () => {
    expect(hunkCounts(PATCH)).toEqual({ additions: 4, deletions: 1 });
    expect(hunkCounts([])).toEqual({ additions: 0, deletions: 0 });
  });

  it("parses a unified diff past its file headers", () => {
    expect(unifiedDiffHunks("--- a/x\n+++ b/x\n@@ -2,2 +2 @@ fn\n a\n-b\n\\ No newline")).toEqual([
      { oldStart: 2, oldLines: 2, newStart: 2, newLines: 1, lines: [" a", "-b"] },
    ]);
  });

  it("diffs whole files into hunks with three lines of context, split when far apart", () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join("\n");
    const after = before.replace("l2\n", "L2\n").replace("l18\n", "L18\nnew\n");
    expect(fileDiffHunks(before, after)).toEqual([
      {
        oldStart: 1,
        oldLines: 5,
        newStart: 1,
        newLines: 5,
        lines: [" l1", "-l2", "+L2", " l3", " l4", " l5"],
      },
      {
        oldStart: 15,
        oldLines: 6,
        newStart: 15,
        newLines: 7,
        lines: [" l15", " l16", " l17", "-l18", "+L18", "+new", " l19", " l20"],
      },
    ]);
    expect(fileDiffHunks("same\n", "same\n")).toEqual([]);
  });

  it("keeps every line of a replacement", () => {
    expect(replacementHunk("a\nb\nc", "a\nc").lines).toEqual([" a", "-b", " c"]);
  });
});

describe("languageFor", () => {
  it("names a language from the file name or extension", () => {
    expect(languageFor("/x/Dockerfile")).toBe("dockerfile");
    expect(languageFor("C:\\x\\App.TSX")).toBe("tsx");
    expect(languageFor("/x/.env")).toBeUndefined();
    expect(languageFor("/x/file.")).toBeUndefined();
  });
});
