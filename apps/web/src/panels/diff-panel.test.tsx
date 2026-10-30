// @vitest-environment happy-dom
import { NotImplemented, type Diff, type DiffScope, type ThreadId } from "@gram/contracts";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mockDiff } from "@/api/mock-git";
import { dispatchShortcut } from "@/keyboard/registry";
import { useDiffCommentsStore } from "@/stores/diff-comments";
import { useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";

import { DiffPanel } from "./diff-panel";
import { ROW_BUDGET } from "./patch-view";
import { resetFilesStore, useFilesStore } from "./files/files-store";
import { Remount, renderWithApi } from "./test-utils";

const T = "t-flaky" as ThreadId;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useThreadsStore.setState({ byId: {} });
  useLayoutStore.setState({ panelTargets: {}, diffLayout: "unified", diffTreeShown: true });
  resetFilesStore();
  useDiffCommentsStore.setState({ byThread: {} });
});

const expandedPaths = () =>
  screen
    .getAllByTestId("diff-file")
    .filter(
      (row) => within(row).getAllByRole("button")[0]!.getAttribute("aria-expanded") === "true",
    )
    .map((row) => row.querySelector("[title]")?.getAttribute("title"));

/** A panel wide enough for the file tree, which a narrow one leaves to the file list. */
const widePanel = () =>
  vi.stubGlobal(
    "ResizeObserver",
    class {
      readonly callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }
      observe() {
        this.callback([{ contentRect: { width: 900 } } as ResizeObserverEntry], this as never);
      }
      disconnect() {}
    },
  );

