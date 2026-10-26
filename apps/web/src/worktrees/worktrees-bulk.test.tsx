// @vitest-environment happy-dom
import type {
  GitState,
  ThreadId,
  ThreadSummary,
  WorkspaceId,
  WorktreeEntry,
} from "@gram/contracts";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { seedSummaries } from "@/api/mock-scripts";
import type { CloseThreadOptions, RemoveWorktreeOptions } from "@/api/types";
import { renderWithApi } from "@/panels/test-utils";
import { useThreadsStore } from "@/stores/threads";

import { finishedWorker } from "./finished-worker";
import { WorktreesDialog } from "./worktrees-dialog";

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
}));

const entry = (branch: string, overrides: Partial<WorktreeEntry> = {}): WorktreeEntry => ({
  path: `/r/.worktrees/${branch}`,
  branch,
  detached: false,
  isMain: false,
  isOpen: false,
  lastActivity: 0,
  ...overrides,
});

const CLEAN: GitState = {
  repo: true,
  worktree: true,
  head: "abc",
  changesToken: "clean",
  changedFiles: 0,
  behindBase: 0,
  aheadBase: 0,
  conflicts: false,
};

const GIB = 1024 ** 3;

const finished = (summary: ThreadSummary | undefined, detail?: string) =>
  finishedWorker(summary, detail);

/** A worker whose worktree is `/r/.worktrees/<branch>`, at rest and archived unless overridden. */
const worker = (
  branch: string,
  overrides: Partial<ThreadSummary["thread"]> = {},
  summary: Partial<ThreadSummary> = {},
): ThreadSummary => {
  const [template] = seedSummaries();
  const thread = template!.thread;
  return {
    ...template!,
    status: "idle",
    pendingRequests: [],
    thread: {
      ...thread,
      id: `t-${branch}` as ThreadId,
      title: `Worker ${branch}`,
      checkout: { kind: "worktree", path: `/r/.worktrees/${branch}`, branch, repoRoot: "/r" },
      workspaceId: "w-1" as WorkspaceId,
      spawnedBy: { threadId: "t-orchestrator" as ThreadId, feature: branch },
      parked: true,
      ...overrides,
    },
    ...summary,
  };
};

const MERGED: GitState["pr"] = {
  number: 7,
  state: "MERGED",
  url: "https://github.com/o/r/pull/7",
  title: "Merged",
  isDraft: false,
  checks: "passing",
  headMatches: true,
  aheadOfPr: false,
  baseRef: "main",
  headRef: "merged",
};

/**
 * A repo with the main checkout, two unused worktrees (`b` dirty when asked), one open in a
 * thread, and `busy`'s neighbours `done` and `shipped`, used by an archived and a merged worker.
 */
function fakeApi({ dirtyB = false } = {}) {
  const removed = new Set<string>();
  const calls: { path: string; options: RemoveWorktreeOptions }[] = [];
  const closes: { threadId: ThreadId; options: CloseThreadOptions | undefined }[] = [];
  return {
    calls,
    closes,
    api: {
      listWorktrees: vi.fn(async () => ({
        repoTop: "/r",
        worktrees: [
          entry("main", { path: "/r", isMain: true }),
          entry("a"),
          entry("b"),
          entry("busy", { isOpen: true }),
          entry("done", { isOpen: true }),
          entry("shipped", { isOpen: true }),
        ].filter((w) => !removed.has(w.path)),
      })),
      worktreeSize: vi.fn(async () => ({ bytes: 1.5 * GIB, partial: false })),
      closeThread: vi.fn(async (threadId: ThreadId, options?: CloseThreadOptions) => {
        closes.push({ threadId, options });
        removed.add(`/r/.worktrees/${threadId.slice(2)}`);
        return {};
      }),
      worktreeStatus: vi.fn(async () => CLEAN),
      worktreePendingPermissions: vi.fn(async (path: string) =>
        path.endsWith("/a") ? ["Bash(npm test)", "WebFetch(domain:github.com)"] : [],
      ),
      removeWorktree: vi.fn(async (path: string, options: RemoveWorktreeOptions) => {
        calls.push({ path, options });
        if (dirtyB && path.endsWith("/b") && !options.force) {
          throw Object.assign(new Error("dirty"), { _tag: "WorktreeDirty", path, changedFiles: 3 });
        }
        removed.add(path);
        return {};
      }),
    },
  };
}

afterEach(() => {
  cleanup();
  useThreadsStore.setState({ byId: {} });
});

const row = (name: string) => screen.getByRole("listitem", { name });

