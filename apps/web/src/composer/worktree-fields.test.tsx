// @vitest-environment happy-dom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithApi } from "@/panels/test-utils";

import { CurrentCheckoutFreshness, WorktreeFields, type WorktreeChoice } from "./worktree-fields";

const HOUR = 60 * 60 * 1000;
const choice = (base: string): WorktreeChoice => ({ prefix: "feat", name: "calm-otter", base });
const branches = async () => ({
  branches: ["origin/main", "origin/develop"],
  default: "origin/main",
});

const renderFields = (base: string, api: Record<string, unknown>) =>
  renderWithApi(<WorktreeFields repoPath="/repo" value={choice(base)} onChange={() => {}} />, {
    branches,
    ...api,
  });

afterEach(cleanup);

describe("WorktreeFields base freshness", () => {
  it("offers a one-click fetch when the picked base was last fetched hours ago", async () => {
    const fetchBase = vi.fn(async () => ({
      ref: "origin/develop",
      fetchedAt: Date.now(),
      newCommits: 2,
    }));
    renderFields("origin/develop", {
      baseStatus: async () => ({ ref: "origin/develop", fetchedAt: Date.now() - 3 * HOUR }),
      fetchBase,
    });
    const note = await screen.findByTestId("base-freshness");
    expect(note.textContent).toContain(
      "origin/develop may be behind origin: last fetched 3 hours ago.",
    );
    expect(fetchBase).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Fetch" }));
    const status = await screen.findByRole("status");
    expect(status.textContent).toBe("Fetched 2 new commits into origin/develop.");
    expect(fetchBase).toHaveBeenCalledWith("/repo", "origin/develop");
  });

  it("says when the repo has never been fetched, and shows a failed fetch", async () => {
    renderFields("origin/develop", {
      baseStatus: async () => ({ ref: "origin/develop" }),
      fetchBase: async () => {
        throw new Error("Could not read from remote repository.");
      },
    });
    const note = await screen.findByTestId("base-freshness");
    expect(note.textContent).toContain(
      "This repo has never been fetched, so origin/develop may be behind origin.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Fetch" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not read from remote repository.");
  });

  it("stays quiet for a recent fetch and for the default base", async () => {
    const baseStatus = vi.fn(async (_repo: string, base: string) => ({
      ref: base,
      fetchedAt: Date.now() - 5 * 60 * 1000,
    }));
    const recent = renderFields("origin/develop", { baseStatus, fetchBase: vi.fn() });
    await waitFor(() => expect(baseStatus).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("base-freshness")).toBeNull();
    recent.unmount();

    baseStatus.mockClear();
    renderFields("__default__", { baseStatus, fetchBase: vi.fn() });
    await screen.findByRole("combobox", { name: "Base branch" });
    expect(baseStatus).not.toHaveBeenCalled();
    expect(screen.queryByTestId("base-freshness")).toBeNull();
  });
});

describe("CurrentCheckoutFreshness", () => {
  it("offers a one-click fetch for the current branch's origin upstream", async () => {
    const fetchBase = vi.fn(async () => ({
      ref: "origin/feat",
      fetchedAt: Date.now(),
      newCommits: 1,
    }));
    renderWithApi(<CurrentCheckoutFreshness repoPath="/repo" />, {
      upstreamStatus: async () => ({
        branch: "feat",
        ref: "origin/feat",
        fetchedAt: Date.now() - 3 * HOUR,
      }),
      baseStatus: async () => ({ ref: "origin/feat", fetchedAt: Date.now() - 3 * HOUR }),
      fetchBase,
    });
    const note = await screen.findByTestId("base-freshness");
    expect(note.textContent).toContain(
      "origin/feat may be behind origin: last fetched 3 hours ago.",
    );
    expect(fetchBase).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Fetch" }));
    const status = await screen.findByRole("status");
    expect(status.textContent).toBe("Fetched 1 new commit into origin/feat.");
    expect(fetchBase).toHaveBeenCalledWith("/repo", "origin/feat");
  });

  it("says nothing for a branch without an origin upstream", async () => {
    const upstreamStatus = vi.fn(async () => ({ branch: "local-only" }));
    const baseStatus = vi.fn();
    renderWithApi(<CurrentCheckoutFreshness repoPath="/repo" />, { upstreamStatus, baseStatus });
    await waitFor(() => expect(upstreamStatus).toHaveBeenCalledWith("/repo"));
    expect(baseStatus).not.toHaveBeenCalled();
    expect(screen.queryByTestId("base-freshness")).toBeNull();
  });
});

describe("CurrentCheckoutFreshness fast-forward", () => {
  const upstream = {
    upstreamStatus: async () => ({ branch: "main", ref: "origin/main", fetchedAt: Date.now() }),
    baseStatus: async () => ({ ref: "origin/main", fetchedAt: Date.now() }),
  };

  it("says how far behind the branch is and fast-forwards on a click", async () => {
    const fastForward = vi.fn(async () => ({
      branch: "main",
      ref: "origin/main",
      commits: 2,
      head: "abc",
    }));
    renderWithApi(<CurrentCheckoutFreshness repoPath="/repo" />, {
      ...upstream,
      upstreamSync: async () => ({
        branch: "main",
        ref: "origin/main",
        ahead: 0,
        behind: 2,
        changedFiles: 0,
      }),
      fastForward,
    });
    const note = await screen.findByTestId("upstream-sync");
    expect(note.textContent).toContain("main is 2 commits behind origin/main.");
    expect(fastForward).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Fast-forward" }));
    const status = await screen.findByRole("status");
    expect(status.textContent).toBe("Fast-forwarded main by 2 commits to origin/main.");
    expect(fastForward).toHaveBeenCalledWith("/repo");
  });

  it("explains why it won't fast-forward, and stays quiet when up to date", async () => {
    const view = renderWithApi(<CurrentCheckoutFreshness repoPath="/repo" />, {
      ...upstream,
      upstreamSync: async () => ({
        branch: "main",
        ref: "origin/main",
        ahead: 0,
        behind: 1,
        changedFiles: 3,
        blocker: "it has 3 uncommitted changes",
      }),
      fastForward: vi.fn(),
    });
    const note = await screen.findByTestId("upstream-sync");
    expect(note.textContent).toContain("main is 1 commit behind origin/main.");
    expect(note.textContent).toContain("Not fast-forwarding: it has 3 uncommitted changes.");
    expect(screen.queryByRole("button", { name: "Fast-forward" })).toBeNull();
    view.unmount();

    const upstreamSync = vi.fn(async () => ({
      branch: "main",
      ref: "origin/main",
      ahead: 0,
      behind: 0,
      changedFiles: 0,
      blocker: "it's up to date",
    }));
    renderWithApi(<CurrentCheckoutFreshness repoPath="/repo" />, { ...upstream, upstreamSync });
    await waitFor(() => expect(upstreamSync).toHaveBeenCalledWith("/repo"));
    expect(screen.queryByTestId("upstream-sync")).toBeNull();
  });
});