describe("DiffPanel", () => {
  it("lists files in the tree's order with text status labels and renders their patches", async () => {
    const gitDiff = vi.fn(async (threadId: ThreadId) => {
      const diff = mockDiff(threadId, { kind: "uncommitted" });
      // A file git gave up on, alongside the mock's own.
      const huge = { path: "vendor.js", status: "added", additions: 0, deletions: 0 } as const;
      return {
        ...diff,
        files: [...diff.files!, { ...huge, patch: "", binary: false, tooLarge: true }],
      };
    });
    renderWithApi(<DiffPanel threadId={T} />, { gitDiff });

    const files = await screen.findAllByTestId("diff-file");
    expect(files.map((row) => row.dataset["path"])).toEqual([
      "assets/retry-timeline.png",
      "docs/testing.md",
      "src/clock.ts",
      "src/retry.test.ts",
      "pnpm-lock.yaml",
      "vendor.js",
    ]);
    const list = screen.getByTestId("diff-files");
    expect(within(files[3]!).getByText("Modified")).toBeTruthy();
    expect(within(files[1]!).getByText("Untracked")).toBeTruthy();
    expect(within(files[2]!).getByText("src/timers.ts → src/clock.ts")).toBeTruthy();
    expect(gitDiff).toHaveBeenCalledWith(T, { kind: "uncommitted" });

    // More than three files start collapsed, and render nothing until opened.
    expect(within(list).queryAllByTestId("patch")).toHaveLength(0);
    fireEvent.click(within(files[3]!).getAllByRole("button")[0]!);
    expect(within(files[3]!).getAllByRole("button")[0]!.getAttribute("aria-expanded")).toBe("true");
    expect(within(files[3]!).getByText("await clock.tickAsync(100);")).toBeTruthy();
    fireEvent.click(within(files[0]!).getAllByRole("button")[0]!);
    expect(within(files[0]!).getByText("Binary file not shown")).toBeTruthy();
    fireEvent.click(within(files[5]!).getAllByRole("button")[0]!);
    expect(within(files[5]!).getByText("Diff too large to display")).toBeTruthy();
  });

  it("renders the first rows of a long patch and offers the rest", async () => {
    renderWithApi(<DiffPanel threadId={T} />, {
      gitDiff: vi.fn(async (threadId: ThreadId) => mockDiff(threadId, { kind: "uncommitted" })),
    });
    const lockfile = (await screen.findAllByTestId("diff-file")).find(
      (row) => row.dataset["path"] === "pnpm-lock.yaml",
    )!;
    fireEvent.click(within(lockfile).getAllByRole("button")[0]!);
    const rows = () => lockfile.querySelectorAll("tr").length;
    expect(rows()).toBe(ROW_BUDGET);
    // 16 hunks of a header and 178 lines, less the budget.
    fireEvent.click(within(lockfile).getByRole("button", { name: "Show 2,464 more lines" }));
    expect(rows()).toBe(16 * 179);
  });

  it("jumps to a file from the tree and steps through hunks with n and p", async () => {
    widePanel();
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    const { container } = renderWithApi(<DiffPanel threadId={T} />, {
      gitDiff: vi.fn(async (threadId: ThreadId) => mockDiff(threadId, { kind: "uncommitted" })),
    });
    await screen.findAllByTestId("diff-file");
    const tree = screen.getByRole("tree", { name: "Changed files" });
    fireEvent.click(within(tree).getByRole("treeitem", { name: "retry.test.ts" }));
    expect(expandedPaths()).toEqual(["src/retry.test.ts"]);
    expect(
      within(tree).getByRole("treeitem", { name: "retry.test.ts" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(scroll).toHaveBeenCalled();

    const press = (key: string) =>
      act(() => {
        container.querySelector<HTMLElement>("[data-diff-file-header]")!.focus();
        dispatchShortcut(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      });
    // n goes on from the file the tree jumped to, into the lockfile after it, and p comes back.
    press("n");
    const current = () =>
      [...container.querySelectorAll("[data-hunk][data-current]")].map((row) => [
        row.closest<HTMLElement>("[data-testid='diff-file']")!.dataset["path"],
        row.getAttribute("data-hunk"),
      ]);
    expect(current()).toEqual([["src/retry.test.ts", "0"]]);
    press("n");
    expect(current()).toEqual([["pnpm-lock.yaml", "0"]]);
    expect(expandedPaths()).toEqual(["src/retry.test.ts", "pnpm-lock.yaml"]);
    press("p");
    expect(current()).toEqual([["src/retry.test.ts", "0"]]);
  });

  it("steps on from a file without hunks, and forgets the step when the scope changes", async () => {
    widePanel();
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    const logo = { path: "src/logo.png", status: "added", additions: 0, deletions: 0 } as const;
    const last = { path: "zz.bin", status: "added", additions: 0, deletions: 0 } as const;
    const { container } = renderWithApi(<DiffPanel threadId={T} />, {
      gitDiff: vi.fn(async (threadId: ThreadId, scope: DiffScope) => {
        const diff = mockDiff(threadId, scope);
        return scope.kind === "branch"
          ? diff
          : {
              ...diff,
              files: [
                ...diff.files!,
                ...[logo, last].map((f) => ({ ...f, patch: "", binary: true, tooLarge: false })),
              ],
            };
      }),
    });
    await screen.findAllByTestId("diff-file");
    const tree = screen.getByRole("tree", { name: "Changed files" });
    const press = (key: string) =>
      act(() => {
        container.querySelector<HTMLElement>("[data-diff-file-header]")!.focus();
        dispatchShortcut(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      });
    const current = () =>
      [...container.querySelectorAll("[data-hunk][data-current]")].map(
        (row) => row.closest<HTMLElement>("[data-testid='diff-file']")!.dataset["path"],
      );
    // The logo has no hunks: n goes on to the next file that has one, not back to the first.
    fireEvent.click(within(tree).getByRole("treeitem", { name: "logo.png" }));
    press("n");
    expect(current()).toEqual(["src/retry.test.ts"]);
    // p from the logo lands on the hunk just before it.
    fireEvent.click(within(tree).getByRole("treeitem", { name: "logo.png" }));
    press("p");
    expect(current()).toEqual(["src/clock.ts"]);
    // After the last hunk, n has nowhere to go and p takes the last one.
    fireEvent.click(within(tree).getByRole("treeitem", { name: "zz.bin" }));
    press("n");
    expect(current()).toEqual([]);
    press("p");
    expect(current()).toEqual(["pnpm-lock.yaml"]);

    fireEvent.click(screen.getByRole("radio", { name: "Branch" }));
    await waitFor(() => expect(screen.getAllByTestId("diff-file")).toHaveLength(1));
    expect(current()).toEqual([]);
    press("n");
    expect(current()).toEqual(["src/retry.test.ts"]);
  });

  it("picks lines from their numbers and turns them into a draft comment", async () => {
    const docs = "t-docs" as ThreadId;
    const { container } = renderWithApi(<DiffPanel threadId={docs} />, {
      gitDiff: vi.fn(async (threadId: ThreadId, scope: DiffScope) => mockDiff(threadId, scope)),
    });
    await screen.findByTestId("patch");
    const gutter = (line: string) =>
      container.querySelector<HTMLElement>(`[data-gutter="0:${line}"]`)!;
    fireEvent.pointerDown(gutter("1"), { button: 0 });
    fireEvent.pointerDown(gutter("3"), { button: 0, shiftKey: true });
    expect(container.querySelectorAll("[data-picked]")).toHaveLength(6);

    fireEvent.click(screen.getByRole("button", { name: "Comment on lines 1-3" }));
    const editor = screen.getByRole("textbox", { name: "Comment on lines 1-3" });
    fireEvent.change(editor, { target: { value: "Say where to run it." } });
    fireEvent.keyDown(editor, { key: "Enter", metaKey: true });

    expect(useDiffCommentsStore.getState().byThread[docs]).toMatchObject([
      {
        path: "README.md",
        side: "new",
        start: 1,
        end: 3,
        snippet: "+# Getting started\n+\n+Install with `pnpm add @example/api`.",
        note: "Say where to run it.",
      },
    ]);
    expect(container.querySelectorAll("[data-picked]")).toHaveLength(0);
    expect(screen.getByTestId("diff-comment").textContent).toContain("Say where to run it.");
  });

  it("drops a stale pick, and hides a draft whose lines changed, when the diff refreshes", async () => {
    const docs = "t-docs" as ThreadId;
    let rewritten = false;
    const { container } = renderWithApi(<DiffPanel threadId={docs} />, {
      gitDiff: vi.fn(async (threadId: ThreadId, scope: DiffScope) => {
        const diff = mockDiff(threadId, scope);
        const [readme] = diff.files!;
        // Same numbers, other words: the agent rewrote the lines the draft is about.
        const patch = readme!.patch.replace("Getting started", "Quick start");
        return rewritten ? { ...diff, files: [{ ...readme!, patch }] } : diff;
      }),
      refreshGit: vi.fn(async () => {}),
    });
    await screen.findByTestId("patch");
    const gutter = (line: string) =>
      container.querySelector<HTMLElement>(`[data-gutter="0:${line}"]`)!;
    fireEvent.pointerDown(gutter("1"), { button: 0 });
    fireEvent.click(screen.getByRole("button", { name: "Comment on line 1" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Shorter title." } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", metaKey: true });
    fireEvent.pointerDown(gutter("5"), { button: 0 });
    expect(screen.getByTestId("diff-comment")).toBeTruthy();
    expect(container.querySelectorAll("[data-picked]")).not.toHaveLength(0);

    rewritten = true;
    fireEvent.click(screen.getByRole("button", { name: "Refresh diff" }));
    await waitFor(() => expect(screen.getByText("Quick start", { exact: false })).toBeTruthy());
    expect(container.querySelectorAll("[data-picked]")).toHaveLength(0);
    expect(screen.queryByTestId("diff-comment")).toBeNull();
    // The draft itself stays, for its chip and the next message.
    expect(useDiffCommentsStore.getState().byThread[docs]).toHaveLength(1);
  });

  it("keeps a draft's note under a range that ends on a removed line", async () => {
    widePanel();
    const { container } = renderWithApi(<DiffPanel threadId={T} />, {
      gitDiff: vi.fn(async (threadId: ThreadId) => mockDiff(threadId, { kind: "uncommitted" })),
    });
    await screen.findAllByTestId("diff-file");
    fireEvent.click(screen.getByRole("treeitem", { name: "retry.test.ts" }));
    const retry = container.querySelector("[data-path='src/retry.test.ts']")!;
    // A context line, then the removed `await sleep(100);`: numbered by the context line alone.
    fireEvent.pointerDown(retry.querySelector("[data-gutter='0:3']")!, { button: 0 });
    fireEvent.pointerDown(retry.querySelector("[data-gutter='0:4']")!, {
      button: 0,
      shiftKey: true,
    });
    fireEvent.click(screen.getByRole("button", { name: "Comment on line 15" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Why not await?" } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", metaKey: true });
    expect(within(retry as HTMLElement).getByTestId("diff-comment").textContent).toContain(
      "Why not await?",
    );
  });

  it("keeps a drag's pick in the patch it started in", async () => {
    renderWithApi(<DiffPanel threadId={T} />, {
      gitDiff: vi.fn(async (threadId: ThreadId) => mockDiff(threadId, { kind: "uncommitted" })),
    });
    const files = await screen.findAllByTestId("diff-file");
    const [clock, retry] = ["src/clock.ts", "src/retry.test.ts"].map((path) =>
      files.find((row) => row.dataset["path"] === path)!,
    );
    fireEvent.click(within(clock!).getAllByRole("button")[0]!);
    fireEvent.click(within(retry!).getAllByRole("button")[0]!);
    fireEvent.pointerDown(clock!.querySelector("[data-gutter='0:0']")!, { button: 0 });
    fireEvent.pointerOver(retry!.querySelector("[data-gutter='0:2']")!, { buttons: 1 });
    expect(retry!.querySelectorAll("[data-picked]")).toHaveLength(0);
    expect(clock!.querySelectorAll("[data-picked]")).toHaveLength(2);
    fireEvent.pointerUp(window);
  });

  it("unmounts a collapsed file's patch", async () => {
    renderWithApi(<DiffPanel threadId={"t-docs" as ThreadId} />, {
      gitDiff: vi.fn(async (threadId: ThreadId, scope: DiffScope) => mockDiff(threadId, scope)),
    });
    const [file] = await screen.findAllByTestId("diff-file");
    expect(within(file!).getByTestId("patch")).toBeTruthy();
    fireEvent.click(within(file!).getAllByRole("button")[0]!);
    await waitFor(() => expect(within(file!).queryByTestId("patch")).toBeNull());
  });

  it("shows split view only when the panel is wide enough for it", async () => {
    let width = 400;
    const observers: Array<() => void> = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        readonly callback: ResizeObserverCallback;
        constructor(callback: ResizeObserverCallback) {
          this.callback = callback;
        }
        observe() {
          const report = () =>
            this.callback([{ contentRect: { width } } as ResizeObserverEntry], this as never);
          observers.push(report);
          report();
        }
        disconnect() {}
      },
    );
    useLayoutStore.setState({ diffLayout: "split", diffTreeShown: true });
    renderWithApi(<DiffPanel threadId={"t-docs" as ThreadId} />, {
      gitDiff: vi.fn(async (threadId: ThreadId, scope: DiffScope) => mockDiff(threadId, scope)),
    });
    await screen.findAllByTestId("diff-file");
    const panel = screen.getByTestId("diff-panel");
    expect(panel.dataset["layout"]).toBe("unified");
    expect(screen.getByRole("radio", { name: "Split" }).getAttribute("title")).toMatch(/wider/);

    width = 700;
    act(() => observers.forEach((report) => report()));
    expect(panel.dataset["layout"]).toBe("split");
    // One file gets no tree, so a width that would hold the tree beside it all goes to the patch.
    width = 740;
    act(() => observers.forEach((report) => report()));
    expect(panel.dataset["layout"]).toBe("split");
    expect(screen.getByTestId("patch").dataset["layout"]).toBe("split");

    fireEvent.click(screen.getByRole("radio", { name: "Unified" }));
    expect(useLayoutStore.getState().diffLayout).toBe("unified");
    expect(panel.dataset["layout"]).toBe("unified");
    vi.unstubAllGlobals();
  });

  it("reveals a changed file in the Files panel", async () => {
    const root = "/Users/dev/code/api/.worktrees/fix-flaky-retry";
    useThreadsStore.setState({ byId: { [T]: { thread: { checkout: { path: root } } } as never } });
    renderWithApi(<DiffPanel threadId={T} />, {
      gitDiff: vi.fn(async (threadId: ThreadId) => mockDiff(threadId, { kind: "uncommitted" })),
    });

    const [first] = await screen.findAllByTestId("diff-file");
    const reveal = within(first!).getByRole("button", { name: /^Show .+ in Files$/ });
    const path = reveal.getAttribute("aria-label")!.replace(/^Show (.+) in Files$/, "$1");
    fireEvent.click(reveal);
    expect(useFilesStore.getState().byThread[T]?.selected).toBe(`${root}/${path}`);
    expect(useLayoutStore.getState().panelTab).toBe("files");
  });

  it("expands and scrolls to an agent's target file, then consumes the target", async () => {
    const root = "/Users/dev/code/api/.worktrees/fix-flaky-retry";
    useThreadsStore.setState({ byId: { [T]: { thread: { checkout: { path: root } } } as never } });
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    useLayoutStore.setState({
      panelTargets: { diff: { id: 101, threadId: T, target: `${root}/src/clock.ts` } },
    });
    renderWithApi(<DiffPanel threadId={T} />, {
      gitDiff: vi.fn(async (threadId: ThreadId) => mockDiff(threadId, { kind: "uncommitted" })),
    });

    await screen.findAllByTestId("diff-file");
    expect(expandedPaths()).toEqual(["src/clock.ts"]);
    expect(scroll).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(useLayoutStore.getState().panelTargets.diff).toBeUndefined());

    act(() =>
      useLayoutStore.setState({
        panelTargets: { diff: { id: 102, threadId: T, target: "./src/retry.test.ts" } },
      }),
    );
    await waitFor(() => expect(expandedPaths()).toEqual(["src/clock.ts", "src/retry.test.ts"]));
    expect(scroll).toHaveBeenCalledTimes(2);
  });

  it("just shows the diff for an absent target and ignores another thread's target", async () => {
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    const other = { id: 103, threadId: "t-other" as ThreadId, target: "src/clock.ts" };
    useLayoutStore.setState({ panelTargets: { diff: other } });
    renderWithApi(<DiffPanel threadId={T} />, {
      gitDiff: vi.fn(async (threadId: ThreadId) => mockDiff(threadId, { kind: "uncommitted" })),
    });
    await screen.findAllByTestId("diff-file");
    expect(expandedPaths()).toEqual([]);
    expect(useLayoutStore.getState().panelTargets.diff).toBe(other);

    act(() =>
      useLayoutStore.setState({
        panelTargets: { diff: { id: 104, threadId: T, target: "src/missing.ts" } },
      }),
    );
    await waitFor(() => expect(useLayoutStore.getState().panelTargets.diff).toBeUndefined());
    expect(expandedPaths()).toEqual([]);
    expect(scroll).not.toHaveBeenCalled();
  });

  it("switches to the branch scope and shows the base", async () => {
    const gitDiff = vi.fn(async (threadId: ThreadId, scope: { kind: "uncommitted" | "branch" }) =>
      mockDiff(threadId, scope),
    );
    renderWithApi(<DiffPanel threadId={T} />, { gitDiff });
    await screen.findAllByTestId("diff-file");

    fireEvent.click(screen.getByRole("radio", { name: "Branch" }));
    expect(await screen.findByText("comparing to origin/main")).toBeTruthy();
    expect(gitDiff).toHaveBeenLastCalledWith(T, { kind: "branch" });
  });

  it("leaves a narrow panel to the file list, without the tree above it", async () => {
    renderWithApi(<DiffPanel threadId={T} />, {
      gitDiff: vi.fn(async (threadId: ThreadId) => mockDiff(threadId, { kind: "uncommitted" })),
    });
    await screen.findAllByTestId("diff-file");
    expect(screen.queryByRole("tree")).toBeNull();
    expect(screen.queryByRole("button", { name: "File tree" })).toBeNull();
  });

  it("says when a clean tree falls back to the branch", async () => {
    renderWithApi(<DiffPanel threadId={"t-docs" as ThreadId} />, {
      gitDiff: vi.fn(async (threadId: ThreadId, scope: DiffScope) => mockDiff(threadId, scope)),
    });

    expect((await screen.findByTestId("diff-fallback")).textContent).toBe(
      "No uncommitted changes. Showing branch vs main",
    );
    expect(screen.getAllByTestId("diff-file")).toHaveLength(1);
    expect(screen.queryByText("comparing to origin/main")).toBeNull();
    expect(screen.queryByText("No changes")).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: "Branch" }));
    expect(await screen.findByText("comparing to origin/main")).toBeTruthy();
    expect(screen.queryByTestId("diff-fallback")).toBeNull();
  });

  it("refreshes git state and refetches from the button and the shortcut", async () => {
    const gitDiff = vi.fn(async (threadId: ThreadId, scope: DiffScope) =>
      mockDiff(threadId, scope),
    );
    const refreshGit = vi.fn(async () => {});
    renderWithApi(<DiffPanel threadId={T} />, { gitDiff, refreshGit });
    await screen.findAllByTestId("diff-file");
    expect(gitDiff).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Refresh diff" }));
    await waitFor(() => expect(gitDiff).toHaveBeenCalledTimes(2));
    expect(refreshGit).toHaveBeenCalledWith(T);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Refresh diff" }).hasAttribute("disabled")).toBe(
        false,
      ),
    );

    const shortcut = new KeyboardEvent("keydown", {
      key: "r",
      code: "KeyR",
      metaKey: true,
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => void dispatchShortcut(shortcut, true));
    await waitFor(() => expect(gitDiff).toHaveBeenCalledTimes(3));
    expect(refreshGit).toHaveBeenCalledTimes(2);
  });

  it("reuses the diff on a remount until git state moves its stamp", async () => {
    const git = { changesToken: "a", behindBase: 0, aheadBase: 1, base: "origin/main" };
    const setGit = (changes: Partial<typeof git>) =>
      act(() =>
        useThreadsStore.setState({
          byId: {
            [T]: { thread: { checkout: { path: "/repo" } }, git: { ...git, ...changes } } as never,
          },
        }),
      );
    setGit({});
    const gitDiff = vi.fn(async (threadId: ThreadId, scope: DiffScope) =>
      mockDiff(threadId, scope),
    );
    renderWithApi(
      <Remount>
        <DiffPanel threadId={T} />
      </Remount>,
      { gitDiff },
    );
    await screen.findAllByTestId("diff-file");
    fireEvent.click(screen.getByRole("button", { name: "Remount" }));
    await screen.findAllByTestId("diff-file");
    expect(gitDiff).toHaveBeenCalledTimes(1);

    setGit({ changesToken: "b" });
    await waitFor(() => expect(gitDiff).toHaveBeenCalledTimes(2));
    setGit({ changesToken: "b", behindBase: 1 });
    await waitFor(() => expect(gitDiff).toHaveBeenCalledTimes(3));

    // Not for long: an edit inside an untracked directory moves the diff but not the stamp.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 31_000);
      fireEvent.click(screen.getByRole("button", { name: "Remount" }));
      await waitFor(() => expect(gitDiff).toHaveBeenCalledTimes(4));
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a friendly state when the server hasn't implemented git.diff", async () => {
    const gitDiff = vi.fn(async (): Promise<Diff> => {
      throw new NotImplemented({ rpc: "git.diff" });
    });
    renderWithApi(<DiffPanel threadId={T} />, { gitDiff });
    expect(await screen.findByText("The diff isn't available yet.")).toBeTruthy();
  });

  it("explains a checkout outside git and an empty diff", async () => {
    const gitDiff = vi.fn(async (): Promise<Diff> => ({ repo: false }));
    renderWithApi(<DiffPanel threadId={T} />, { gitDiff });
    expect(await screen.findByText("Not a git repository")).toBeTruthy();

    cleanup();
    renderWithApi(<DiffPanel threadId={T} />, {
      gitDiff: vi.fn(async (): Promise<Diff> => ({ repo: true, branch: "main", files: [] })),
    });
    expect((await screen.findByTestId("diff-empty")).textContent).toBe("No changes on main");
  });
});
