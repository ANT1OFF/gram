import * as fs from "node:fs";
import * as nodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import {
  inactiveCandidate,
  keepReason,
  type Project,
  type ProjectId,
  type StorageWorktree,
  type Thread,
  type ThreadId,
  type WorkspaceId,
  type WorkspaceState,
} from "@gram/contracts";
import { ProcLive, WorktreesLive, Worktrees } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { hasGit, makeRepo, removeDir, run, tempDir, write } from "./test-repo.ts";
import {
  classifyWorktree,
  cleanUp,
  cleanupNote,
  cleanupNotes,
  cleanupPlan,
  digestBytes,
  parseBranchPrs,
  prunedCount,
  storageReport,
  type BranchPr,
  type CleanUpSources,
} from "./storage.ts";

const DAY = 86_400_000;
const NOW = 400 * DAY;

const entry = (overrides: Partial<StorageWorktree> = {}): StorageWorktree => ({
  path: "/r/.worktrees/feat-x",
  repoTop: "/r",
  branch: "feat/x",
  group: "removable",
  madeByGram: true,
  lastActivity: NOW - 100 * DAY,
  missing: false,
  changedFiles: 0,
  unpushed: 0,
  settled: true,
  ...overrides,
});

const project = (id: string, repoRoot: string): Project => ({
  id: id as ProjectId,
  root: repoRoot,
  name: id,
  repoRoot,
  bookmarked: false,
});

const workspace = (id: string, projectIds: string[]): Pick<WorkspaceState, "workspace"> => ({
  workspace: {
    id: id as WorkspaceId,
    name: id,
    projectIds: projectIds as [ProjectId, ...ProjectId[]],
    homeProjectId: projectIds[0] as ProjectId,
    createdAt: 0,
  },
});

const openThread = (path: string): Thread => ({
  id: "t-open" as ThreadId,
  projectId: "p-1" as ProjectId,
  title: "Open thread",
  userNamed: true,
  model: { agent: "claude", model: "opus" },
  mode: "auto",
  checkout: { kind: "worktree", path, branch: "feat/open" },
  labels: [],
  pinned: false,
  parked: false,
  unread: false,
  createdAt: 0,
  lastActivityAt: NOW,
});

/** Sources over real git; `live.threads` is what a re-read right before each removal finds. */
const sourcesFor = (repo: string, open: string, live = { threads: [openThread(open)] }) =>
  Effect.gen(function* () {
    const worktrees = yield* Worktrees;
    const sources: CleanUpSources = {
      projects: [
        { id: "p-1" as ProjectId, root: repo, name: "repo", repoRoot: repo, bookmarked: false },
      ],
      openThreads: [openThread(open)],
      currentThreads: Effect.sync(() => live.threads),
      listLinked: (top) =>
        worktrees
          .list(top, { openCheckouts: [] })
          .pipe(Effect.map((list) => list.worktrees.filter((w) => !w.isMain))),
      // Synthetic GitHub: feat/merged's PR merged; nothing asks the host's gh.
      branchPrs: () =>
        Effect.succeed(
          new Map<string, BranchPr>([
            ["feat/merged", { number: 7, state: "MERGED", headRefOid: undefined }],
          ]),
        ),
      remove: (request) =>
        worktrees.remove({
          repoPath: request.repoTop,
          worktreeDir: request.path,
          force: request.force,
          openCheckouts: request.openCheckouts,
        }),
    };
    return sources;
  });

const CLEAN = {
  madeByGram: true,
  inUse: false,
  missing: false,
  unreadable: false,
  changedFiles: 0,
  unpushed: 0,
  settled: false,
};

describe("classifyWorktree", () => {
  it("puts a thread's worktree in use whatever its state, and keeps any work", () => {
    expect(classifyWorktree({ ...CLEAN, inUse: true, changedFiles: 3 })).toBe("inUse");
    expect(classifyWorktree({ ...CLEAN, inUse: true, madeByGram: false })).toBe("inUse");
    expect(classifyWorktree({ ...CLEAN, changedFiles: 1, settled: true })).toBe("kept");
    expect(classifyWorktree({ ...CLEAN, unpushed: 2, settled: true })).toBe("kept");
    expect(classifyWorktree({ ...CLEAN, unreadable: true, settled: true })).toBe("kept");
    expect(classifyWorktree({ ...CLEAN, settled: true })).toBe("removable");
    expect(classifyWorktree({ ...CLEAN, missing: true, changedFiles: 1 })).toBe("removable");
    expect(classifyWorktree(CLEAN)).toBe("idle");
    expect(classifyWorktree({ ...CLEAN, madeByGram: false, settled: true })).toBe("foreign");
  });
});

