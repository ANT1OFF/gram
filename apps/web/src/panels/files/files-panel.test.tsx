// @vitest-environment happy-dom
import type { ThreadId } from "@gram/contracts";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMockApi } from "@/api/mock";
import type { Api } from "@/api/types";
import { renderWithApi } from "@/panels/test-utils";
import { useLayoutStore } from "@/stores/layout";

import { FilesPanel } from "./files-panel";
import { checkoutRelative, resetFilesStore, revealInFiles, useFilesStore } from "./files-store";

const THREAD = "t-flaky" as ThreadId;
/** The seeded `t-flaky` thread's checkout; thread-scoped paths must stay inside it. */
const ROOT = "/Users/dev/code/api/.worktrees/fix-flaky-retry";

const renderFiles = (api: Partial<Api> = createMockApi({ speed: 0, autoplay: false })) =>
  renderWithApi(<FilesPanel threadId={THREAD} root={ROOT} />, api);

const rootNames = () =>
  within(screen.getByRole("tree", { name: "Files" }))
    .getAllByRole("treeitem")
    .filter((item) => item.getAttribute("aria-level") === "1")
    .map((item) => item.getAttribute("aria-label"));

afterEach(() => {
  cleanup();
  resetFilesStore();
  useLayoutStore.setState({ panelTargets: {} });
});

const target = (id: number, path: string, threadId = THREAD) =>
  useLayoutStore.setState({ panelTargets: { files: { id, threadId, target: path } } });

describe("FilesPanel split", () => {
  it("resizes the tree with the keyboard, keeps the size per thread, and resets on double-click", async () => {
    useFilesStore.getState().select(THREAD, `${ROOT}/package.json`);
    renderFiles();
    const split = await screen.findByRole("separator", { name: "Resize file tree" });
    expect(split.getAttribute("aria-orientation")).toBe("horizontal");
    expect(split.getAttribute("aria-valuenow")).toBe("40");

    fireEvent.keyDown(split, { key: "ArrowDown" });
    fireEvent.keyDown(split, { key: "ArrowDown" });
    expect(split.getAttribute("aria-valuenow")).toBe("50");
    expect(parseFloat(screen.getByTestId("files-tree-pane").style.height)).toBeCloseTo(50);

    fireEvent.keyDown(split, { key: "End" });
    expect(split.getAttribute("aria-valuenow")).toBe("85");
    expect(useFilesStore.getState().treeShare).toEqual({ [THREAD]: 0.85 });
    expect(JSON.parse(localStorage.getItem("gram.files") ?? "{}")).toMatchObject({
      state: { treeShare: { [THREAD]: 0.85 } },
    });

    fireEvent.keyDown(split, { key: "Home" });
    expect(split.getAttribute("aria-valuenow")).toBe("15");
    fireEvent.doubleClick(split);
    expect(split.getAttribute("aria-valuenow")).toBe("40");
    expect(useFilesStore.getState().treeShare).toEqual({});
  });
});

describe("checkoutRelative", () => {
  it("keeps paths inside the checkout and drops the rest", () => {
    expect(checkoutRelative("src/retry.ts", ROOT)).toBe("src/retry.ts");
    expect(checkoutRelative("./src/retry.ts", undefined)).toBe("src/retry.ts");
    expect(checkoutRelative(`${ROOT}/src/retry.ts`, ROOT)).toBe("src/retry.ts");
    expect(checkoutRelative(`${ROOT}/src/retry.ts`, `${ROOT}/`)).toBe("src/retry.ts");
    expect(checkoutRelative(`${ROOT}-other/a.ts`, ROOT)).toBeUndefined();
    expect(checkoutRelative("/etc/passwd", ROOT)).toBeUndefined();
    expect(checkoutRelative("C:\\etc\\passwd", ROOT)).toBeUndefined();
    expect(checkoutRelative("../secrets.txt", ROOT)).toBeUndefined();
    expect(checkoutRelative(`${ROOT}/src/../../x`, ROOT)).toBeUndefined();
    expect(checkoutRelative(ROOT, ROOT)).toBeUndefined();
  });
});

