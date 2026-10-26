import {
  initialBabysitState,
  type GitState,
  type ProjectId,
  type Thread,
  type ThreadId,
  type ThreadStatus,
  type ThreadSummary,
  type WorkspaceId,
} from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { livesInTree, nextNeedsYou, sectionOf, splitForTree } from "./grouping";
import { selectListed } from "./listed";

const summary = (
  id: string,
  status: ThreadStatus,
  thread: Partial<Thread> = {},
): ThreadSummary => ({
  status,
  pendingRequests: [],
  queue: [],
  thread: {
    id: id as ThreadId,
    projectId: "p-api" as ProjectId,
    title: id,
    userNamed: false,
    model: { agent: "claude", model: "opus" },
    mode: "default",
    checkout: { kind: "main", path: "/repo" },
    labels: [],
    pinned: false,
    parked: false,
    unread: false,
    createdAt: 0,
    lastActivityAt: 0,
    ...thread,
  },
});

describe("sectionOf", () => {
  it("maps runtime status onto needs-you / working / idle", () => {
    expect(sectionOf(summary("a", "needsApproval"))).toBe("needsYou");
    expect(sectionOf(summary("a", "error"))).toBe("needsYou");
    expect(sectionOf(summary("a", "starting"))).toBe("working");
    expect(sectionOf(summary("a", "cold"))).toBe("idle");
  });

  it("lets pinned and parked outrank status", () => {
    expect(sectionOf(summary("a", "needsInput", { pinned: true }))).toBe("pinned");
    expect(sectionOf(summary("a", "running", { parked: true }))).toBe("parked");
  });

  it("settles ended or completed threads, unless they are active again", () => {
    expect(sectionOf(summary("a", "ended"))).toBe("settled");
    expect(sectionOf(summary("a", "idle", { completedAt: 1 }))).toBe("settled");
    expect(sectionOf(summary("a", "running", { completedAt: 1 }))).toBe("working");
    expect(sectionOf(summary("a", "needsApproval", { completedAt: 1 }))).toBe("needsYou");
  });

  it("needs you once babysitting stops on an idle thread", () => {
    const stopped = {
      ...initialBabysitState(0),
      phase: "stopped" as const,
      stopReason: "rounds" as const,
    };
    expect(sectionOf(summary("a", "idle", { babysit: stopped }))).toBe("needsYou");
    expect(sectionOf(summary("a", "cold", { babysit: stopped }))).toBe("needsYou");
    expect(sectionOf(summary("a", "running", { babysit: stopped }))).toBe("working");
    expect(sectionOf(summary("a", "idle", { babysit: initialBabysitState(0) }))).toBe("idle");
  });
});

describe("nextNeedsYou", () => {
  const threads = [
    summary("late", "needsApproval", { lastActivityAt: 9 }),
    summary("early", "needsInput", { lastActivityAt: 1 }),
    summary("busy", "running"),
  ];

  it("starts with the longest-waiting thread and wraps around", () => {
    expect(nextNeedsYou(threads, undefined)).toBe("early");
    expect(nextNeedsYou(threads, "early")).toBe("late");
    expect(nextNeedsYou(threads, "late")).toBe("early");
  });

  it("returns undefined when nothing needs you", () => {
    expect(nextNeedsYou([summary("busy", "running")], undefined)).toBeUndefined();
  });
});

