import type { BoundPr, GitState, Thread, ThreadId, ThreadSummary } from "@gram/contracts";

import { MockInvalidState } from "./mock-fs";
import {
  MOCK_MANY_WORKTREES,
  mockManyWorktrees,
  type MockExtraWorktree,
} from "./mock-worktrees-many";
import type { RemoveWorktreeOptions } from "./types";

// Worktrees without a thread (status, removal) and PR binding for MockApi.

/** The thread-less worktree every seeded project lists; it has uncommitted and unmerged work. */
export const MOCK_EXPERIMENT: MockExtraWorktree = {
  folder: "cache-experiment",
  branch: "experiment/cache",
  changedFiles: 2,
  aheadBase: 1,
};

const cleanState = (branch: string | undefined, worktree: boolean): GitState => ({
  repo: true,
  ...(branch === undefined ? {} : { branch }),
  worktree,
  head: "4b1d0c9e2a7f3d58c6e1b0a9f8d7c6b5a4e3d2c1",
  changesToken: "mock-clean",
  changedFiles: 0,
  base: "origin/main",
  behindBase: 0,
  aheadBase: 0,
  conflicts: false,
});

const gitError = (message: string) => Object.assign(new Error(message), { _tag: "GitError" });

const extraPath = (root: string, extra: MockExtraWorktree) => `${root}/.worktrees/${extra.folder}`;

/** What every mock linked worktree takes on disk: a checkout with `node_modules` and a build. */
export const MOCK_WORKTREE_BYTES = 1.2 * 1024 ** 3;

const extras = () => [MOCK_EXPERIMENT, ...(mockManyWorktrees() ? MOCK_MANY_WORKTREES : [])];

export interface MockWorktreesHost {
  threads(): readonly ThreadSummary[];
  projectRoots(): readonly string[];
  thread(threadId: ThreadId): Thread;
  /** Stores the thread and emits `thread.upsert`. */
  replace(thread: Thread): void;
  pendingRules: readonly string[];
}

export function createMockWorktrees(host: MockWorktreesHost) {
  const removed = new Set<string>();
  const isMain = (path: string) => host.projectRoots().includes(path);
  const threadAt = (path: string) => host.threads().find((s) => s.thread.checkout.path === path);
  const extraAt = (path: string) =>
    removed.has(path)
      ? undefined
      : extras().find((extra) =>
          host.projectRoots().some((root) => extraPath(root, extra) === path),
        );

  const status = (path: string): GitState => {
    if (isMain(path)) return cleanState("main", false);
    const extra = extraAt(path);
    if (extra) {
      return {
        ...cleanState(extra.branch, true),
        changesToken: `mock-${extra.folder}`,
        changedFiles: extra.changedFiles,
        aheadBase: extra.aheadBase,
      };
    }
    const summary = threadAt(path);
    if (!summary) throw gitError(`fatal: '${path}' is not a working tree`);
    const { checkout } = summary.thread;
    return summary.git ?? cleanState(checkout.branch, checkout.kind === "worktree");
  };

  return {
    /** Thread-less worktrees to list for `root`, path to branch. */
    extra(root: string): [path: string, branch: string][] {
      return extras()
        .map((extra): [string, string] => [extraPath(root, extra), extra.branch])
        .filter(([path]) => !removed.has(path));
    },

    async status(path: string) {
      return status(path);
    },

    async pendingPermissions(path: string) {
      status(path);
      return isMain(path) ? [] : host.pendingRules;
    },

    async size(path: string) {
      if (isMain(path)) throw new MockInvalidState(`${path} isn't a linked worktree`);
      status(path);
      return { bytes: MOCK_WORKTREE_BYTES, partial: false };
    },

    async remove(path: string, options: RemoveWorktreeOptions) {
      if (isMain(path)) throw new MockInvalidState("The main checkout can't be removed");
      if (threadAt(path)) {
        throw new MockInvalidState("A thread has this worktree open. Close the thread first.");
      }
      const { changedFiles } = status(path);
      if (!options.force && changedFiles > 0) {
        throw Object.assign(new Error(`${path} has uncommitted changes`), {
          _tag: "WorktreeDirty",
          path,
          changedFiles,
        });
      }
      removed.add(path);
    },

    async bind(threadId: ThreadId, repo: string, number: number, monitor?: boolean) {
      const current = host.thread(threadId);
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isInteger(number) || number < 1) {
        throw gitError(`Could not resolve to a PullRequest: ${repo}#${number}`);
      }
      const previous =
        current.boundPr?.repo === repo && current.boundPr.number === number
          ? current.boundPr
          : undefined;
      const boundPr: BoundPr = {
        ...previous,
        repo,
        number,
        monitor: monitor ?? previous?.monitor ?? false,
      };
      host.replace({ ...current, boundPr });
      return boundPr;
    },

    async unbind(threadId: ThreadId) {
      const { boundPr: _unbound, ...thread } = host.thread(threadId);
      host.replace(thread);
    },

    async setMonitor(threadId: ThreadId, monitor: boolean) {
      const current = host.thread(threadId);
      if (!current.boundPr) throw new MockInvalidState("No PR is bound to this thread");
      host.replace({ ...current, boundPr: { ...current.boundPr, monitor } });
    },
  };
}
