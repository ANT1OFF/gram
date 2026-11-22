import { describe, expect, it } from "vitest";

import { markdownRoot, previewableFiles, writesTo } from "./preview-files";

const done = (type: string, input: unknown) => ({ type, state: "output-available", input });

describe("previewableFiles", () => {
  it("lists each Markdown or HTML file a message's finished writes left, last written last", () => {
    expect(
      previewableFiles([
        done("tool-Write", { file_path: "/tmp/r/dashboard.html", content: "" }),
        done("tool-Edit", { file_path: "/repo/README.md" }),
        done("tool-Write", { file_path: "/repo/src/app.ts" }),
        done("tool-Read", { file_path: "/repo/NOTES.md" }),
        { type: "tool-Write", state: "input-available", input: { file_path: "/tmp/draft.md" } },
        { type: "tool-Write", state: "output-error", input: { file_path: "/tmp/failed.md" } },
        done("tool-Edit", { changes: [{ path: "/repo/docs/a.markdown" }, { path: "/x.ts" }] }),
        done("tool-Edit", { file_path: "/tmp/r/dashboard.html" }),
        done("tool-Write", { file_path: "/Users/me/.aws/notes.md" }),
        { type: "text", text: "/tmp/said.html" },
      ]),
    ).toEqual([
      { path: "/repo/README.md", kind: "markdown" },
      { path: "/repo/docs/a.markdown", kind: "markdown" },
      { path: "/tmp/r/dashboard.html", kind: "html" },
    ]);
  });
});

describe("markdownRoot", () => {
  it("is the thread's folder holding the file, or the file's own folder elsewhere", () => {
    const roots = ["/repo", "/repo-api/", "/repo/docs"];
    expect(markdownRoot("/repo/src/guide/README.md", roots)).toBe("/repo");
    expect(markdownRoot("/repo/docs/a.md", roots)).toBe("/repo/docs");
    expect(markdownRoot("/repo-api/NOTES.md", roots)).toBe("/repo-api");
    expect(markdownRoot("/tmp/gram-report/REPORT.md", roots)).toBe("/tmp/gram-report");
    expect(markdownRoot("/REPORT.md", [])).toBe("/");
  });
});

const message = (...parts: unknown[]) => ({ parts });

describe("writesTo", () => {
  const path = "/repo/docs/design.md";

  it("counts the finished writes to a file and keeps the text they left it with", () => {
    const writes = writesTo(
      [
        message(done("tool-Write", { file_path: path, content: "# Plan\n\nOne. One." })),
        message(
          done("tool-Write", { file_path: "/repo/other.md", content: "other" }),
          done("tool-Edit", { file_path: path, old_string: "One.", new_string: "Two." }),
          { type: "tool-Edit", state: "output-error", input: { file_path: path } },
        ),
        message(
          done("tool-MultiEdit", {
            file_path: path,
            edits: [{ old_string: "One.", new_string: "Three.", replace_all: true }],
          }),
        ),
      ],
      path,
    );
    expect(writes).toEqual({ count: 3, content: "# Plan\n\nTwo. Three." });
  });

  it("has no text when an Edit came first or didn't apply as written", () => {
    expect(
      writesTo(
        [message(done("tool-Edit", { file_path: path, old_string: "a", new_string: "b" }))],
        path,
      ),
    ).toEqual({ count: 1, content: undefined });
    expect(
      writesTo(
        [
          message(
            done("tool-Write", { file_path: path, content: "text" }),
            done("tool-Edit", { file_path: path, old_string: "missing", new_string: "b" }),
          ),
        ],
        path,
      ),
    ).toEqual({ count: 2, content: undefined });
    expect(writesTo([], path)).toEqual({ count: 0, content: undefined });
  });
});
