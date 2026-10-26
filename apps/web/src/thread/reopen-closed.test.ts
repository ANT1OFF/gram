import type {
  ClosedThread,
  ProjectId,
  ReopenedClosedThread,
  Thread,
  ThreadId,
  WorkspaceId,
} from "@gram/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useThreadsStore } from "@/stores/threads";

import { reopenLastClosed, reopenNotice, reopenProblem } from "./reopen-closed";

const base: Thread = {
  id: "t-old" as ThreadId,
  projectId: "p" as ProjectId,
  title: "Fix the flake",
  userNamed: true,
  model: { agent: "codex", model: "gpt-5.5", profileId: "litellm" as never },
  mode: "acceptEdits",
  checkout: { kind: "main", path: "/repo", branch: "main" },
  agentSessionId: "s-1",
  labels: [],
  pinned: false,
  parked: false,
  unread: false,
  createdAt: 0,
  lastActivityAt: 0,
};

const worktree: Thread = {
  ...base,
  checkout: { kind: "worktree", path: "/repo/.worktrees/fix", branch: "fix", repoRoot: "/repo" },
};

const worker: Thread = {
  ...worktree,
  workspaceId: "w-1" as WorkspaceId,
  spawnedBy: { threadId: "t-boss" as ThreadId, feature: "fix" },
};

afterEach(() => {
  vi.restoreAllMocks();
});

const closedOf = (thread: Thread, extra: Partial<ClosedThread> = {}): ClosedThread => ({
  thread,
  closedAt: 1,
  ...extra,
});

const reopenedOf = (
  thread: Thread,
  extra: Partial<Omit<ReopenedClosedThread, "closed">> = {},
  closed: Partial<ClosedThread> = {},
): ReopenedClosedThread => ({ closed: closedOf(thread, closed), thread, ...extra });

const spyNotify = () =>
  vi.spyOn(useThreadsStore.getState(), "applyEvent").mockImplementation(() => {});

/** The server's refusal of a reopen whose checkout another thread holds. */
const refused = async () => {
  throw Object.assign(new Error("a thread is already open in that checkout"), {
    _tag: "InvalidState",
  });
};

describe("reopenProblem", () => {
  it("explains a removed worktree, a busy checkout and anything else", () => {
    expect(reopenProblem(worktree, { _tag: "NotFound", message: "Folder not found" })).toBe(
      "Its worktree no longer exists: /repo/.worktrees/fix",
    );
    expect(
      reopenProblem(worktree, {
        _tag: "InvalidState",
        message: "a thread is already open in that checkout",
      }),
    ).toBe("Another thread is already open in that checkout.");
    expect(reopenProblem(base, new Error("disk full"))).toBe("disk full");
  });
});

describe("reopenNotice", () => {
  it("says nothing for a thread that came back as it was, in its workspace or none", () => {
    expect(reopenNotice(reopenedOf(base))).toBeUndefined();
    expect(reopenNotice(reopenedOf(worker, { membership: "restored" }))).toBeUndefined();
  });

  it("points a thread whose worktree is gone at restoring it, and names what didn't come back", () => {
    expect(
      reopenNotice(reopenedOf(worker, { membership: "restored" }, { problem: "folderMissing" })),
    ).toEqual({
      title: "Reopened “Fix the flake”",
      body: "Its worktree no longer exists: /repo/.worktrees/fix. Restore it from the thread, from its branch or its PR's head.",
    });
    const orchestrator: Thread = {
      ...base,
      role: "orchestrator",
      workspaceId: "w-1" as WorkspaceId,
    };
    expect(reopenNotice(reopenedOf(orchestrator, { membership: "slotTaken" }))?.body).toBe(
      "Its workspace has another orchestrator now, so this one is back as a plain thread in the workspace.",
    );
    expect(reopenNotice(reopenedOf(orchestrator, { membership: "notAdmitted" }))?.body).toContain(
      "can't be a workspace's orchestrator any more",
    );
    expect(
      reopenNotice(
        reopenedOf(worker, { membership: "orchestratorGone" }, { problem: "folderMissing" }),
      )?.body,
    ).toBe(
      "Its worktree no longer exists: /repo/.worktrees/fix. Restore it from the thread, from its branch or its PR's head. The orchestrator that spawned it is closed or replaced, so it is back in the workspace without one.",
    );
    expect(reopenNotice(reopenedOf(worker, { membership: "workspaceGone" }))?.body).toBe(
      "Its workspace was removed, so it is back as a plain thread.",
    );
  });
});

describe("reopenLastClosed", () => {
  it("opens the thread the server reopened", async () => {
    const notify = spyNotify();
    const reopenClosedThread = vi.fn(async () => reopenedOf(worker, { membership: "restored" }));
    const open = vi.fn();

    await reopenLastClosed({ reopenClosedThread } as never, open);

    expect(reopenClosedThread).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith("t-old");
    expect(notify).toHaveBeenCalledWith({ type: "thread.upsert", thread: worker });
    expect(notify).not.toHaveBeenCalledWith(expect.objectContaining({ type: "notify" }));
  });

  it("opens a thread whose worktree is gone, and says how to restore it", async () => {
    const notify = spyNotify();
    const open = vi.fn();

    await reopenLastClosed(
      {
        reopenClosedThread: async () =>
          reopenedOf(worker, { membership: "restored" }, { problem: "folderMissing" }),
      } as never,
      open,
    );

    expect(open).toHaveBeenCalledWith("t-old");
    expect(notify).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "notify",
        kind: "info",
        title: "Reopened “Fix the flake”",
        body: expect.stringContaining("Restore it from the thread"),
      }),
    );
  });

  it("opens the thread that already shows its session instead", async () => {
    const notify = spyNotify();
    const open = vi.fn();

    await reopenLastClosed(
      {
        reopenClosedThread: async () => ({
          closed: closedOf(base, { problem: "sessionOpen", openThreadId: "t-other" as ThreadId }),
        }),
      } as never,
      open,
    );

    expect(open).toHaveBeenCalledWith("t-other");
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "info", title: "“Fix the flake” is already open" }),
    );
  });

  it("says why the server refused, naming the entry it put back, or that nothing was closed", async () => {
    const notify = spyNotify();
    const open = vi.fn();

    await reopenLastClosed(
      { reopenClosedThread: refused, listClosedThreads: async () => [closedOf(worktree)] } as never,
      open,
    );
    expect(notify).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "error",
        title: "Couldn't reopen “Fix the flake”",
        body: "Another thread is already open in that checkout.",
      }),
    );

    await reopenLastClosed(
      { reopenClosedThread: refused, listClosedThreads: async () => [] } as never,
      open,
    );
    expect(notify).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "error",
        title: "Couldn't reopen a closed thread",
        body: "a thread is already open in that checkout",
      }),
    );

    await reopenLastClosed({ reopenClosedThread: async () => null } as never, open);
    expect(notify).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "info", title: "Nothing to reopen" }),
    );
    expect(open).not.toHaveBeenCalled();
  });
});
