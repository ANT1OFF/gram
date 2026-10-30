// @vitest-environment happy-dom
import type { GitState, PrStatus, ThreadId, ThreadSummary } from "@gram/contracts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithApi } from "@/panels/test-utils";
import { useThreadsStore } from "@/stores/threads";

import { CloseThreadDialog } from "./close-thread-dialog";
import { branchDeleteLooksSafe, cleanAndPushed, mergedPrRef } from "./merged-cleanup";

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => () => Promise.resolve(),
  useParams: () => ({}),
}));

const T = "t-merged" as ThreadId;

const pr: PrStatus = {
  number: 42,
  state: "MERGED",
  url: "u",
  title: "Fix the flake",
  isDraft: false,
  checks: "passing",
  headMatches: true,
  aheadOfPr: false,
  headRefOid: "abc",
};

const git: GitState = {
  repo: true,
  branch: "fix/flake",
  worktree: true,
  head: "abc",
  changesToken: "tok",
  changedFiles: 0,
  behindBase: 0,
  aheadBase: 0,
  conflicts: false,
  pr,
  origin: "acme/app",
};

const summary = (overrides: Partial<GitState> = {}) =>
  ({
    status: "idle",
    pendingRequests: [],
    queue: [],
    git: { ...git, ...overrides },
    thread: {
      id: T,
      title: "Fix the flake",
      completedReason: "prMerged",
      checkout: {
        kind: "worktree",
        path: "/work/app/.worktrees/flake",
        branch: "fix/flake",
        repoRoot: "/work/app",
      },
    },
  }) as unknown as ThreadSummary;

afterEach(() => {
  cleanup();
  useThreadsStore.setState({ byId: {} as never, notifications: [] });
});

describe("merged cleanup helpers", () => {
  it("names the merged PR and says when deleting the branch looks safe", () => {
    expect(mergedPrRef(summary())).toEqual({ repo: "acme/app", number: 42 });
    expect(mergedPrRef(summary({ pr: { ...pr, state: "OPEN" } }))).toBeUndefined();
    expect(branchDeleteLooksSafe(summary().git)).toBe(true);
    expect(branchDeleteLooksSafe(summary({ pr: { ...pr, aheadOfPr: true } }).git)).toBe(false);
    expect(branchDeleteLooksSafe(summary({ changedFiles: 2 }).git)).toBe(false);
  });
});

describe("cleanAndPushed", () => {
  it("reads a clean tree whose commits a remote has, and nothing else", () => {
    const { pr: _, ...noPr } = git;
    // HEAD is the merged PR's head, which GitHub keeps after deleting the branch.
    expect(cleanAndPushed(git)).toBe(true);
    expect(cleanAndPushed({ ...noPr, headOnRemote: true })).toBe(true);
    expect(cleanAndPushed({ ...git, changedFiles: 1 })).toBe(false);
    expect(cleanAndPushed({ ...noPr, headOnRemote: false })).toBe(false);
    // Not measured yet: nothing says the commits are anywhere else.
    expect(cleanAndPushed(noPr)).toBe(false);
    // The PR's head is the pushed tip, but local commits are past it.
    const past = { ...git, pr: { ...pr, headRefOid: "older", aheadOfPr: true } };
    expect(cleanAndPushed(past)).toBe(false);
    expect(cleanAndPushed({ ...past, headOnRemote: false })).toBe(false);
    expect(cleanAndPushed({ ...past, headOnRemote: true })).toBe(true);
    expect(cleanAndPushed({ ...git, missing: true })).toBe(false);
    expect(cleanAndPushed(undefined)).toBe(false);
  });
});

const removalBox = () =>
  screen.getByRole("checkbox", { name: /Also delete the worktree on disk/ }) as HTMLInputElement;

describe("CloseThreadDialog", () => {
  it("ticks removing a clean, pushed worktree, and leaves one with work unticked", () => {
    useThreadsStore.setState({ byId: { [T]: summary() } as never });
    const api = { closeThread: vi.fn(), pendingPermissions: async () => [] };
    const first = renderWithApi(<CloseThreadDialog threadId={T} onClose={() => {}} />, api);
    expect(removalBox().checked).toBe(true);
    first.unmount();

    useThreadsStore.setState({ byId: { [T]: summary({ changedFiles: 2 }) } as never });
    const dirty = renderWithApi(<CloseThreadDialog threadId={T} onClose={() => {}} />, api);
    expect(removalBox().checked).toBe(false);
    dirty.unmount();

    const { pr: _, ...noPr } = git;
    useThreadsStore.setState({
      byId: {
        [T]: { ...summary(), git: { ...noPr, upstream: "ahead", aheadUpstream: 1 } },
      } as never,
    });
    renderWithApi(<CloseThreadDialog threadId={T} onClose={() => {}} />, api);
    expect(removalBox().checked).toBe(false);
  });

  it("cleans up a merged worktree and its branch, and says why a branch was kept", async () => {
    useThreadsStore.setState({ byId: { [T]: summary() } as never });
    const closeThread = vi.fn(async () => ({
      branch: { name: "fix/flake", deleted: false, reason: "it has commits #42 doesn't" },
    }));
    renderWithApi(
      <CloseThreadDialog
        threadId={T}
        onClose={() => {}}
        preset={{ removeWorktree: true, deleteBranch: true }}
      />,
      { closeThread, pendingPermissions: async () => [] },
    );

    const branchBox = screen.getByRole("checkbox", { name: /delete the local branch fix\/flake/ });
    expect((branchBox as HTMLInputElement).checked).toBe(true);
    const button = screen.getByRole("button", { name: "Close and delete worktree" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);

    await waitFor(() =>
      expect(closeThread).toHaveBeenCalledWith(T, {
        removeWorktree: { force: false, deleteBranch: { repo: "acme/app", number: 42 } },
      }),
    );
    await waitFor(() =>
      expect(useThreadsStore.getState().notifications.at(-1)).toMatchObject({
        title: "Kept the local branch fix/flake",
        body: "it has commits #42 doesn't",
      }),
    );
  });

  it("never offers to delete the branch without a merged PR", () => {
    useThreadsStore.setState({ byId: { [T]: summary({ pr: { ...pr, state: "OPEN" } }) } as never });
    renderWithApi(
      <CloseThreadDialog
        threadId={T}
        onClose={() => {}}
        preset={{ removeWorktree: true, deleteBranch: true }}
      />,
      { closeThread: vi.fn(), pendingPermissions: async () => [] },
    );
    expect(screen.queryByRole("checkbox", { name: /delete the local branch/ })).toBeNull();
  });
});