describe("inactiveCandidate and keepReason", () => {
  it("takes only Gram's idle or removable worktrees with nothing to lose, past the days", () => {
    expect(inactiveCandidate(entry(), 30, NOW)).toBe(true);
    expect(inactiveCandidate(entry({ group: "idle", settled: false }), 90, NOW)).toBe(true);
    expect(inactiveCandidate(entry({ lastActivity: NOW - 10 * DAY }), 30, NOW)).toBe(false);
    expect(inactiveCandidate(entry({ group: "kept", unpushed: 1 }), 30, NOW)).toBe(false);
    expect(inactiveCandidate(entry({ group: "inUse" }), 30, NOW)).toBe(false);
    expect(inactiveCandidate(entry({ group: "foreign", madeByGram: false }), 30, NOW)).toBe(false);
    // Unknown activity is never read as old.
    expect(inactiveCandidate(entry({ lastActivity: 0 }), 30, NOW)).toBe(false);
    expect(inactiveCandidate(entry({ lastActivity: 0, missing: true }), 30, NOW)).toBe(true);
  });

  it("refuses work unless the user named that worktree, and never one in use", () => {
    const dirty = entry({ group: "kept", changedFiles: 2 });
    const named = { path: dirty.path, changedFiles: 2, unpushed: 0 };
    expect(keepReason(dirty, [])).toBe("it has uncommitted or unpushed work");
    expect(keepReason(dirty, [{ ...named, path: "/r/.worktrees/other" }])).toBeDefined();
    expect(keepReason(dirty, [named])).toBeUndefined();
    // More work than the confirmation showed keeps it.
    expect(keepReason(dirty, [{ ...named, changedFiles: 1 }])).toBe(
      "it has more work than was confirmed",
    );
    expect(keepReason(entry({ group: "inUse" }), [named])).toBe("an open thread uses it");
    expect(keepReason(entry({ group: "kept", locked: true }), [named])).toBe("it is locked");
    expect(keepReason(undefined, [])).toBeDefined();
    expect(keepReason(entry(), [])).toBeUndefined();
    // Another tool's folder goes only when named, even with nothing to lose.
    const foreign = entry({ group: "foreign", madeByGram: false, path: "/tmp/agent" });
    expect(keepReason(foreign, [])).toBe("Gram didn't make it, and it wasn't confirmed by name");
    expect(keepReason(foreign, [{ path: "/tmp/agent", changedFiles: 0, unpushed: 0 }])).toBe(
      undefined,
    );
    expect(keepReason(entry({ ...foreign, missing: true }), [])).toBeUndefined();
  });
});

describe("digest lines", () => {
  it("says the count and bytes once per workspace that has the repo", () => {
    expect(digestBytes(1.2 * 1024 ** 3)).toBe("1.2 GB");
    expect(digestBytes(340 * 1024 ** 2)).toBe("340 MB");
    expect(cleanupNote(1, 0)).toBe("Cleaned 1 worktree, 0 B.");
    const notes = cleanupNotes(
      [
        { repoTop: "/a", bytes: 1024 ** 3 },
        { repoTop: "/a", bytes: 0.2 * 1024 ** 3 },
        { repoTop: "/b", bytes: 1024 ** 2, workspaceId: "ws-b" as WorkspaceId },
        { repoTop: "/c", bytes: 5 },
      ],
      [workspace("ws-a", ["p-a"]), workspace("ws-both", ["p-a", "p-b"])],
      [project("p-a", "/a"), project("p-b", "/b")],
    );
    expect(notes).toEqual([
      { workspaceId: "ws-a", note: "Cleaned 2 worktrees, 1.2 GB." },
      { workspaceId: "ws-both", note: "Cleaned 3 worktrees, 1.2 GB." },
      { workspaceId: "ws-b", note: "Cleaned 1 worktree, 1.0 MB." },
    ]);
  });
});

