// e2e specs set this sessionStorage flag so every project lists several thread-less worktrees, for
// bulk selection; by default only the one experiment worktree is removable.

/** `"many"`: more removable worktrees next to the experiment one. */
export const MOCK_WORKTREES_KEY = "gram.mock.worktrees";

export interface MockExtraWorktree {
  readonly folder: string;
  readonly branch: string;
  readonly changedFiles: number;
  readonly aheadBase: number;
}

export const MOCK_MANY_WORKTREES: readonly MockExtraWorktree[] = [
  { folder: "spike-retry", branch: "spike/retry", changedFiles: 0, aheadBase: 0 },
  { folder: "docs-refresh", branch: "docs/refresh", changedFiles: 1, aheadBase: 2 },
  { folder: "perf-probe", branch: "perf/probe", changedFiles: 0, aheadBase: 0 },
];

export const mockManyWorktrees = (): boolean => {
  try {
    return (
      typeof sessionStorage !== "undefined" && sessionStorage.getItem(MOCK_WORKTREES_KEY) === "many"
    );
  } catch {
    return false;
  }
};
