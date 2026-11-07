import {
  chunkLimits,
  chunkPatch,
  generatedKind,
  summarizePatch,
  type Diff,
  type DiffChunk,
  type DiffChunkRequest,
  type DiffFile,
  type DiffScope,
  type GitState,
  type PrDetail,
  type PrDetailResult,
  type PrReviewState,
  type PrState,
  type PrStatus,
  type ThreadId,
  type TurnId,
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
    additions: 2,
    deletions: 2,
    // The second line is only re-indented, which Ignore whitespace leaves out.
    patch:
      "@@ -1,3 +1,3 @@\n-export const sleep = (ms: number) =>\n+export const wait = (ms: number) =>\n-  new Promise((r) => setTimeout(r, ms));\n+    new Promise((r) => setTimeout(r, ms));\n \\ No newline at end of file",
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

/**
 * t-deps's lockfile bump in full, +212 −188 over 25 hunks: what `git.diffChunk` pages through when
 * the listing sends the file without its body.
 */
function depsLockPatch(): string {
  const rows: string[] = [];
  const packages = ["vitest", "zod", "vite", "esbuild", "rollup", "@vitest/expect", "tinypool"];
  for (let h = 0; h < 25; h++) {
    const name = `${packages[h % packages.length]}${h < packages.length ? "" : `-${h}`}`;
    const removed = h < 13 ? 8 : 7;
    const added = h < 12 ? 9 : 8;
    const oldStart = 40 + h * 60;
    const newStart = oldStart + h;
    rows.push(`@@ -${oldStart},${removed + 2} +${newStart},${added + 2} @@ packages:`);
    rows.push(`   /${name}@5.0.${h}:`);
    for (let i = 0; i < removed; i++) {
      rows.push(
        `-    ${i === 0 ? "resolution" : `dependency-${i}`}: {integrity: sha512-${(h * 17 + i).toString(36).repeat(6)}}`,
      );
    }
    for (let i = 0; i < added; i++) {
      rows.push(
        `+    ${i === 0 ? "resolution" : `dependency-${i}`}: {integrity: sha512-${(h * 29 + i).toString(36).repeat(6)}}`,
      );
    }
    rows.push("     dev: true");
  }
  return rows.join("\n");
}

/** Whole patches of the files the mock lists without their bodies, by path. */
const FULL_PATCHES: Readonly<Record<string, () => string>> = {
  "pnpm-lock.yaml": depsLockPatch,
};

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

/** A patch line without its sign and whitespace, as `git diff -w` compares lines. */
const bare = (line: string) => line.slice(1).replace(/\s+/g, "");

/**
 * What `git diff -w` leaves of a mock file: a run of removed lines followed by as many added ones,
 * equal but for whitespace, becomes context; a hunk with no change left goes, and a file with no
 * hunk left isn't listed.
 */
export function withoutWhitespaceChanges(file: DiffFile): DiffFile | undefined {
  if (file.binary || file.tooLarge || file.patch === "") return file;
  const hunks: string[][] = [];
  for (const line of file.patch.split("\n")) {
    if (line.startsWith("@@")) hunks.push([line]);
    else hunks.at(-1)?.push(line);
  }
  const kept = hunks.flatMap(([header, ...lines]) => {
    const out: string[] = [];
    for (let i = 0; i < lines.length;) {
      const dels: string[] = [];
      while (lines[i]?.startsWith("-")) dels.push(lines[i++]!);
      const adds: string[] = [];
      while (lines[i]?.startsWith("+")) adds.push(lines[i++]!);
      if (dels.length === 0 && adds.length === 0) {
        out.push(lines[i++]!);
        continue;
      }
      const same = dels.length === adds.length && dels.every((d, k) => bare(d) === bare(adds[k]!));
      out.push(...(same ? adds.map((a) => ` ${a.slice(1)}`) : [...dels, ...adds]));
    }
    return out.some((line) => line.startsWith("+") || line.startsWith("-"))
      ? [[header!, ...out]]
      : [];
  });
  if (kept.length === 0) return undefined;
  const lines = kept.flat();
  return {
    ...file,
    additions: lines.filter((line) => line.startsWith("+")).length,
    deletions: lines.filter((line) => line.startsWith("-")).length,
    patch: lines.join("\n"),
  };
}

/** Shaped like the contract's `NotFound` for a file no longer in the diff. */
class MockFileNotFound extends Error {
  readonly _tag = "NotFound";
  readonly entity = "file";
  readonly id: string;

  constructor(id: string) {
    super(`${id} isn't in this diff any more. Refresh the diff to see what changed.`);
    this.id = id;
  }
}

/** A short stand-in for the server's fingerprint of a patch. */
const fingerprint = (text: string) => {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (Math.imul(hash, 31) + text.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(16);
};

/**
 * `git.diffChunk` over the mock's diffs: a file the listing sent too large is paged through its whole
 * patch, the same way the server pages, and a missing file is `NotFound`.
 */
export function mockDiffChunk(threadId: ThreadId, request: DiffChunkRequest): DiffChunk {
  const file = mockDiff(threadId, request.scope, {
    ignoreWhitespace: request.ignoreWhitespace,
  }).files?.find((f) => f.path === request.path);
  if (file === undefined) {
    throw new MockFileNotFound(request.path);
  }
  const patch = file.tooLarge ? (FULL_PATCHES[file.path]?.() ?? "") : file.patch;
  const kind = file.binary ? undefined : generatedKind(file.path, patch);
  const base = {
    path: file.path,
    fingerprint: fingerprint(patch),
    binary: file.binary,
    partial: false,
    ...(kind === undefined ? {} : { generated: kind }),
  };
  if (request.fingerprint !== undefined && request.fingerprint !== base.fingerprint) {
    return {
      ...base,
      changed: true,
      patch: "",
      totalHunks: 0,
      additions: file.additions,
      deletions: file.deletions,
      clippedLines: 0,
    };
  }
  if (request.mode === "summary") {
    const summary = summarizePatch(file.path, patch);
    return {
      ...base,
      changed: false,
      patch: "",
      totalHunks: summary.hunks,
      additions: summary.additions,
      deletions: summary.deletions,
      clippedLines: 0,
      summary,
    };
  }
  return {
    ...base,
    changed: false,
    ...chunkPatch(patch, request.cursor, chunkLimits(request.hunks)),
  };
}

export function mockDiff(
  threadId: ThreadId,
  scope: DiffScope,
  options: { ignoreWhitespace?: boolean | undefined } = {},
): Diff {
  const diff = mockDiffOf(threadId, scope);
  if (options.ignoreWhitespace !== true || !diff.repo || diff.files === undefined) return diff;
  return { ...diff, files: diff.files.flatMap((file) => withoutWhitespaceChanges(file) ?? []) };
}

/** Files a scenario's finished turns changed, by `thread:turn` (`registerMockTurnFiles`). */
const scenarioTurnFiles = new Map<string, readonly DiffFile[]>();

/** A scenario's finished turn changed `files`, for its "N files changed" card and Undo. */
export function registerMockTurnFiles(
  threadId: ThreadId,
  turnId: TurnId,
  files: readonly DiffFile[],
): void {
  scenarioTurnFiles.set(`${threadId}:${turnId}`, files);
}

function mockDiffOf(threadId: ThreadId, scope: DiffScope): Diff {
  if (threadId === "t-grpc") return { repo: false };
  if (scope.kind === "turn") {
    const files =
      threadId === "t-deps" && scope.turnId === MOCK_DEPS_TURN
        ? DEPS_TURN_FILES
        : [...(scenarioTurnFiles.get(`${threadId}:${scope.turnId}`) ?? [])];
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

/** PRs a scenario seeds for its threads, as a merged worker's: read before the fixed ones below. */
const seededPrDetails = new Map<ThreadId, PrDetail>();

/** A merged PR with `files` for `threadId`, as the realistic scenario's finished workers have. */
export function seedMergedPr(
  threadId: ThreadId,
  pr: {
    readonly number: number;
    readonly repo: string;
    readonly title: string;
    readonly branch: string;
    readonly files: readonly DiffFile[];
  },
): void {
  seededPrDetails.set(threadId, {
    headRefOid: `${pr.number}e4c1a9`.padEnd(40, "0"),
    number: pr.number,
    state: "MERGED",
    url: `https://github.com/${pr.repo}/pull/${pr.number}`,
    title: pr.title,
    body: "",
    isDraft: false,
    author: "alex",
    baseRefName: "main",
    headRefName: pr.branch,
    additions: pr.files.reduce((sum, file) => sum + file.additions, 0),
    deletions: pr.files.reduce((sum, file) => sum + file.deletions, 0),
    changedFiles: pr.files.length,
    commits: 2,
    reviewDecision: "APPROVED",
    checks: "passing",
    checksPassed: 3,
    checksTotal: 3,
    checkRuns: [],
    commitList: [],
    conversation: [],
    files: pr.files,
  });
}

/** `rerun`: `git.prRerunChecks` asked for the failed Windows run again, so it's queued. */
export function mockPrDetail(
  threadId: ThreadId,
  {
    rerun = false,
    state = "OPEN",
    isDraft = false,
  }: MockPrWrites & { readonly rerun?: boolean } = {},
): PrDetailResult {
  const seeded = seededPrDetails.get(threadId);
  if (seeded !== undefined) return { available: true, detail: seeded };
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