describe("splitForTree", () => {
  const ws = "w-1" as WorkspaceId;
  const known = new Set<string>([ws]);
  const spawnedBy = { threadId: "orch" as ThreadId, feature: "mail-trigger" };
  const orchestrator = summary("orch", "idle", { role: "orchestrator", workspaceId: ws });
  const busy = summary("busy", "running", { workspaceId: ws, spawnedBy });
  const asking = summary("asking", "needsApproval", { workspaceId: ws, spawnedBy });
  const plain = summary("plain", "needsInput");

  it("leaves the sidebar as it was while there are no workspaces", () => {
    const all = [orchestrator, busy, asking, plain];
    expect(splitForTree(all, new Set())).toEqual({ listed: all, tree: [], surfaced: [] });
  });

  it("moves a workspace's threads to the tree and surfaces the ones that need the user", () => {
    const split = splitForTree([orchestrator, busy, asking, plain], known);
    expect(split.listed).toEqual([plain]);
    expect(split.tree).toEqual([orchestrator, busy, asking]);
    expect(split.surfaced).toEqual([asking]);
  });

  it("surfaces a pinned worker that needs the user, and not a parked one", () => {
    const pinned = summary("pinned", "needsApproval", { workspaceId: ws, spawnedBy, pinned: true });
    const parked = summary("parked", "error", { workspaceId: ws, spawnedBy, parked: true });
    expect(splitForTree([pinned, parked], known).surfaced).toEqual([pinned]);
  });

  it("does not surface an archived worker's stale error, but preserves real requests", () => {
    const archivedError = summary("archived-error", "error", {
      workspaceId: ws,
      spawnedBy,
    });
    const archivedAsking = {
      ...summary("archived-asking", "error", { workspaceId: ws, spawnedBy }),
      pendingRequests: [{ id: "request" } as never],
    };
    const archived = new Set(["archived-error", "archived-asking"]);
    expect(splitForTree([archivedError, archivedAsking], known, archived).surfaced).toEqual([
      archivedAsking,
    ]);
  });

  it("keeps a detached worker, a removed workspace's thread and a plain thread in the groups", () => {
    expect(livesInTree({ spawnedBy }, known)).toBe(false);
    expect(livesInTree({ spawnedBy, workspaceId: "w-gone" as WorkspaceId }, known)).toBe(false);
    expect(livesInTree({ workspaceId: ws }, known)).toBe(false);
    expect(livesInTree({ role: "dream", workspaceId: ws }, known)).toBe(true);
  });

  it("leaves ⌘⇧U reaching workers, and lists only the threads outside a workspace", () => {
    const all = [orchestrator, busy, asking, plain];
    expect(nextNeedsYou(all, undefined)).toBeDefined();
    expect(new Set([nextNeedsYou(all, "asking"), nextNeedsYou(all, "plain")])).toEqual(
      new Set(["asking", "plain"]),
    );
    const { listed } = splitForTree(all, known);
    expect(listed.map((s) => s.thread.id)).toEqual(["plain"]);
  });
});

describe("selectListed", () => {
  const git: GitState = {
    repo: true,
    worktree: false,
    head: "a1",
    changesToken: "0",
    changedFiles: 0,
    behindBase: 0,
    aheadBase: 0,
    conflicts: false,
    pr: {
      number: 12,
      state: "OPEN",
      url: "https://github.com/o/r/pull/12",
      title: "Fix",
      isDraft: false,
      checks: "passing",
      headMatches: true,
      aheadOfPr: false,
    },
  };
  const a = { ...summary("a", "idle"), git };
  const b = summary("b", "running");
  const listed = selectListed({ byId: { a, b } });
  const withA = (next: ThreadSummary) => selectListed({ byId: { a: next, b } });

  it("keeps the map for git no list reads, and the summary it listed", () => {
    selectListed({ byId: listed });
    const next = withA({ ...a, git: { ...git, changedFiles: 3, upstream: "ahead" } });
    expect(next).toBe(listed);
    expect(next["a"]).toBe(a);
  });

  it("lists anew for what a list reads: the thread, its status, its PR, its attention", () => {
    for (const next of [
      { ...a, status: "running" as const },
      { ...a, thread: { ...a.thread, title: "Renamed" } },
      { ...a, git: { ...git, pr: { ...git.pr!, state: "MERGED" as const } } },
      { ...a, git: { ...git, pr: { ...git.pr!, checks: "failing" as const } } },
      { ...a, git: { ...git, origin: "o/r" } },
    ]) {
      selectListed({ byId: listed });
      const shown = withA(next);
      expect(shown).not.toBe(listed);
      expect(shown["a"]).toBe(next);
      expect(shown["b"]).toBe(b);
    }
  });

  it("lists anew when a thread comes or goes", () => {
    selectListed({ byId: listed });
    expect(selectListed({ byId: { a } })).toEqual({ a });
    expect(selectListed({ byId: { a, b, c: b } })).toEqual({ a, b, c: b });
  });
});
