// @vitest-environment happy-dom
import type { DiffFile } from "@gram/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { mockDiff, withoutWhitespaceChanges } from "@/api/mock-git";

import { DiffFileList, pathParts } from "./diff-files";
import { ROW_BUDGET } from "./patch-view";

afterEach(cleanup);

const file = (path: string): DiffFile => ({
  path,
  status: "modified",
  additions: 1,
  deletions: 1,
  patch: "",
  binary: false,
  tooLarge: false,
});

const rows = () => document.querySelectorAll("tr").length;

const expanded = () =>
  screen
    .getAllByTestId("diff-file")
    .map((row) => row.querySelector("[data-diff-file-header]")!.getAttribute("aria-expanded"));

const sized = (path: string, lines: number): DiffFile => ({
  ...file(path),
  additions: lines,
  deletions: 0,
});

const patch = () => screen.getByTestId("patch");

/** A node's words as a reader sees them: a ticker carries its own stylesheet beside its digits. */
const words = (node: Element | null) => {
  if (node === null) return undefined;
  const copy = node.cloneNode(true) as Element;
  for (const style of copy.querySelectorAll("style")) style.remove();
  return copy.textContent;
};

describe("pathParts", () => {
  it("splits a path into its folders and the file's name", () => {
    expect(pathParts({ path: "apps/web/src/settings/settings-nav.tsx" })).toEqual({
      folders: "apps/web/src/settings/",
      name: "settings-nav.tsx",
    });
    expect(pathParts({ path: "README.md" })).toEqual({ folders: "", name: "README.md" });
  });

  it("keeps a rename's old path with the folders", () => {
    expect(pathParts({ path: "src/clock.ts", oldPath: "src/timers.ts" })).toEqual({
      folders: "src/timers.ts → src/",
      name: "clock.ts",
    });
  });
});

