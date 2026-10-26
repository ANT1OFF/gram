import type {
  Diff,
  DiffFile,
  DiffScope,
  GitState,
  PrDetailResult,
  PrReviewState,
  PrState,
  PrStatus,
  ThreadId,
  TurnId,
} from "@gram/contracts";

import { MOCK_HEAD_OID } from "./mock-review";

// Git fixtures for MockApi: diffs, PR detail and git state per seeded thread.

/** What the PR panel's writes changed on t-flaky's PR. */
export interface MockPrWrites {
  readonly state?: PrState;
  readonly isDraft?: boolean;
}

/** What the mock has done to a thread's branch since launch: published it, created its PR. */
export interface MockCreated {
  readonly published: boolean;
  readonly pr?: NonNullable<GitState["pr"]>;
}

/** The seeded git state: only t-flaky has a PR, carrying `review` for its badge glyph. */
export function mockGitState(
  threadId: ThreadId,
  review: PrReviewState | undefined,
  created: MockCreated = { published: false },
  checks: PrStatus["checks"] = "failing",
  /** Commits t-flaky made after its PR opened that origin doesn't have yet. */
  aheadUpstream: number | undefined = undefined,
  writes: MockPrWrites = {},
): GitState | undefined {
  // t-dark's branch was never pushed: its PR panel offers Publish, then Create PR.
  if (threadId === "t-dark") {
    return {
      repo: true,
      branch: "feat/dark-mode",
      worktree: true,
      head: "d4a1c3e0000000000000000000000000000000de",
      changesToken: "mock-dark-1",
      changedFiles: 0,
      base: "origin/main",
      behindBase: 0,
      aheadBase: 3,
      conflicts: false,
      origin: "example/web",
      ...(created.published ? { upstream: "synced" as const } : {}),
      ...(created.pr ? { pr: created.pr } : {}),
    };
  }
  if (threadId !== "t-flaky") return undefined;
  return {
    repo: true,
    branch: "fix/flaky-retry",
    worktree: true,
    head: MOCK_HEAD_OID,
    changesToken: "mock-changes-1",
    changedFiles: UNCOMMITTED.length,
    base: "origin/main",
    behindBase: 0,
    aheadBase: 2,
    conflicts: false,
    upstream: aheadUpstream ? "ahead" : "synced",
    ...(aheadUpstream ? { aheadUpstream } : {}),
    origin: "example/api",
    pr: {
      number: 412,
      state: writes.state ?? "OPEN",
      url: "https://github.com/example/api/pull/412",
      title: "Make the retry test deterministic",
      isDraft: writes.isDraft ?? false,
      checks,
      headMatches: true,
      aheadOfPr: false,
      baseRef: "main",
      headRef: "fix/flaky-retry",
      author: "alex",
      additions: 2,
      deletions: 1,
      changedFiles: 1,
      headRefOid: MOCK_HEAD_OID,
      updatedAt: "2026-09-16T11:20:00Z",
      mergeState: "BLOCKED",
      reviewDecision: "CHANGES_REQUESTED",
      ...(review ? { review } : {}),
    },
  };
}

const RETRY_PATCH = [
  '@@ -12,5 +12,6 @@ describe("retry")',
  ' it("retries twice", async () => {',
  "+  const clock = useFakeTimers();",
  "   const op = flaky(2);",
  "   const result = retry(op, { attempts: 3 });",
  "-  await sleep(100);",
  "+  await clock.tickAsync(100);",
  '   expect(await result).toBe("ok");',
].join("\n");

const RETRY_FILE: DiffFile = {
  path: "src/retry.test.ts",
  status: "modified",
  additions: 2,
  deletions: 1,
  patch: RETRY_PATCH,
  binary: false,
  tooLarge: false,
};

/**
 * A lockfile bump the size of a real one, +1,840 −912 over 16 hunks, so the Diff panel meets a patch
 * that can hold it up.
 */
function lockfilePatch(): string {
  const rows: string[] = [];
  for (let h = 0; h < 16; h++) {
    const oldStart = 1 + h * 103;
    const newStart = oldStart + h * 58;
    rows.push(`@@ -${oldStart},63 +${newStart},121 @@ packages:`);
    const context = (at: number) =>
      [0, 1, 2].map((i) => `   /@example/pkg-${h}-${at + i}@1.0.0: {}`);
    rows.push(...context(0));
    for (let i = 0; i < 57; i++) rows.push(`-  /left-pad-${h}-${i}@1.${i}.0:`);
    for (let i = 0; i < 115; i++) {
      rows.push(
        i % 2 === 0
          ? `+  /left-pad-${h}-${i >> 1}@2.${i >> 1}.0:`
          : `+    resolution: {integrity: sha512-${(h * 131 + i).toString(36).repeat(8)}}`,
      );
    }
    rows.push(...context(3));
  }
  return rows.join("\n");
}