describe("parsing", () => {
  it("keeps the newest PR of a branch and drops what isn't one", () => {
    const prs = parseBranchPrs(
      JSON.stringify([
        { number: 9, state: "MERGED", headRefName: "feat/x", headRefOid: "abc" },
        { number: 3, state: "CLOSED", headRefName: "feat/x" },
        { number: 4, state: "DRAFT", headRefName: "feat/y" },
        { state: "OPEN", headRefName: "feat/z" },
      ]),
    );
    expect([...prs]).toEqual([["feat/x", { number: 9, state: "MERGED", headRefOid: "abc" }]]);
    expect(parseBranchPrs("not json").size).toBe(0);
    expect(
      prunedCount("Removing worktrees/a: gitdir file points to non-existent location\nother\n"),
    ).toBe(1);
  });
});

describe.skipIf(!hasGit)("storage over real git", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) removeDir(dir);
  });

  /**
   * A repo with a bare origin and five worktrees: `merged` (pushed, its PR merged), `wip` (dirty),
   * `local` (an unpushed commit), `open` (a thread's), and `scratch`, detached in a folder Gram
   * doesn't use and already in `main`.
   */
  const setup = () => {
    const dir = tempDir();
    dirs.push(dir);
    const repo = makeRepo(dir);
    const origin = nodePath.join(dir, "origin.git");
    run(dir, "init", "-q", "--bare", origin);
    run(repo, "remote", "add", "origin", origin);
    run(repo, "push", "-q", "-u", "origin", "main");
    const add = (name: string) => {
      const tree = nodePath.join(repo, ".worktrees", name);
      run(repo, "worktree", "add", "-q", "-b", `feat/${name}`, tree);
      return tree;
    };
    const merged = add("merged");
    write(nodePath.join(merged, "done.txt"), "done\n");
    run(merged, "add", "-A");
    run(merged, "commit", "-qm", "done");
    run(merged, "push", "-q", "-u", "origin", "feat/merged");
    const wip = add("wip");
    write(nodePath.join(wip, "tracked.txt"), "changed\n");
    const local = add("local");
    write(nodePath.join(local, "l.txt"), "l\n");
    run(local, "add", "-A");
    run(local, "commit", "-qm", "local only");
    const open = add("open");
    const scratch = nodePath.join(dir, "agent-shell-scratch");
    run(repo, "worktree", "add", "-q", "--detach", scratch, "main");
    // Something agent shells leave behind: a registration whose folder went.
    const gone = nodePath.join(dir, "gone-tree");
    run(repo, "worktree", "add", "-q", "--detach", gone, "main");
    fs.rmSync(gone, { recursive: true, force: true });
    return { dir, repo, merged, wip, local, open, scratch, gone };
  };

  const live = Effect.provide(WorktreesLive.pipe(Layer.provideMerge(ProcLive)));

  it.effect("groups each worktree by what removing it would lose", () =>
    Effect.gen(function* () {
      const t = setup();
      const sources = yield* sourcesFor(t.repo, t.open);
      const report = yield* storageReport(sources);
      const by = (path: string) => report.worktrees.find((w) => w.path === path);
      expect(by(t.merged)).toMatchObject({
        group: "removable",
        madeByGram: true,
        settled: true,
        pr: { number: 7, state: "MERGED" },
      });
      expect(by(t.wip)).toMatchObject({ group: "kept", changedFiles: 1, unpushed: 0 });
      expect(by(t.local)).toMatchObject({ group: "kept", changedFiles: 0, unpushed: 1 });
      expect(by(t.open)).toMatchObject({ group: "inUse", threadId: "t-open" });
      expect(by(t.scratch)).toMatchObject({ group: "foreign", madeByGram: false, settled: true });
      expect(by(t.gone)).toMatchObject({ group: "foreign", missing: true });
      expect(report.failedRepos).toEqual([]);
      expect(report.disk?.freeBytes).toBeGreaterThan(0);
      expect(by(t.merged)!.lastActivity).toBeGreaterThan(0);
    }).pipe(live),
  );

  it.effect("plans and cleans only what loses nothing, unless the user named it", () =>
    Effect.gen(function* () {
      const t = setup();
      const sources = yield* sourcesFor(t.repo, t.open);
      // Everything is fresh: nothing is inactive yet.
      const now = Date.now();
      expect((yield* cleanupPlan(yield* storageReport(sources), 30, now)).worktrees).toEqual([]);
      const plan = yield* cleanupPlan(yield* storageReport(sources), 30, now + 31 * DAY);
      expect(plan.worktrees.map((w) => w.path)).toEqual([t.merged]);
      expect(plan.bytes).toBeGreaterThan(0);

      const all = [t.merged, t.wip, t.local, t.open, t.scratch];
      const first = yield* cleanUp(sources, { paths: all, confirmed: [], prune: false });
      expect(first.result.removed.map((r) => r.path)).toEqual([t.merged]);
      expect(first.result.kept.map((k) => [k.path, k.reason])).toEqual([
        [t.wip, "it has uncommitted or unpushed work"],
        [t.local, "it has uncommitted or unpushed work"],
        [t.open, "an open thread uses it"],
        [t.scratch, "Gram didn't make it, and it wasn't confirmed by name"],
      ]);
      expect(fs.existsSync(t.merged)).toBe(false);
      expect(fs.existsSync(t.wip)).toBe(true);
      expect(fs.existsSync(t.scratch)).toBe(true);
      expect(first.cleaned).toHaveLength(1);
      // Branches stay, so a removed worktree can come back.
      expect(run(t.repo, "branch", "--list", "feat/merged").trim()).toContain("feat/merged");

      // Named by the user: the dirty one goes, the open thread's still doesn't. A prune drops the
      // registration whose folder had already gone.
      // `local` was confirmed as it was before another commit landed in it.
      write(nodePath.join(t.local, "l2.txt"), "l2\n");
      run(t.local, "add", "-A");
      run(t.local, "commit", "-qm", "another local commit");
      const second = yield* cleanUp(sources, {
        paths: [t.wip, t.open, t.local],
        confirmed: [
          { path: t.wip, changedFiles: 1, unpushed: 0 },
          { path: t.open, changedFiles: 0, unpushed: 0 },
          { path: t.local, changedFiles: 0, unpushed: 1 },
        ],
        prune: true,
      });
      expect(second.result.removed.map((r) => r.path)).toEqual([t.wip]);
      expect(second.result.kept).toEqual([
        { path: t.open, reason: "an open thread uses it" },
        { path: t.local, reason: "it has more work than was confirmed" },
      ]);
      expect(second.result.pruned).toBe(1);
      expect(run(t.repo, "worktree", "list")).not.toContain("gone-tree");
      expect(fs.existsSync(t.local)).toBe(true);
    }).pipe(live),
  );

  it.effect("keeps a worktree a thread opened, or work landed in, after the report was read", () =>
    Effect.gen(function* () {
      const t = setup();
      const threads = { threads: [openThread(t.open)] };
      const sources = yield* sourcesFor(t.repo, t.open, threads);
      // The removal re-reads the threads: one opened in `merged` since the report keeps it.
      threads.threads = [openThread(t.open), { ...openThread(t.merged), id: "t-late" as ThreadId }];
      const raced = yield* cleanUp(sources, { paths: [t.merged], confirmed: [], prune: false });
      expect(raced.result.kept).toEqual([{ path: t.merged, reason: "an open thread uses it" }]);
      expect(fs.existsSync(t.merged)).toBe(true);
      // A lock keeps it whatever the confirmation says.
      run(t.repo, "worktree", "lock", t.merged);
      threads.threads = [openThread(t.open)];
      const report = yield* storageReport(sources);
      expect(report.worktrees.find((w) => w.path === t.merged)).toMatchObject({
        group: "kept",
        locked: true,
      });
      const locked = yield* cleanUp(sources, {
        paths: [t.merged],
        confirmed: [{ path: t.merged, changedFiles: 0, unpushed: 0 }],
        prune: false,
      });
      expect(locked.result.kept).toEqual([{ path: t.merged, reason: "it is locked" }]);
      expect(fs.existsSync(t.merged)).toBe(true);
      // A folder deleted between the report and the removal is pruned, not removed.
      run(t.repo, "worktree", "unlock", t.merged);
      const vanishing: CleanUpSources = {
        ...sources,
        currentThreads: Effect.sync(() => {
          fs.rmSync(t.merged, { recursive: true, force: true });
          return threads.threads;
        }),
      };
      const vanished = yield* cleanUp(vanishing, {
        paths: [t.merged],
        confirmed: [],
        prune: false,
      });
      expect(vanished.result).toMatchObject({ removed: [], kept: [] });
      expect(vanished.result.pruned).toBeGreaterThanOrEqual(1);
      expect(run(t.repo, "worktree", "list")).not.toContain(".worktrees/merged");
    }).pipe(live),
  );
});