describe("finishedWorker", () => {
  it("reads an archived worker, and a merged one by its badge or its completion", () => {
    expect(finished(worker("a"))).toBe("archived");
    expect(finished(worker("a", { parked: false }, { git: { ...CLEAN, pr: MERGED } }))).toBe(
      "merged",
    );
    expect(finished(worker("a", { parked: false, completedReason: "prMerged" }))).toBe("merged");
    expect(finished(worker("a", {}, { status: "cold" }))).toBe("archived");
  });

  it("never reads a plain thread, a busy worker, or one spanning repos as finished", () => {
    const { spawnedBy: _, ...plain } = worker("a").thread;
    expect(finished(undefined)).toBeUndefined();
    expect(finished({ ...worker("a"), thread: plain })).toBeUndefined();
    expect(finished(worker("a", { role: "orchestrator" }))).toBeUndefined();
    expect(finished(worker("a", { parked: false }))).toBeUndefined();
    expect(
      finished(
        worker("a", { parked: false }, { git: { ...CLEAN, pr: { ...MERGED, state: "OPEN" } } }),
      ),
    ).toBeUndefined();
    for (const status of ["running", "starting", "needsApproval", "needsInput", "error"] as const) {
      expect(finished(worker("a", {}, { status }))).toBeUndefined();
    }
    const [request] = seedSummaries().flatMap((s) => s.pendingRequests);
    expect(finished(worker("a", {}, { pendingRequests: [request!] }))).toBeUndefined();
    const extra = { kind: "worktree", path: "/other/.worktrees/a", branch: "a" } as const;
    expect(finished(worker("a", { extraCheckouts: [extra] }))).toBeUndefined();
  });

  it("never reads an idle worker as finished while something of it still runs", () => {
    const shell = { taskId: "b1", kind: "shell", description: "dev server", startedAt: 0 } as const;
    expect(finished(worker("a", {}, { background: [shell] }))).toBeUndefined();
    const program = { terminalId: "term-1", pid: 42, command: "pnpm dev", startedAt: 0 };
    expect(finished(worker("a", {}, { terminalProcesses: [program] } as never))).toBeUndefined();
    expect(finished(worker("a", {}, { activity: "Explore: reading src…" }))).toBeUndefined();
    // The live status line wins over the snapshot's, either way.
    expect(finished(worker("a", {}, { status: "idle" }), "Explore: reading src…")).toBeUndefined();
    expect(finished(worker("a", {}, { status: "idle", activity: "Explore…" }), "")).toBe(
      "archived",
    );
  });
});

