import {
  inactiveCandidate,
  keepReason,
  type CleanUpResult,
  type StorageReport,
  type StorageWorktree,
  type ThreadId,
  type WorktreeEntry,
} from "@gram/contracts";

import { createMockWorktrees, MOCK_EXPERIMENT, MOCK_WORKTREE_BYTES } from "../mock-worktrees";
import type { MockWorld } from "../mock-world";
import type { RemoveWorktreeOptions } from "../types";
import type { WorktreesApi } from "./types";

/** The permission rules every mock linked worktree has approved that its main checkout hasn't. */
export const PENDING_RULES = ["Bash(pnpm test:*)", "WebFetch(domain:github.com)"];

const DAY = 24 * 60 * 60_000;
const GB = 1024 ** 3;

/** A worktree Settings › Storage lists beside the threads' ones, in the first seeded repo. */
interface StorageSeed {
  /** Under the repo, or an absolute folder for one Gram didn't make. */
  readonly folder: string;
  readonly branch?: string;
  readonly daysIdle: number;
  readonly gb: number;
  readonly changedFiles?: number;
  readonly unpushed?: number;
  readonly settled?: boolean;
  readonly missing?: boolean;
  readonly pr?: StorageWorktree["pr"];
}

/** One of each kind of worktree a repo gathers, so every Storage group has rows. */
export const STORAGE_SEEDS: readonly StorageSeed[] = [
  {
    folder: ".worktrees/feat-onboarding-copy",
    branch: "feat/onboarding-copy",
    daysIdle: 12,
    gb: 0.9,
    pr: { number: 231, state: "OPEN" },
  },
  { folder: ".worktrees/spike-sse-retry", branch: "spike/sse-retry", daysIdle: 41, gb: 1.6 },
  {
    folder: ".worktrees/fix-sidebar-scroll",
    branch: "fix/sidebar-scroll",
    daysIdle: 45,
    gb: 2.1,
    settled: true,
    pr: { number: 212, state: "MERGED" },
  },
  {
    folder: ".worktrees/feat-usage-chart",
    branch: "feat/usage-chart",
    daysIdle: 72,
    gb: 1.8,
    settled: true,
    pr: { number: 198, state: "CLOSED" },
  },
  {
    folder: ".worktrees/chore-deps-bump",
    branch: "chore/deps-bump",
    daysIdle: 96,
    gb: 2.4,
    settled: true,
    pr: { number: 176, state: "MERGED" },
  },
  {
    folder: ".worktrees/spike-old-cache",
    branch: "spike/old-cache",
    daysIdle: 130,
    gb: 0,
    missing: true,
  },
  {
    folder: ".worktrees/wip-diff-perf",
    branch: "wip/diff-perf",
    daysIdle: 3,
    gb: 1.1,
    changedFiles: 3,
  },
  { folder: ".worktrees/feat-export", branch: "feat/export", daysIdle: 64, gb: 0.7, unpushed: 2 },
  { folder: "/private/tmp/agent-shell-3f9a1c", daysIdle: 95, gb: 1.3, settled: true },
  { folder: "/private/tmp/agent-shell-77e0b2", daysIdle: 33, gb: 1.2, changedFiles: 1 },
  { folder: "/var/folders/xk/T/codex-wt-5521", daysIdle: 140, gb: 0, settled: true, missing: true },
];

const seedPath = (root: string, seed: StorageSeed) =>
  seed.folder.startsWith("/") ? seed.folder : `${root}/${seed.folder}`;

/** What a Storage row takes on disk: its seed's size, else every mock worktree's. */
const sizeOf = (entry: StorageWorktree): number => {
  if (entry.missing) return 0;
  const seed = STORAGE_SEEDS.find((s) => seedPath(entry.repoTop, s) === entry.path);
  return seed === undefined ? MOCK_WORKTREE_BYTES : seed.gb * GB;
};

