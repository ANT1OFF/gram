// @vitest-environment happy-dom
import type { DiffFile } from "@gram/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { mockDiff } from "@/api/mock-git";

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
});