const UNCOMMITTED: DiffFile[] = [
  RETRY_FILE,
  {
    path: "docs/testing.md",
    status: "untracked",
    additions: 3,
    deletions: 0,
    patch: "@@ -0,0 +1,3 @@\n+# Testing\n+\n+Use the fake clock for anything timer-based.",
    binary: false,
    tooLarge: false,
  },
  {
    path: "src/clock.ts",
    oldPath: "src/timers.ts",
    status: "renamed",
    additions: 1,
    deletions: 1,
    patch:
      "@@ -1,3 +1,3 @@\n-export const sleep = (ms: number) =>\n+export const wait = (ms: number) =>\n   new Promise((r) => setTimeout(r, ms));\n \\ No newline at end of file",
    binary: false,
    tooLarge: false,
  },
  {
    path: "assets/retry-timeline.png",
    status: "added",
    additions: 0,
    deletions: 0,
    patch: "",
    binary: true,
    tooLarge: false,
  },
  {
    path: "pnpm-lock.yaml",
    status: "modified",
    additions: 1840,
    deletions: 912,
    patch: lockfilePatch(),
    binary: false,
    tooLarge: false,
  },
];

/** t-deps's finished turn, seeded on its reply so the transcript offers a files chip. */
export const MOCK_DEPS_TURN = "turn-deps-1" as TurnId;

const DEPS_TURN_FILES: DiffFile[] = [
  {
    path: "package.json",
    status: "modified",
    additions: 2,
    deletions: 2,
    patch:
      '@@ -21,4 +21,4 @@\n-    "vitest": "5.0.0",\n+    "vitest": "5.1.2",\n-    "zod": "4.6.5",\n+    "zod": "4.7.0",',
    binary: false,
    tooLarge: false,
  },
  {
    path: "pnpm-lock.yaml",
    status: "modified",
    additions: 212,
    deletions: 188,
    patch: "",
    binary: false,
    tooLarge: true,
  },
];

/** t-docs committed its README rewrite and has a clean tree, so Uncommitted falls back to the branch. */
const README_FILE: DiffFile = {
  path: "README.md",
  status: "modified",
  additions: 3,
  deletions: 1,
  patch:
    "@@ -1,4 +1,6 @@\n-# Install\n+# Getting started\n+\n+Install with `pnpm add @example/api`.\n \n See the docs site for details.",
  binary: false,
  tooLarge: false,
};

export function mockDiff(threadId: ThreadId, scope: DiffScope): Diff {
  if (threadId === "t-grpc") return { repo: false };
  if (scope.kind === "turn") {
    const files = threadId === "t-deps" && scope.turnId === MOCK_DEPS_TURN ? DEPS_TURN_FILES : [];
    return { repo: true, branch: "main", files };
  }
  if (threadId === "t-docs") {
    return { repo: true, branch: "docs/readme", base: "origin/main", files: [README_FILE] };
  }
  if (threadId !== "t-flaky") {
    return {
      repo: true,
      branch: "main",
      ...(scope.kind === "branch" ? { base: "origin/main" } : {}),
      files: [],
    };
  }
  const worktree = "/Users/dev/code/api/.worktrees/fix-flaky-retry";
  return scope.kind === "branch"
    ? { repo: true, branch: "fix/flaky-retry", worktree, base: "origin/main", files: [RETRY_FILE] }
    : { repo: true, branch: "fix/flaky-retry", worktree, files: UNCOMMITTED };
}

/** The detail of a PR the mock opened from the create-PR dialog: no checks, reviews or files yet. */
export function mockCreatedPrDetail(
  pr: NonNullable<MockCreated["pr"]>,
  body: string,
  branch: string,
): PrDetailResult {
  return {
    available: true,
    detail: {
      number: pr.number,
      state: pr.state,
      url: pr.url,
      title: pr.title,
      body,
      isDraft: pr.isDraft,
      author: "alex",
      baseRefName: pr.baseRef ?? "main",
      headRefName: branch,
      additions: 0,
      deletions: 0,
      changedFiles: 0,
      commits: 3,
      reviewDecision: "",
      checks: pr.checks,
      checksPassed: 0,
      checksTotal: 0,
      checkRuns: [],
      commitList: [],
      conversation: [],
      files: [],
    },
  };
}