describe("FilesPanel", () => {
  it("lists folders first and shows dotfiles on request", async () => {
    renderFiles();
    await screen.findByRole("treeitem", { name: "src" });
    expect(rootNames()).toEqual(["docs", "fixtures", "src", "latest", "package.json", "README.md"]);

    fireEvent.click(screen.getByRole("button", { name: "Show hidden & ignored" }));
    expect(await screen.findByRole("treeitem", { name: ".github" })).toBeTruthy();
    expect(screen.getByRole("treeitem", { name: "dist" })).toBeTruthy();
  });

  it("expands folders lazily and previews a file with highlighting", async () => {
    const api = createMockApi({ speed: 0, autoplay: false });
    const list = vi.spyOn(api, "fsList");
    renderFiles(api);
    const src = await screen.findByRole("treeitem", { name: "src" });
    expect(list).toHaveBeenCalledTimes(1);

    fireEvent.click(src);
    expect(src.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(await screen.findByRole("treeitem", { name: "retry.ts" }));
    expect(list).toHaveBeenLastCalledWith(`${ROOT}/src`, { threadId: THREAD, showHidden: false });

    const preview = await screen.findByTestId("file-preview");
    expect(within(preview).getByText("src/retry.ts")).toBeTruthy();
    await waitFor(() => expect(preview.textContent).toContain("export async function retry"));
    expect(preview.querySelector("code")?.className).toContain("counter-reset");
  });

  it("explains binary and too-large files", async () => {
    revealInFiles(THREAD, ROOT, `${ROOT}/docs/font.woff2`);
    renderFiles();
    expect(await screen.findByText("Binary file · 23.9 KB")).toBeTruthy();
    expect(await screen.findByRole("treeitem", { name: "font.woff2" })).toBeTruthy();

    act(() => useFilesStore.getState().select(THREAD, `${ROOT}/fixtures/recording.json`));
    expect(await screen.findByText("Too large to preview · 5.0 MB")).toBeTruthy();
  });

  it("previews images, with SVG only ever as an <img>", async () => {
    revealInFiles(THREAD, ROOT, `${ROOT}/docs/logo.png`);
    renderFiles();
    const png = await screen.findByTestId("checkout-image");
    expect(png.getAttribute("src")).toMatch(/^data:image\/png;base64,/);

    act(() => useFilesStore.getState().select(THREAD, `${ROOT}/docs/diagram.svg`));
    await waitFor(() =>
      expect(screen.getByTestId("checkout-image").getAttribute("src")).toMatch(
        /^data:image\/svg\+xml;base64,/,
      ),
    );
    expect(document.querySelector("svg script")).toBeNull();
    expect(Reflect.get(window, "__svgScriptRan")).toBeUndefined();
  });

  it("renders markdown with checkout links and images, and a Source toggle", async () => {
    revealInFiles(THREAD, ROOT, `${ROOT}/docs/architecture.md`);
    renderFiles();
    const preview = await screen.findByTestId("markdown-preview");
    await waitFor(() => expect(within(preview).getAllByTestId("checkout-image")).toHaveLength(2));
    // In a browser an external link has no href to middle-click past the link dialog.
    expect(within(preview).getByRole("button", { name: "upstream docs" }).title).toBe(
      "https://organization.example.invalid/docs",
    );

    fireEvent.click(within(preview).getByRole("link", { name: "retry" }));
    expect(useFilesStore.getState().byThread[THREAD]?.selected).toBe(`${ROOT}/src/retry.ts`);

    act(() => useFilesStore.getState().select(THREAD, `${ROOT}/docs/architecture.md`));
    fireEvent.click(await screen.findByRole("radio", { name: "Source" }));
    await waitFor(() =>
      expect(screen.getByTestId("file-preview").querySelector("code")?.textContent).toContain(
        "![Logo](logo.png)",
      ),
    );
  });

  it("filters files by name and moves with the keyboard", async () => {
    renderFiles();
    const src = await screen.findByRole("treeitem", { name: "src" });
    fireEvent.change(screen.getByRole("textbox", { name: "Filter files" }), {
      target: { value: "retry" },
    });
    expect(rootNames()).toEqual(["docs", "fixtures", "src"]);

    src.focus();
    fireEvent.keyDown(src, { key: "ArrowRight" });
    await screen.findByRole("treeitem", { name: "retry.ts" });
    fireEvent.keyDown(src, { key: "ArrowDown" });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("retry.test.ts");
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    expect(await screen.findByText("src/retry.test.ts")).toBeTruthy();
  });

  it("previews an agent's target file and consumes the target", async () => {
    target(201, "src/retry.ts");
    renderFiles();
    const preview = await screen.findByTestId("file-preview");
    expect(within(preview).getByText("src/retry.ts")).toBeTruthy();
    expect(useFilesStore.getState().byThread[THREAD]?.selected).toBe(`${ROOT}/src/retry.ts`);
    expect(useLayoutStore.getState().panelTargets.files).toBeUndefined();

    act(() => target(202, `${ROOT}/README.md`));
    await waitFor(() =>
      expect(within(screen.getByTestId("file-preview")).getByText("README.md")).toBeTruthy(),
    );
    expect(useFilesStore.getState().byThread[THREAD]?.selected).toBe(`${ROOT}/README.md`);
  });

  it("ignores a target for another thread, and leaves one outside the checkout to the server", async () => {
    target(203, "src/retry.ts", "t-other" as ThreadId);
    renderFiles();
    await screen.findByRole("treeitem", { name: "src" });
    expect(useLayoutStore.getState().panelTargets.files?.id).toBe(203);
    expect(useFilesStore.getState().byThread[THREAD]?.selected).toBeUndefined();

    // Such as a report the agent wrote to a temp folder: `fs.file` decides whether it shows.
    act(() => target(204, "/tmp/report/REPORT.md"));
    await waitFor(() => expect(useLayoutStore.getState().panelTargets.files).toBeUndefined());
    expect(useFilesStore.getState().byThread[THREAD]?.selected).toBe("/tmp/report/REPORT.md");
    act(() => target(205, "../outside.md"));
    await waitFor(() => expect(useLayoutStore.getState().panelTargets.files).toBeUndefined());
    expect(useFilesStore.getState().byThread[THREAD]?.selected).toBe("/tmp/report/REPORT.md");
  });

  it("explains when the server has no Files support yet", async () => {
    const notImplemented = Object.assign(new Error("fs.list"), { _tag: "NotImplemented" });
    renderFiles({
      fsList: vi.fn(async () => {
        throw notImplemented;
      }),
    });
    expect(await screen.findByText("Files aren't available on this server yet.")).toBeTruthy();
  });
});