const DISK_TOTAL = 994 * GB;
const DISK_FREE = 32.4 * GB;

/**
 * The repos' worktrees: each thread's, plus the thread-less ones a repo seeds. The core builds it,
 * because binding a thread's PR goes through it; `api` is what joins the `Api`.
 */
export function createWorktreesMock(world: MockWorld) {
  const checkouts = createMockWorktrees({
    threads: () => world.threads(),
    projectRoots: () => world.projects().map((p) => p.root),
    thread: (threadId) => world.summary(threadId).thread,
    replace: (thread) => world.replaceThread(thread),
    pendingRules: PENDING_RULES,
  });
  let lastRemove: { path: string; options: RemoveWorktreeOptions } | undefined;
  /** Storage seeds and threads' worktrees removed through Settings › Storage, and bytes freed. */
  const cleaned = new Set<string>();
  let freed = 0;

  const storage = (): StorageReport => {
    const now = Date.now();
    const threads = world.threads().map((summary) => summary.thread);
    const projects = world.projects().filter((p) => p.repoRoot !== undefined);
    const worktrees: StorageWorktree[] = [];
    projects.forEach((project, index) => {
      const repoTop = project.root;
      for (const thread of threads) {
        if (thread.projectId !== project.id || thread.checkout.kind !== "worktree") continue;
        const path = thread.checkout.path;
        if (cleaned.has(path) || worktrees.some((w) => w.path === path)) continue;
        worktrees.push({
          path,
          repoTop,
          ...(thread.checkout.branch === undefined ? {} : { branch: thread.checkout.branch }),
          group: "inUse",
          madeByGram: true,
          threadId: thread.id,
          threadTitle: thread.title,
          lastActivity: thread.lastActivityAt,
          missing: false,
          changedFiles: 0,
          unpushed: 0,
          settled: false,
        });
      }
      for (const [path, branch] of checkouts.extra(repoTop)) {
        if (cleaned.has(path)) continue;
        const experiment = branch === MOCK_EXPERIMENT.branch;
        worktrees.push({
          path,
          repoTop,
          branch,
          group: experiment ? "kept" : "idle",
          madeByGram: true,
          lastActivity: now - 6 * DAY,
          missing: false,
          changedFiles: experiment ? MOCK_EXPERIMENT.changedFiles : 0,
          unpushed: experiment ? MOCK_EXPERIMENT.aheadBase : 0,
          settled: false,
        });
      }
      if (index !== 0) return;
      for (const seed of STORAGE_SEEDS) {
        const path = seedPath(repoTop, seed);
        if (cleaned.has(path)) continue;
        const madeByGram = !seed.folder.startsWith("/");
        const changedFiles = seed.changedFiles ?? 0;
        const unpushed = seed.unpushed ?? 0;
        const settled = seed.settled ?? false;
        worktrees.push({
          path,
          repoTop,
          ...(seed.branch === undefined ? {} : { branch: seed.branch }),
          group: !madeByGram
            ? "foreign"
            : seed.missing === true
              ? "removable"
              : changedFiles > 0 || unpushed > 0
                ? "kept"
                : settled
                  ? "removable"
                  : "idle",
          madeByGram,
          lastActivity: now - seed.daysIdle * DAY,
          missing: seed.missing ?? false,
          changedFiles,
          unpushed,
          settled,
          ...(seed.pr === undefined ? {} : { pr: seed.pr }),
        });
      }
    });
    return {
      worktrees,
      disk: { freeBytes: DISK_FREE + freed, totalBytes: DISK_TOTAL },
      failedRepos: [],
    };
  };

  const api: WorktreesApi = {
    listWorktrees: async (repoPath) => {
      const threads = world.threads().map((summary) => summary.thread);
      // Like `git worktree list`, any folder of the repo works, including a linked worktree.
      const project = world
        .projects()
        .find(
          (p) =>
            p.root === repoPath ||
            p.repoRoot === repoPath ||
            repoPath.startsWith(`${p.root}/`) ||
            threads.some((t) => t.projectId === p.id && t.checkout.path === repoPath),
        );
      if (!project) return { repoTop: repoPath, worktrees: [] };
      const activity = (path: string) =>
        Math.max(
          0,
          ...threads.filter((t) => t.checkout.path === path).map((t) => t.lastActivityAt),
        );
      const entry = (path: string, branch: string, isMain: boolean): WorktreeEntry => ({
        path,
        branch,
        detached: false,
        isMain,
        isOpen: threads.some((t) => t.checkout.path === path),
        lastActivity: activity(path),
      });
      const worktreePaths = new Map(
        threads
          .filter((t) => t.projectId === project.id && t.checkout.kind === "worktree")
          .map((t) => [t.checkout.path, t.checkout.branch ?? "detached"]),
      );
      for (const [path, branch] of checkouts.extra(project.root)) {
        worktreePaths.set(path, branch);
      }
      return {
        repoTop: project.root,
        worktrees: [
          entry(project.root, "main", true),
          ...[...worktreePaths].map(([path, branch]) => entry(path, branch, false)),
        ],
      };
    },
    worktreeStatus: (path) => checkouts.status(path),
    worktreePendingPermissions: (path) => checkouts.pendingPermissions(path),
    worktreeSize: async (path) => {
      const entry = storage().worktrees.find((w) => w.path === path);
      if (entry !== undefined && !entry.threadId) return { bytes: sizeOf(entry), partial: false };
      return checkouts.size(path);
    },
    removeWorktree: async (path, options) => {
      lastRemove = { path, options };
      await checkouts.remove(path, options);
      return {};
    },
    storageReport: async () => storage(),
    cleanupPlan: async (inactiveDays) => {
      const now = Date.now();
      const picked = storage().worktrees.filter((w) => inactiveCandidate(w, inactiveDays, now));
      return {
        worktrees: picked,
        bytes: picked.reduce((sum, w) => sum + sizeOf(w), 0),
        partial: false,
      };
    },
    cleanUpWorktrees: async (paths, options = {}) => {
      const report = storage();
      const confirmed = options.confirmed ?? [];
      const result: { -readonly [K in keyof CleanUpResult]: CleanUpResult[K] } = {
        removed: [],
        kept: [],
        pruned: 0,
        bytes: 0,
      };
      const pruned = new Set<string>();
      for (const path of paths) {
        const entry = report.worktrees.find((w) => w.path === path);
        const reason = keepReason(entry, confirmed);
        if (entry === undefined || reason !== undefined) {
          result.kept = [...result.kept, { path, reason: reason ?? "not found" }];
          continue;
        }
        // The repo's own thread-less worktrees go the Worktrees dialog's way too.
        if (checkouts.extra(entry.repoTop).some(([extra]) => extra === path)) {
          await checkouts.remove(path, { force: true });
        }
        cleaned.add(path);
        if (entry.missing) {
          pruned.add(path);
          continue;
        }
        const bytes = sizeOf(entry);
        freed += bytes;
        result.removed = [...result.removed, { path, bytes }];
        result.bytes += bytes;
      }
      if (options.prune === true) {
        for (const entry of report.worktrees) {
          if (!entry.missing || entry.threadId) continue;
          cleaned.add(entry.path);
          pruned.add(entry.path);
        }
      }
      result.pruned = pruned.size;
      return result;
    },
  };
  return {
    api,
    /** The last `removeWorktree`'s arguments, for tests. */
    lastRemove: () => lastRemove,
    bind: (threadId: ThreadId, repo: string, number: number, monitor?: boolean) =>
      checkouts.bind(threadId, repo, number, monitor),
    unbind: (threadId: ThreadId) => checkouts.unbind(threadId),
    setMonitor: (threadId: ThreadId, monitor: boolean) => checkouts.setMonitor(threadId, monitor),
  };
}
