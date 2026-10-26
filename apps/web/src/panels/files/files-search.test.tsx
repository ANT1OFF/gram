// @vitest-environment happy-dom
import type { ThreadId } from "@gram/contracts";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMockApi } from "@/api/mock";
import { searchMockFiles } from "@/api/mock-files";
import { renderWithApi } from "@/panels/test-utils";

import { FilesPanel } from "./files-panel";
import { searchStatus } from "./files-search";
import { resetFilesStore, useFilesStore } from "./files-store";

const THREAD = "t-flaky" as ThreadId;
const ROOT = "/Users/dev/code/api/.worktrees/fix-flaky-retry";

afterEach(() => {
  cleanup();
  resetFilesStore();
});

const searchFor = async (query: string) => {
  const api = createMockApi({ speed: 0, autoplay: false });
  const openInEditor = vi.spyOn(api, "openInEditor");
  renderWithApi(<FilesPanel threadId={THREAD} root={ROOT} />, api);
  // A leading `?` turns the filter into a contents search.
  fireEvent.change(screen.getByRole("textbox", { name: "Filter files" }), {
    target: { value: `?${query}` },
  });
  return { openInEditor };
};

const results = () =>
  within(screen.getByRole("list", { name: "Search results" })).getAllByRole("button", {
    name: /, line \d+:/,
  });

describe("Search in files", () => {
  it("lists matches with path, line and highlighted text, announcing the count", async () => {
    await searchFor("sleep");
    expect(await screen.findByRole("status")).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toMatch(/^\d+ results? in \d+ files?$/),
    );
    const first = results()[0]!;
    expect(first.textContent).toContain("src/clock.ts:1");
    expect(first.querySelector("mark")?.textContent).toBe("sleep");
  });

  it("moves through results with the keyboard and previews the file at the line", async () => {
    const { openInEditor } = await searchFor("retry");
    await waitFor(() => expect(results().length).toBeGreaterThan(1));
    const input = screen.getByRole("textbox", { name: "Search in files" });

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(document.activeElement).toBe(results()[0]);
    fireEvent.keyDown(results()[0]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(results()[1]);
    expect(results()[1]!.getAttribute("tabindex")).toBe("0");
    expect(results()[0]!.getAttribute("tabindex")).toBe("-1");

    fireEvent.click(results()[1]!);
    const { selected, line } = useFilesStore.getState().byThread[THREAD]!;
    const second = searchMockFiles(ROOT, "retry").matches[1]!;
    expect(selected).toBe(second.path);
    expect(line).toBe(second.line);

    fireEvent.keyDown(results()[1]!, { key: "Enter", shiftKey: true });
    expect(openInEditor).toHaveBeenCalledWith(second.path, { threadId: THREAD, line: second.line });

    fireEvent.keyDown(results()[1]!, { key: "ArrowUp" });
    fireEvent.keyDown(results()[0]!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(input);
  });

  it("explains a malformed regex", async () => {
    await searchFor("ret(");
    fireEvent.click(screen.getByRole("button", { name: "Regular expression" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Invalid regular expression");
  });
});

describe("searchMockFiles", () => {
  it("leaves out git-ignored and binary files, and pages like the server", () => {
    const all = searchMockFiles(ROOT, "retry");
    expect(all.matches.some((match) => match.relativePath.startsWith("dist/"))).toBe(false);
    expect(all.matches.map((match) => match.relativePath)).toEqual(
      all.matches.map((match) => match.relativePath).toSorted(),
    );
    const page = searchMockFiles(ROOT, "retry", { limit: 2 });
    expect(page.matches).toHaveLength(2);
    expect(page.nextOffset).toBe(2);
    expect(searchMockFiles(ROOT, "RETRY", { caseSensitive: true }).matches).toEqual([]);
  });
});

describe("searchStatus", () => {
  it("says what the search is doing", () => {
    expect(searchStatus("idle", [], false)).toBe(
      "Type at least 2 characters to search file contents.",
    );
    expect(searchStatus("done", [], false)).toBe("No results");
    const match = { path: "/a", relativePath: "a", line: 1, text: "x", ranges: [] };
    expect(searchStatus("done", [match, { ...match, line: 2 }], true)).toBe(
      "2 results in 1 file, more to load",
    );
  });
});
