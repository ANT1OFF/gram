// @vitest-environment happy-dom
import type { DiffChunk, DiffChunkRequest, DiffFile, ThreadId } from "@gram/contracts";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MOCK_DEPS_TURN, mockDiff, mockDiffChunk } from "@/api/mock-git";

import { DiffChunkSourceContext, MAX_LOADED_LINES, type DiffChunkSource } from "./diff-chunks";
import { DiffFileList } from "./diff-files";
import { renderWithApi } from "./test-utils";

afterEach(cleanup);

const T = "t-deps" as ThreadId;
const SOURCE: DiffChunkSource = {
  threadId: T,
  scope: { kind: "turn", turnId: MOCK_DEPS_TURN },
  ignoreWhitespace: false,
};
const FILES = mockDiff(T, SOURCE.scope).files!;
const LOCKFILE = FILES.find((file) => file.path === "pnpm-lock.yaml")!;

const renderList = (
  gitDiffChunk: (threadId: ThreadId, request: DiffChunkRequest) => Promise<DiffChunk>,
  files: readonly DiffFile[] = FILES,
) =>
  renderWithApi(
    <DiffChunkSourceContext value={SOURCE}>
      <DiffFileList files={files} />
    </DiffChunkSourceContext>,
    { gitDiffChunk },
  );

const note = () => screen.getByTestId("diff-too-large");
const headers = () =>
  [...note().querySelectorAll<HTMLElement>("tr[data-hunk]")].map((row) =>
    Number(row.dataset["hunk"]),
  );

/** Hunk `hunk` of a patch that never ends: a thousand lines a chunk. */
const thousandLines = (hunk: number) =>
  [
    `@@ -${hunk * 1000 + 1},1000 +${hunk * 1000 + 1},1000 @@`,
    ...Array.from({ length: 1000 }, (_, i) => ` line ${hunk * 1000 + i}`),
    "",
  ].join("\n");