describe("DiffFileList", () => {
  it("says a path whole, as its folders then its name", () => {
    render(<DiffFileList files={[file("apps/web/src/settings/settings-search.ts")]} />);
    const row = screen.getByTestId("diff-file");
    expect(screen.getByTestId("diff-file-folders").textContent).toBe("apps/web/src/settings/");
    expect(screen.getByTestId("diff-file-name").textContent).toBe("settings-search.ts");
    expect(row.querySelector("[data-diff-file-header]")!.textContent).toContain(
      "apps/web/src/settings/settings-search.ts",
    );
  });

  it("leaves out a count of nothing, and both for a file with no lines to count", () => {
    render(
      <DiffFileList
        files={[
          { ...file("added.ts"), status: "added", additions: 52, deletions: 0 },
          { ...file("removed.ts"), status: "deleted", additions: 0, deletions: 7 },
          { ...file("both.ts"), additions: 1840, deletions: 912 },
          { ...file("logo.png"), status: "added", additions: 0, deletions: 0, binary: true },
        ]}
      />,
    );
    const counts = screen
      .getAllByTestId("diff-file")
      .map((row) => words(row.querySelector('[data-testid="diff-file-counts"]')));
    expect(counts).toEqual(["+52", "−7", "+1,840 −912", undefined]);
  });

  it("moves between file headers with ↑ / ↓, stopping at the ends", () => {
    render(<DiffFileList files={[file("a.ts"), file("b.ts"), file("c.ts")]} />);
    const headers = screen
      .getAllByTestId("diff-file")
      .map((row) => row.querySelector<HTMLElement>("[data-diff-file-header]")!);

    headers[0]!.focus();
    fireEvent.keyDown(headers[0]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(headers[1]);
    fireEvent.keyDown(headers[1]!, { key: "ArrowDown" });
    fireEvent.keyDown(headers[2]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(headers[2]);
    fireEvent.keyDown(headers[2]!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(headers[1]);
  });

  it("starts a refreshed patch within the row budget again", () => {
    const lockfile = mockDiff("t-flaky" as never, { kind: "uncommitted" }).files!.find(
      (f) => f.path === "pnpm-lock.yaml",
    )!;
    const focus = { path: lockfile.path, key: 1 };
    const { rerender } = render(<DiffFileList files={[lockfile]} focus={focus} />);
    fireEvent.click(screen.getByRole("button", { name: /^Show .* more lines$/ }));
    expect(rows()).toBeGreaterThan(ROW_BUDGET);

    rerender(
      <DiffFileList files={[{ ...lockfile, patch: `${lockfile.patch}\n+x` }]} focus={focus} />,
    );
    expect(rows()).toBe(ROW_BUDGET);
  });

  it("starts every file open while the diff is small, however many files it has", () => {
    render(<DiffFileList files={["a", "b", "c", "d", "e"].map((p) => sized(p, 79))} />);
    expect(expanded()).toEqual(["true", "true", "true", "true", "true"]);
    cleanup();
    // 400 changed lines in all is past small: more than three files start folded but the first.
    render(<DiffFileList files={["a", "b", "c", "d", "e"].map((p) => sized(p, 80))} />);
    expect(expanded()).toEqual(["true", "false", "false", "false", "false"]);
    cleanup();
    render(<DiffFileList files={[sized("a", 10), sized("lock", 900)]} />);
    expect(expanded()).toEqual(["true", "false"]);
  });

  it("opens a large diff on its first file that isn't gated, the gated ones still folded", () => {
    // t-flaky's change: an image, then readable files, then a 2,752-line lockfile.
    const files = [
      { ...sized("assets/retry-timeline.png", 0), binary: true },
      { ...sized("big.ts", 401) },
      { ...sized("huge.ts", 9), tooLarge: true },
      sized("pnpm-lock.yaml", 300),
      sized("docs/testing.md", 3),
      sized("src/retry.test.ts", 3),
    ];
    render(<DiffFileList files={files} />);
    expect(expanded()).toEqual(["false", "false", "false", "false", "true", "false"]);
    cleanup();
    // Nothing readable: every file waits behind its header, as before.
    render(
      <DiffFileList
        files={[
          sized("package-lock.json", 200),
          sized("big.ts", 500),
          sized("c.ts", 401),
          sized("d.ts", 401),
        ]}
      />,
    );
    expect(expanded()).toEqual(["false", "false", "false", "false"]);
  });

  it("wraps long unified lines on request instead of scrolling them", () => {
    const long: DiffFile = { ...file("a.ts"), patch: `@@ -1 +1 @@\n-${"x".repeat(400)}\n+y` };
    const { rerender } = render(<DiffFileList files={[long]} />);
    expect(patch().getAttribute("data-wrap")).toBe("false");
    expect(patch().className).toContain("overflow-x-auto");
    rerender(<DiffFileList files={[long]} wrap />);
    expect(patch().getAttribute("data-wrap")).toBe("true");
    expect(patch().className).not.toContain("overflow-x-auto");
    expect(patch().querySelector("td.whitespace-pre-wrap")).not.toBeNull();
  });
});

describe("withoutWhitespaceChanges", () => {
  it("keeps real changes, turns re-indented lines into context and drops what is left empty", () => {
    const clock = mockDiff("t-flaky" as never, { kind: "uncommitted" }).files!.find(
      (f) => f.path === "src/clock.ts",
    )!;
    expect(clock).toMatchObject({ additions: 2, deletions: 2 });
    const kept = withoutWhitespaceChanges(clock)!;
    expect(kept).toMatchObject({ additions: 1, deletions: 1 });
    expect(kept.patch).toContain("\n     new Promise");
    const reindent: DiffFile = { ...file("b.ts"), patch: "@@ -1 +1 @@\n-  a  b\n+a b" };
    expect(withoutWhitespaceChanges(reindent)).toBeUndefined();
    const filtered = mockDiff(
      "t-flaky" as never,
      { kind: "uncommitted" },
      { ignoreWhitespace: true },
    );
    expect(filtered.files!.find((f) => f.path === "src/clock.ts")).toMatchObject({
      additions: 1,
      deletions: 1,
    });
  });
});
