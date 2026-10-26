// @vitest-environment happy-dom
import type { ThreadId } from "@gram/contracts";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMockApi } from "@/api/mock";
import { renderWithApi } from "@/panels/test-utils";

import { FilesPanel, SIDE_BY_SIDE_MIN } from "./files-panel";
import { OPEN_LIMIT, resetFilesStore, useFilesStore } from "./files-store";

const THREAD = "t-flaky" as ThreadId;
/** The seeded `t-flaky` thread's checkout. */
const ROOT = "/Users/dev/code/api/.worktrees/fix-flaky-retry";

const renderFiles = () =>
  renderWithApi(
    <FilesPanel threadId={THREAD} root={ROOT} />,
    createMockApi({ speed: 0, autoplay: false }),
  );

const tabNames = () =>
  within(screen.getByRole("tablist", { name: "Open files" }))
    .getAllByRole("tab")
    .map((tab) => tab.textContent);

afterEach(() => {
  cleanup();
  resetFilesStore();
  vi.unstubAllGlobals();
});

describe("Files tabs", () => {
  it("keeps each opened file as a tab and shows the one beside a closed tab", async () => {
    const { select } = useFilesStore.getState();
    select(THREAD, `${ROOT}/package.json`);
    select(THREAD, `${ROOT}/README.md`);
    select(THREAD, `${ROOT}/latest`);
    renderFiles();
    expect(tabNames()).toEqual(["package.json", "README.md", "latest"]);

    fireEvent.click(screen.getByRole("tab", { name: /README\.md/ }));
    expect(useFilesStore.getState().byThread[THREAD]?.selected).toBe(`${ROOT}/README.md`);

    fireEvent.click(screen.getByRole("button", { name: "Close README.md" }));
    expect(tabNames()).toEqual(["package.json", "latest"]);
    expect(useFilesStore.getState().byThread[THREAD]?.selected).toBe(`${ROOT}/latest`);

    // Opening a tab that's open already doesn't add another.
    select(THREAD, `${ROOT}/package.json`);
    await waitFor(() => expect(tabNames()).toEqual(["package.json", "latest"]));
  });

  it("closes the preview with its last tab", async () => {
    useFilesStore.getState().select(THREAD, `${ROOT}/package.json`);
    renderFiles();
    const preview = await screen.findByTestId("file-preview");
    fireEvent.click(within(preview).getByRole("button", { name: "Close preview" }));
    expect(screen.queryByTestId("file-preview")).toBeNull();
    expect(screen.queryByRole("tablist", { name: "Open files" })).toBeNull();
  });

  it("drops the oldest tab past the limit", () => {
    const { select } = useFilesStore.getState();
    for (let i = 0; i <= OPEN_LIMIT; i++) select(THREAD, `${ROOT}/file-${i}.ts`);
    const open = useFilesStore.getState().byThread[THREAD]?.open ?? [];
    expect(open).toHaveLength(OPEN_LIMIT);
    expect(open[0]).toBe(`${ROOT}/file-1.ts`);
  });
});

describe("Files find box", () => {
  it("searches contents after a leading ?, and Escape clears back to the tree", async () => {
    renderFiles();
    await screen.findByRole("treeitem", { name: "src" });
    fireEvent.change(screen.getByRole("textbox", { name: "Filter files" }), {
      target: { value: "?retry" },
    });
    const input = screen.getByRole("textbox", { name: "Search in files" });
    expect((input as HTMLInputElement).value).toBe("?retry");
    expect(useFilesStore.getState().search.query).toBe("retry");
    expect(await screen.findByRole("list", { name: "Search results" })).toBeTruthy();

    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.getByRole("textbox", { name: "Filter files" })).toBeTruthy();
    expect(await screen.findByRole("tree", { name: "Files" })).toBeTruthy();
  });
});

describe("Files layout", () => {
  it("puts the tree beside the preview once the panel is wide", async () => {
    // happy-dom has no layout: report the width a ResizeObserver would.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        readonly callback: ResizeObserverCallback;
        constructor(callback: ResizeObserverCallback) {
          this.callback = callback;
        }
        observe(target: Element) {
          this.callback(
            [{ target, contentRect: { width: SIDE_BY_SIDE_MIN + 100 } } as ResizeObserverEntry],
            this as unknown as ResizeObserver,
          );
        }
        disconnect() {}
        unobserve() {}
      },
    );
    useFilesStore.getState().select(THREAD, `${ROOT}/package.json`);
    renderFiles();
    const split = await screen.findByRole("separator", { name: "Resize file tree" });
    expect(split.getAttribute("aria-orientation")).toBe("vertical");
    expect(parseFloat(screen.getByTestId("files-tree-pane").style.width)).toBeCloseTo(40);

    fireEvent.keyDown(split, { key: "ArrowRight" });
    expect(split.getAttribute("aria-valuenow")).toBe("45");
  });
});