describe("a diff file too large for the list", () => {
  it("keeps the ways to read it elsewhere, and offers to load it here", () => {
    renderList(vi.fn());
    expect(note().textContent).toContain("This patch is too large to show here whole");
    expect(note().textContent).toContain("The other file in this diff is reviewable here.");
    expect(within(note()).getByRole("button", { name: "Copy git diff command" })).toBeTruthy();
    expect(within(note()).getByRole("button", { name: "Summarize changes" })).toBeTruthy();
    expect(within(note()).getByRole("button", { name: "Load first 20 hunks" })).toBeTruthy();
  });

  it("summarizes a lockfile by the packages it changed", async () => {
    const gitDiffChunk = vi.fn(async (threadId: ThreadId, request: DiffChunkRequest) =>
      mockDiffChunk(threadId, request),
    );
    renderList(gitDiffChunk);
    fireEvent.click(within(note()).getByRole("button", { name: "Summarize changes" }));
    const summary = await screen.findByTestId("diff-summary");
    expect(gitDiffChunk).toHaveBeenCalledWith(T, {
      scope: SOURCE.scope,
      path: "pnpm-lock.yaml",
      mode: "summary",
    });
    expect(summary.textContent).toContain("25 packages changed over 25 hunks");
    expect(summary.textContent).toContain(`+${LOCKFILE.additions}`);
    expect(within(summary).getByText("vitest")).toBeTruthy();
    expect(within(summary).getAllByRole("listitem")).toHaveLength(12);
    fireEvent.click(within(summary).getByRole("button", { name: "Show all 25" }));
    expect(within(summary).getAllByRole("listitem")).toHaveLength(25);
  });

  it("loads the first hunks, then more, each chunk numbering its hunks within the file", async () => {
    const gitDiffChunk = vi.fn(async (threadId: ThreadId, request: DiffChunkRequest) =>
      mockDiffChunk(threadId, request),
    );
    renderList(gitDiffChunk);
    fireEvent.click(within(note()).getByRole("button", { name: "Load first 20 hunks" }));
    expect(await screen.findByText("20 of 25 hunks loaded · 365 lines")).toBeTruthy();
    expect(headers()).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(gitDiffChunk).toHaveBeenLastCalledWith(T, {
      scope: SOURCE.scope,
      path: "pnpm-lock.yaml",
      hunks: 20,
    });
    const first = await gitDiffChunk.mock.results[0]!.value;

    fireEvent.click(within(note()).getByRole("button", { name: "Load more" }));
    expect(await screen.findByText(/^All 25 hunks loaded/)).toBeTruthy();
    expect(gitDiffChunk).toHaveBeenLastCalledWith(T, {
      scope: SOURCE.scope,
      path: "pnpm-lock.yaml",
      hunks: 20,
      cursor: { hunk: 20, line: 0 },
      fingerprint: first.fingerprint,
    });
    expect(headers()).toEqual(Array.from({ length: 25 }, (_, i) => i));
    expect(screen.getAllByTestId("diff-chunk")).toHaveLength(2);
    // Each chunk is drawn only near the screen, keeping its height while it isn't.
    expect(screen.getAllByTestId("diff-chunk")[0]!.style.contentVisibility).toBe("auto");
    expect(within(note()).queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("keeps the loaded hunks when the file is folded and opened again", async () => {
    const gitDiffChunk = vi.fn(async (threadId: ThreadId, request: DiffChunkRequest) =>
      mockDiffChunk(threadId, request),
    );
    renderList(gitDiffChunk);
    fireEvent.click(within(note()).getByRole("button", { name: "Load first 20 hunks" }));
    await screen.findByText(/^20 of 25 hunks loaded/);
    const header = screen
      .getAllByTestId("diff-file")
      .find((row) => row.dataset["path"] === "pnpm-lock.yaml")!
      .querySelector<HTMLElement>("[data-diff-file-header]")!;
    fireEvent.click(header);
    await waitFor(() => expect(screen.queryByTestId("diff-too-large")).toBeNull());
    fireEvent.click(header);
    expect(await screen.findByText(/^20 of 25 hunks loaded/)).toBeTruthy();
    expect(gitDiffChunk).toHaveBeenCalledTimes(1);
  });

  it("says when the file changed between chunks, and starts again on Reload", async () => {
    let edited = false;
    const gitDiffChunk = vi.fn(async (threadId: ThreadId, request: DiffChunkRequest) => {
      const chunk = mockDiffChunk(threadId, request);
      return edited && request.fingerprint !== undefined
        ? { ...chunk, changed: true, patch: "" }
        : chunk;
    });
    renderList(gitDiffChunk);
    fireEvent.click(within(note()).getByRole("button", { name: "Load first 20 hunks" }));
    await screen.findByText(/^20 of 25 hunks loaded/);
    edited = true;
    fireEvent.click(within(note()).getByRole("button", { name: "Load more" }));
    expect(await screen.findByText(/This file changed after its first hunks loaded/)).toBeTruthy();
    edited = false;
    fireEvent.click(within(note()).getByRole("button", { name: "Reload hunks" }));
    await waitFor(() => expect(screen.queryByText(/This file changed/)).toBeNull());
    expect(headers().length).toBeGreaterThan(0);
  });

  it(`stops offering more past ${MAX_LOADED_LINES} loaded lines`, async () => {
    const gitDiffChunk = vi.fn(
      async (_threadId: ThreadId, request: DiffChunkRequest): Promise<DiffChunk> => {
        const hunk = request.cursor?.hunk ?? 0;
        return {
          path: "huge.txt",
          fingerprint: "f",
          changed: false,
          binary: false,
          patch: thousandLines(hunk),
          next: { hunk: hunk + 1, line: 0 },
          totalHunks: 50,
          additions: 0,
          deletions: 0,
          clippedLines: 0,
          partial: false,
        };
      },
    );
    const huge: DiffFile = { ...LOCKFILE, path: "huge.txt" };
    renderList(gitDiffChunk, [huge]);
    fireEvent.click(within(note()).getByRole("button", { name: "Load first 20 hunks" }));
    await screen.findByText(/^1 of 50 hunks loaded/);
    for (let loaded = 1; loaded < MAX_LOADED_LINES / 1000; loaded++) {
      await act(async () => {
        fireEvent.click(within(note()).getByRole("button", { name: "Load more" }));
      });
      await screen.findByText(new RegExp(`^${loaded + 1} of 50 hunks loaded`));
    }
    expect(within(note()).queryByRole("button", { name: "Load more" })).toBeNull();
    expect(note().textContent).toContain("the most loaded here at once");
    expect(gitDiffChunk).toHaveBeenCalledTimes(MAX_LOADED_LINES / 1000);
    // happy-dom draws ten thousand rows slowly; a browser skips the chunks off screen.
  }, 60_000);

  it("offers nothing to load where the list doesn't know the diff's source", () => {
    renderWithApi(<DiffFileList files={FILES} />, {});
    expect(note().textContent).toContain("The other file in this diff is reviewable here.");
    expect(within(note()).queryByRole("button", { name: /Load first/ })).toBeNull();
  });
});
