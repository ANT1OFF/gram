// @vitest-environment happy-dom
import type { ThreadId } from "@gram/contracts";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createMockApi } from "@/api/mock";
import { renderWithApi } from "@/panels/test-utils";
import { useLayoutStore } from "@/stores/layout";

import { FilesPanel } from "./files-panel";
import { resetFilesStore } from "./files-store";

const THREAD = "t-flaky" as ThreadId;
const ROOT = "/Users/dev/code/api/.worktrees/fix-flaky-retry";

const renderFiles = () =>
  renderWithApi(
    <FilesPanel threadId={THREAD} root={ROOT} />,
    createMockApi({ speed: 0, autoplay: false }),
  );

const items = () => within(screen.getByRole("tree", { name: "Files" })).getAllByRole("treeitem");
const focusedName = () => document.activeElement?.getAttribute("aria-label");

afterEach(() => {
  cleanup();
  resetFilesStore();
  useLayoutStore.setState({ panelTargets: {} });
});

describe("Files tree keyboard", () => {
  it("is one Tab stop that ↑ ↓ Home End move through", async () => {
    renderFiles();
    await screen.findByRole("treeitem", { name: "src" });
    await waitFor(() => expect(items().filter((item) => item.tabIndex === 0)).toHaveLength(1));

    const first = items()[0]!;
    first.focus();
    fireEvent.keyDown(first, { key: "End" });
    expect(focusedName()).toBe(items().at(-1)!.getAttribute("aria-label"));
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(items()[0]);
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items()[1]);
    await waitFor(() => expect(items()[1]!.tabIndex).toBe(0));
    expect(items().filter((item) => item.tabIndex === 0)).toHaveLength(1);
  });

  it("steps into an open folder with → and back to its parent with ←", async () => {
    renderFiles();
    const src = await screen.findByRole("treeitem", { name: "src" });
    src.focus();
    fireEvent.keyDown(src, { key: "ArrowRight" });
    await screen.findByRole("treeitem", { name: "retry.ts" });

    fireEvent.keyDown(src, { key: "ArrowRight" });
    const child = document.activeElement as HTMLElement;
    expect(child.getAttribute("aria-level")).toBe("2");
    fireEvent.keyDown(child, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(src);
    fireEvent.keyDown(src, { key: "ArrowLeft" });
    expect(src.getAttribute("aria-expanded")).toBe("false");
  });

  it("moves from the filter into the tree with ↓", async () => {
    renderFiles();
    await screen.findByRole("treeitem", { name: "src" });
    await waitFor(() => expect(items().some((item) => item.tabIndex === 0)).toBe(true));
    const filter = screen.getByRole("textbox", { name: "Filter files" });
    filter.focus();
    fireEvent.keyDown(filter, { key: "ArrowDown" });
    expect(document.activeElement?.getAttribute("role")).toBe("treeitem");
  });

  it("closes the preview on Escape and gives focus back to the file's row", async () => {
    renderFiles();
    const src = await screen.findByRole("treeitem", { name: "src" });
    fireEvent.click(src);
    const file = await screen.findByRole("treeitem", { name: "retry.ts" });
    file.focus();
    fireEvent.keyDown(file, { key: "Enter" });
    const preview = await screen.findByTestId("file-preview");

    within(preview).getByRole("button", { name: "Close preview" }).focus();
    fireEvent.keyDown(within(preview).getByRole("button", { name: "Close preview" }), {
      key: "Escape",
    });
    await waitFor(() => expect(screen.queryByTestId("file-preview")).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("treeitem", { name: "retry.ts" })),
    );
  });
});