describe("WorktreesDialog bulk removal", () => {
  it("leaves a worker that got busy while an earlier worktree was going", async () => {
    const { api, closes } = fakeApi();
    const done = worker("done");
    const shipped = worker("shipped");
    useThreadsStore.setState({ byId: { [done.thread.id]: done, [shipped.thread.id]: shipped } });
    const close = api.closeThread;
    api.closeThread = vi.fn(async (threadId: ThreadId, options?: CloseThreadOptions) => {
      const result = await close(threadId, options);
      useThreadsStore.setState({
        byId: { [shipped.thread.id]: { ...shipped, status: "running" } },
      });
      return result;
    });
    renderWithApi(<WorktreesDialog repoPath="/r" onClose={() => {}} />, api);

    fireEvent.click(await screen.findByRole("button", { name: "Select all 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove 2 worktrees…" }));
    const bulk = screen.getByTestId("worktree-bulk-remove");
    await waitFor(() =>
      expect(within(bulk).getByRole("button", { name: "Delete 2 worktrees" })).toHaveProperty(
        "disabled",
        false,
      ),
    );
    fireEvent.click(within(bulk).getByRole("button", { name: "Delete 2 worktrees" }));

    expect((await screen.findByRole("status")).textContent).toBe(
      "Removed the worktree folder done and closed its worker. The branch done and its commits are kept.",
    );
    expect(closes.map((c) => c.threadId)).toEqual([done.thread.id]);
    expect(within(row("shipped")).queryByRole("checkbox")).toBeNull();
  });

  it("selects archived and merged workers' worktrees at once and closes each worker with it", async () => {
    const { api, calls, closes } = fakeApi();
    const done = worker("done");
    const shipped = worker("shipped", { parked: false }, { git: { ...CLEAN, pr: MERGED } });
    const busy = worker("busy", { parked: false }, { status: "running" });
    useThreadsStore.setState({
      byId: { [done.thread.id]: done, [shipped.thread.id]: shipped, [busy.thread.id]: busy },
    });
    renderWithApi(<WorktreesDialog repoPath="/r" onClose={() => {}} />, api);

    await screen.findByRole("listitem", { name: "done" });
    expect(within(row("busy")).queryByRole("checkbox")).toBeNull();
    expect(row("done").textContent).toContain("Archived worker");
    expect(screen.getByText("2 worktrees of archived or merged workers")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Select all 2" }));
    expect(within(row("done")).getByRole("checkbox", { name: "Select done" })).toHaveProperty(
      "checked",
      true,
    );
    await waitFor(() =>
      expect(screen.getByTestId("worktree-selection").textContent).toBe("2 selected · 3.0 GB"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove 2 worktrees…" }));

    const bulk = screen.getByTestId("worktree-bulk-remove");
    expect(bulk.textContent).toContain("freeing 3.0 GB");
    expect(bulk.textContent).toContain("2 finished workers using them are closed too.");
    await waitFor(() =>
      expect(within(bulk).getByRole("button", { name: "Delete 2 worktrees" })).toHaveProperty(
        "disabled",
        false,
      ),
    );
    fireEvent.click(within(bulk).getByRole("button", { name: "Delete 2 worktrees" }));

    expect((await screen.findByRole("status")).textContent).toBe(
      "Removed 2 worktree folders and closed 2 finished workers. Their branches and commits are kept.",
    );
    expect(calls).toEqual([]);
    expect(closes).toEqual([
      { threadId: done.thread.id, options: { removeWorktree: { force: false }, onlyAtRest: true } },
      {
        threadId: shipped.thread.id,
        options: { removeWorktree: { force: false }, onlyAtRest: true },
      },
    ]);
  });

  it("selects only unused worktrees and removes several with each one's picked rules", async () => {
    const { api, calls } = fakeApi();
    renderWithApi(<WorktreesDialog repoPath="/r" onClose={() => {}} />, api);

    await screen.findByRole("listitem", { name: "a" });
    expect(within(row("Main checkout")).queryByRole("checkbox")).toBeNull();
    expect(within(row("busy")).queryByRole("checkbox")).toBeNull();

    fireEvent.click(within(row("a")).getByRole("checkbox", { name: "Select a" }));
    fireEvent.click(within(row("b")).getByRole("checkbox", { name: "Select b" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove 2 worktrees…" }));

    const bulk = screen.getByTestId("worktree-bulk-remove");
    const forA = within(bulk).getByRole("listitem", { name: "Remove a" });
    fireEvent.click(
      await within(forA).findByRole("checkbox", { name: "WebFetch(domain:github.com)" }),
    );
    await waitFor(() =>
      expect(within(bulk).getByRole("button", { name: "Delete 2 worktrees" })).toHaveProperty(
        "disabled",
        false,
      ),
    );
    fireEvent.click(within(bulk).getByRole("button", { name: "Delete 2 worktrees" }));

    expect((await screen.findByRole("status")).textContent).toBe(
      "Removed 2 worktree folders. Their branches and commits are kept.",
    );
    expect(calls).toEqual([
      { path: "/r/.worktrees/a", options: { force: false, permissionRules: ["Bash(npm test)"] } },
      { path: "/r/.worktrees/b", options: { force: false } },
    ]);
    await waitFor(() => expect(screen.queryByRole("listitem", { name: "a" })).toBeNull());
    expect(screen.queryByTestId("worktree-bulk-remove")).toBeNull();
  });

  it("forces only the worktrees refused as dirty, after confirming", async () => {
    const { api, calls } = fakeApi({ dirtyB: true });
    renderWithApi(<WorktreesDialog repoPath="/r" onClose={() => {}} />, api);

    await screen.findByRole("listitem", { name: "a" });
    fireEvent.click(within(row("a")).getByRole("checkbox", { name: "Select a" }));
    fireEvent.click(within(row("b")).getByRole("checkbox", { name: "Select b" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove 2 worktrees…" }));
    const bulk = screen.getByTestId("worktree-bulk-remove");
    await waitFor(() =>
      expect(within(bulk).getByRole("button", { name: "Delete 2 worktrees" })).toHaveProperty(
        "disabled",
        false,
      ),
    );
    fireEvent.click(within(bulk).getByRole("button", { name: "Delete 2 worktrees" }));

    const forB = await within(bulk).findByRole("listitem", { name: "Remove b" });
    expect(await within(forB).findByText(/3 uncommitted changes/)).toBeTruthy();
    fireEvent.click(within(bulk).getByRole("button", { name: "Delete 1 worktree anyway" }));

    await waitFor(() => expect(screen.queryByTestId("worktree-bulk-remove")).toBeNull());
    expect(calls.map((c) => [c.path, c.options.force])).toEqual([
      ["/r/.worktrees/a", false],
      ["/r/.worktrees/b", false],
      ["/r/.worktrees/b", true],
    ]);
  });
});
