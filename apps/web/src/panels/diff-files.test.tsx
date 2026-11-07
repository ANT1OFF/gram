// @vitest-environment happy-dom
import type { DiffFile } from "@gram/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { mockDiff, withoutWhitespaceChanges } from "@/api/mock-git";

import { DiffFileList } from "./diff-files";
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

describe("DiffFileList", () => {
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
