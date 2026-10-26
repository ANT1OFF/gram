// @vitest-environment happy-dom
import type { GitState, ThreadId } from "@gram/contracts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithApi } from "@/panels/test-utils";
import { useThreadsStore } from "@/stores/threads";

import { PushButton, pushActionOf, pushLabelOf } from "./push-button";

const git = (overrides: Partial<GitState> = {}): GitState => ({
  repo: true,
  branch: "feat/x",
  worktree: true,
  head: "abc",
  changesToken: "t",
  changedFiles: 0,
  behindBase: 0,
  aheadBase: 1,
  conflicts: false,
  origin: "acme/web",
  ...overrides,
});

const THREAD = "t-push" as ThreadId;

const seed = (state: GitState) => {
  const { applyEvent } = useThreadsStore.getState();
  applyEvent({
    type: "thread.upsert",
    thread: {
      id: THREAD,
      projectId: "p",
      title: "Push me",
      userNamed: false,
      model: { agent: "claude", model: "opus" },
      mode: "default",
      checkout: { kind: "worktree", path: "/repo/.worktrees/x" },
      labels: [],
      pinned: false,
      parked: false,
      unread: false,
      createdAt: 0,
      lastActivityAt: 0,
    } as never,
  });
  applyEvent({ type: "git.state", threadId: THREAD, state });
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("pushActionOf", () => {
  it("publishes an unpushed branch, pushes one that's ahead, and stays quiet otherwise", () => {
    expect(pushActionOf(git())).toBe("publish");
    expect(pushActionOf(git({ upstream: "ahead" }))).toBe("push");
    for (const upstream of ["synced", "behind", "diverged"] as const) {
      expect(pushActionOf(git({ upstream })), upstream).toBeUndefined();
    }
    const { branch: _detached, ...detached } = git();
    expect(pushActionOf(detached)).toBeUndefined();
    const { origin: _noOrigin, ...noOrigin } = git();
    expect(pushActionOf(noOrigin)).toBeUndefined();
    expect(pushActionOf(undefined)).toBeUndefined();
  });
});

describe("pushLabelOf", () => {
  it("counts the commits origin doesn't have, when it knows", () => {
    expect(pushLabelOf(git())).toBe("Publish branch");
    expect(pushLabelOf(git({ upstream: "ahead", aheadUpstream: 3 }))).toBe("Push 3 commits");
    expect(pushLabelOf(git({ upstream: "ahead", aheadUpstream: 1 }))).toBe("Push 1 commit");
    expect(pushLabelOf(git({ upstream: "ahead" }))).toBe("Push");
    expect(pushLabelOf(git({ upstream: "diverged", aheadUpstream: 2 }))).toBeUndefined();
  });
});

describe("PushButton", () => {
  it("publishes the branch and says so", async () => {
    seed(git());
    const notify = vi.spyOn(useThreadsStore.getState(), "applyEvent").mockImplementation(() => {});
    const pushBranch = vi.fn(async () => ({ branch: "feat/x", published: true }));
    renderWithApi(<PushButton threadId={THREAD} />, { pushBranch });

    fireEvent.click(screen.getByRole("button", { name: "Publish branch" }));
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "info", title: "Published feat/x" }),
      ),
    );
    expect(pushBranch).toHaveBeenCalledWith(THREAD);
  });

  it("shows why a push was refused", async () => {
    seed(git({ upstream: "ahead", aheadUpstream: 1 }));
    const notify = vi.spyOn(useThreadsStore.getState(), "applyEvent").mockImplementation(() => {});
    renderWithApi(<PushButton threadId={THREAD} />, {
      pushBranch: async () => {
        throw new Error("feat/x is 1 commit behind origin/feat/x. Pull first.");
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Push 1 commit" }));
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "error",
          title: "Couldn't push",
          body: "feat/x is 1 commit behind origin/feat/x. Pull first.",
        }),
      ),
    );
  });

  it("renders nothing when the branch is in sync", () => {
    seed(git({ upstream: "synced" }));
    renderWithApi(<PushButton threadId={THREAD} />, { pushBranch: vi.fn() });
    expect(screen.queryByTestId("push-button")).toBeNull();
  });
});