const RUNS = "https://github.com/example/api/actions/runs";

/** `rerun`: `git.prRerunChecks` asked for the failed Windows run again, so it's queued. */
export function mockPrDetail(
  threadId: ThreadId,
  {
    rerun = false,
    state = "OPEN",
    isDraft = false,
  }: MockPrWrites & { readonly rerun?: boolean } = {},
): PrDetailResult {
  if (threadId === "t-question") return { available: false };
  if (threadId !== "t-flaky") return { available: true };
  return {
    available: true,
    detail: {
      headRefOid: MOCK_HEAD_OID,
      number: 412,
      state,
      url: "https://github.com/example/api/pull/412",
      title: "Make the retry test deterministic",
      body: "Switches `retry.test.ts` to the fake clock, so the retry ordering no longer depends on a real 100 ms timer.",
      isDraft,
      author: "alex",
      baseRefName: "main",
      headRefName: "fix/flaky-retry",
      additions: 2,
      deletions: 1,
      changedFiles: 1,
      commits: 2,
      reviewDecision: "CHANGES_REQUESTED",
      reviews: 1,
      checks: rerun ? "pending" : "failing",
      checksPassed: 2,
      checksTotal: 4,
      checkRuns: [
        {
          name: "lint",
          status: "passing",
          link: `${RUNS}/9101/job/1`,
          runId: "9101",
          conclusion: "SUCCESS",
          phase: "completed",
          startedAt: "2026-09-16T10:41:00Z",
          completedAt: "2026-09-16T10:42:05Z",
        },
        {
          name: "test (macos)",
          status: "passing",
          link: `${RUNS}/9102/job/2`,
          runId: "9102",
          conclusion: "SUCCESS",
          phase: "completed",
          startedAt: "2026-09-16T10:41:00Z",
          completedAt: "2026-09-16T10:45:30Z",
        },
        rerun
          ? {
              name: "test (windows)",
              status: "pending",
              link: `${RUNS}/9102/job/3`,
              runId: "9102",
              phase: "queued",
            }
          : {
              name: "test (windows)",
              status: "failing",
              link: `${RUNS}/9102/job/3`,
              runId: "9102",
              conclusion: "FAILURE",
              phase: "completed",
              startedAt: "2026-09-16T10:41:00Z",
              completedAt: "2026-09-16T10:46:12Z",
            },
        {
          name: "e2e",
          status: "pending",
          link: `${RUNS}/9103/job/4`,
          runId: "9103",
          phase: "running",
          startedAt: "2026-09-16T10:41:30Z",
        },
      ],
      commitList: [
        {
          oid: "3f9c2d1a8b",
          headline: "fix: use the fake clock in retry.test.ts",
          author: "alex",
          at: "2026-09-16T10:12:00Z",
        },
        {
          oid: "9a1e77c0d2",
          headline: "test: repeat the retry test 20 times in CI",
          author: "alex",
          at: "2026-09-16T10:40:00Z",
        },
      ],
      conversation: [
        {
          kind: "comment",
          author: "ci-bot",
          state: "",
          body: "Windows run failed: `retries twice` timed out after 5 s.",
          at: "2026-09-16T10:45:00Z",
        },
        {
          kind: "review",
          author: "reviewer",
          state: "CHANGES_REQUESTED",
          body: "Looks right, but please restore the real timers in `afterEach`.",
          at: "2026-09-16T11:02:00Z",
        },
      ],
      files: [RETRY_FILE],
      reviewRequests: [
        { kind: "user", name: "maria" },
        { kind: "team", name: "example/platform" },
      ],
      latestReviews: [
        { author: "reviewer", state: "CHANGES_REQUESTED", at: "2026-09-16T11:02:00Z" },
        { author: "ci-bot", state: "COMMENTED", at: "2026-09-16T10:45:00Z" },
      ],
      labels: [
        { name: "tests", color: "0e8a16", description: "Test-only changes" },
        { name: "flaky", color: "fbca04", description: "Fails intermittently" },
      ],
    },
  };
}
