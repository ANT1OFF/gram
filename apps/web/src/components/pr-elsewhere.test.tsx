// @vitest-environment happy-dom
import type { GitState, ThreadId } from "@gram/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithApi } from "@/panels/test-utils";
import { useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";

import { PrElsewhereChip, PrElsewhereNotice, worktreeName } from "./pr-elsewhere";

const HERE = "t-here" as ThreadId;
const THERE = "t-there" as ThreadId;

const git = (overrides: Partial<GitState> = {}): GitState => ({
  repo: true,
  branch: "feat/docs",
  worktree: true,
  head: "abc",
  changesToken: "t",
  changedFiles: 0,
  behindBase: 0,
  aheadBase: 0,
  conflicts: false,
  origin: "acme/web",
  prElsewhere: {
    number: 41,
    title: "Dark mode",
    url: "https://github.com/acme/web/pull/41",
    repo: "acme/web",
    branch: "feat/dark",
    worktreePath: "/repo/.worktrees/dark",
    threadId: THERE,
  },
  ...overrides,
});

const seed = (id: ThreadId, state?: GitState) => {
  const { applyEvent } = useThreadsStore.getState();
  applyEvent({
    type: "thread.upsert",
    thread: {
      id,
      projectId: "p",
      title: id,
      userNamed: false,
      model: { agent: "claude", model: "opus" },
      mode: "default",
      checkout: { kind: "worktree", path: `/repo/.worktrees/${id}` },
      labels: [],
      pinned: false,
      parked: false,
      unread: false,
      createdAt: 0,
      lastActivityAt: 0,
    } as never,
  });
  if (state) applyEvent({ type: "git.state", threadId: id, state });
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PrElsewhereChip", () => {
  it("names the PR and branch, and gives way to the branch's own PR", () => {
    const { rerender } = render(<PrElsewhereChip git={git()} testId="chip" />);
    expect(screen.getByTestId("chip").textContent).toBe("#41 on feat/dark");
    expect(screen.getByTestId("chip").getAttribute("title")).toContain("open on feat/dark in dark");

    rerender(
      <PrElsewhereChip
        git={git({
          pr: {
            number: 7,
            state: "OPEN",
            url: "https://github.com/acme/web/pull/7",
            title: "Docs",
            isDraft: false,
            checks: "none",
            headMatches: true,
            aheadOfPr: false,
          },
        })}
        testId="chip"
      />,
    );
    expect(screen.queryByTestId("chip")).toBeNull();
  });

  it("uses the folder as the worktree's name", () => {
    expect(worktreeName("/repo/.worktrees/dark/")).toBe("dark");
    expect(worktreeName("C:\\code\\web\\wt-dark")).toBe("wt-dark");
  });
});

describe("PrElsewhereNotice", () => {
  it("says where the PR is open, opens that thread and binds the PR here", async () => {
    seed(THERE);
    seed(HERE, git());
    const openThread = vi
      .spyOn(useLayoutStore.getState(), "openThread")
      .mockImplementation(() => {});
    vi.spyOn(useThreadsStore.getState(), "applyEvent").mockImplementation(() => {});
    const prBind = vi.fn(async () => ({ repo: "acme/web", number: 41, monitor: false }));
    renderWithApi(<PrElsewhereNotice threadId={HERE} />, { prBind });

    expect(screen.getByTestId("pr-elsewhere").textContent).toContain(
      "#41 open on feat/dark in dark",
    );
    fireEvent.click(screen.getByRole("button", { name: "Open thread" }));
    expect(openThread).toHaveBeenCalledWith(THERE);

    fireEvent.click(screen.getByRole("button", { name: "Bind to this thread" }));
    await waitFor(() => expect(prBind).toHaveBeenCalledWith(HERE, "acme/web", 41));
  });

  it("offers only Bind when no open thread works in that worktree", () => {
    const { prElsewhere, ...rest } = git();
    const { threadId: _none, ...untracked } = prElsewhere!;
    seed(HERE, { ...rest, prElsewhere: untracked });
    renderWithApi(<PrElsewhereNotice threadId={HERE} />, { prBind: vi.fn() });

    expect(screen.queryByRole("button", { name: "Open thread" })).toBeNull();
    expect(screen.getByRole("button", { name: "Bind to this thread" })).toBeTruthy();
  });
});
