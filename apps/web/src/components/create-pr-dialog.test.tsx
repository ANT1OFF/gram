// @vitest-environment happy-dom
import type { GitState, ThreadId } from "@gram/contracts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithApi } from "@/panels/test-utils";
import { useThreadsStore } from "@/stores/threads";

import { canCreatePr, CreatePrDialog } from "./create-pr-dialog";

const git = (overrides: Partial<GitState> = {}): GitState => ({
  repo: true,
  branch: "feat/dark",
  worktree: true,
  head: "abc",
  changesToken: "t",
  changedFiles: 0,
  base: "origin/develop",
  behindBase: 0,
  aheadBase: 2,
  conflicts: false,
  origin: "acme/web",
  ...overrides,
});

const THREAD = "t-create-pr" as ThreadId;

const seed = (state: GitState) => {
  const { applyEvent } = useThreadsStore.getState();
  applyEvent({
    type: "thread.upsert",
    thread: {
      id: THREAD,
      projectId: "p",
      title: "Dark mode",
      userNamed: false,
      model: { agent: "claude", model: "opus" },
      mode: "default",
      checkout: { kind: "worktree", path: "/repo/.worktrees/dark" },
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

const api = (overrides: Record<string, unknown> = {}) => ({
  branches: async () => ({ branches: ["origin/main", "origin/develop"], default: "origin/main" }),
  prDraft: vi.fn(async () => ({
    title: "Dark mode",
    body: "- Add a toggle\n- Add tokens",
    commits: 2,
  })),
  pushBranch: vi.fn(async () => ({ branch: "feat/dark", published: true })),
  prCreate: vi.fn(async () => ({
    repo: "acme/web",
    number: 7,
    url: "https://github.com/acme/web/pull/7",
  })),
  ...overrides,
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("canCreatePr", () => {
  it("needs a branch on a GitHub origin without a PR", () => {
    expect(canCreatePr(git())).toBe(true);
    const { origin: _noOrigin, ...noOrigin } = git();
    expect(canCreatePr(noOrigin)).toBe(false);
    const { branch: _detached, ...detached } = git();
    expect(canCreatePr(detached)).toBe(false);
    expect(
      canCreatePr(
        git({
          pr: {
            number: 7,
            state: "OPEN",
            url: "https://github.com/acme/web/pull/7",
            title: "Dark mode",
            isDraft: false,
            checks: "pending",
            headMatches: true,
            aheadOfPr: false,
          },
        }),
      ),
    ).toBe(false);
  });
});

describe("CreatePrDialog", () => {
  it("pre-fills from the commits against the branch's base, pushes, then creates a draft", async () => {
    seed(git());
    const notify = vi.spyOn(useThreadsStore.getState(), "applyEvent").mockImplementation(() => {});
    const onClose = vi.fn();
    const fake = api();
    renderWithApi(<CreatePrDialog threadId={THREAD} onClose={onClose} />, fake);

    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Description" })).toHaveProperty(
        "value",
        "- Add a toggle\n- Add tokens",
      ),
    );
    expect(fake.prDraft).toHaveBeenCalledWith(THREAD, "develop");
    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), {
      target: { value: "Add dark mode" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Push and create" }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(fake.pushBranch).toHaveBeenCalledWith(THREAD);
    expect(fake.pushBranch.mock.invocationCallOrder[0]).toBeLessThan(
      fake.prCreate.mock.invocationCallOrder[0] ?? 0,
    );
    expect(fake.prCreate).toHaveBeenCalledWith({
      threadId: THREAD,
      title: "Add dark mode",
      body: "- Add a toggle\n- Add tokens",
      base: "develop",
      draft: true,
    });
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "info", title: "Opened #7" }),
    );
  });

  it("creates without pushing when origin is up to date, and keeps the dialog open on failure", async () => {
    seed(git({ upstream: "synced" }));
    const onClose = vi.fn();
    const fake = api({
      prCreate: vi.fn(async () => {
        throw new Error('a pull request for branch "feat/dark" already exists');
      }),
    });
    renderWithApi(<CreatePrDialog threadId={THREAD} onClose={onClose} />, fake);

    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Title" })).toHaveProperty("value", "Dark mode"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Create PR" }));

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      'a pull request for branch "feat/dark" already exists',
    );
    expect(fake.pushBranch).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
