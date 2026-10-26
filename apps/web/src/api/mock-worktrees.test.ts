import type { ThreadId } from "@gram/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMockApi } from "./mock";
import { MOCK_WORKTREES_KEY } from "./mock-worktrees-many";
import type { ApiServerEvent } from "./types";

afterEach(() => {
  vi.unstubAllGlobals();
});

const API = "/Users/dev/code/api";
const EXPERIMENT = `${API}/.worktrees/cache-experiment`;
const FLAKY = "t-flaky" as ThreadId;

describe("MockApi worktrees", () => {
  it("reports the thread-less worktree as dirty and refuses to delete it unless forced", async () => {
    const api = createMockApi({ speed: 0, autoplay: false });
    expect(await api.worktreeStatus(EXPERIMENT)).toMatchObject({
      branch: "experiment/cache",
      changedFiles: 2,
      aheadBase: 1,
      base: "origin/main",
    });
    expect(await api.worktreePendingPermissions(EXPERIMENT)).toContain("Bash(pnpm test:*)");
    expect(await api.worktreePendingPermissions(API)).toEqual([]);

    await expect(api.removeWorktree(EXPERIMENT, { force: false })).rejects.toMatchObject({
      _tag: "WorktreeDirty",
      path: EXPERIMENT,
      changedFiles: 2,
    });
    await api.removeWorktree(EXPERIMENT, { force: true, permissionRules: ["Bash(pnpm test:*)"] });
    expect(api.lastRemove).toEqual({
      path: EXPERIMENT,
      options: { force: true, permissionRules: ["Bash(pnpm test:*)"] },
    });
    const list = await api.listWorktrees(API);
    expect(list.worktrees.some((w) => w.path === EXPERIMENT)).toBe(false);
    await expect(api.worktreeStatus(EXPERIMENT)).rejects.toMatchObject({ _tag: "GitError" });
  });

  it("lists several removable worktrees when e2e asks for many", async () => {
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => (key === MOCK_WORKTREES_KEY ? "many" : null),
    });
    const api = createMockApi({ speed: 0, autoplay: false });
    const paths = (await api.listWorktrees(API)).worktrees.map((w) => w.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        EXPERIMENT,
        `${API}/.worktrees/spike-retry`,
        `${API}/.worktrees/docs-refresh`,
        `${API}/.worktrees/perf-probe`,
      ]),
    );
    expect(await api.worktreeStatus(`${API}/.worktrees/docs-refresh`)).toMatchObject({
      branch: "docs/refresh",
      changedFiles: 1,
    });
    await api.removeWorktree(`${API}/.worktrees/spike-retry`, { force: false });
    const after = (await api.listWorktrees(API)).worktrees.map((w) => w.path);
    expect(after).not.toContain(`${API}/.worktrees/spike-retry`);
  });

  it("refuses the main checkout and a worktree a thread has open", async () => {
    const api = createMockApi({ speed: 0, autoplay: false });
    await expect(api.removeWorktree(API, { force: true })).rejects.toMatchObject({
      _tag: "InvalidState",
    });
    await expect(
      api.removeWorktree(`${API}/.worktrees/fix-flaky-retry`, { force: true }),
    ).rejects.toMatchObject({ _tag: "InvalidState" });
    expect(await api.worktreeStatus(`${API}/.worktrees/chore-deps`)).toMatchObject({
      changedFiles: 0,
      aheadBase: 0,
    });
  });

  it("binds, watches and unbinds a PR through thread.upsert", async () => {
    const api = createMockApi({ speed: 0, autoplay: false });
    const abort = new AbortController();
    const events: ApiServerEvent[] = [];
    void (async () => {
      for await (const event of api.events(abort.signal)) events.push(event);
    })();
    const boundPr = async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const upsert = events.findLast((e) => e.type === "thread.upsert");
      return upsert?.type === "thread.upsert" ? upsert.thread.boundPr : "no upsert";
    };

    await expect(api.prSetMonitor(FLAKY, true)).rejects.toMatchObject({ _tag: "InvalidState" });
    await expect(api.prBind(FLAKY, "not a repo", 12)).rejects.toMatchObject({ _tag: "GitError" });

    expect(await api.prBind(FLAKY, "example/api", 412)).toEqual({
      repo: "example/api",
      number: 412,
      monitor: false,
    });
    expect(await boundPr()).toEqual({ repo: "example/api", number: 412, monitor: false });
    await api.prSetMonitor(FLAKY, true);
    expect(await boundPr()).toEqual({ repo: "example/api", number: 412, monitor: true });
    await api.prUnbind(FLAKY);
    expect(await boundPr()).toBeUndefined();
    abort.abort();
  });
});
