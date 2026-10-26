import type { BoundPr, GitState, PrStatus } from "@gram/contracts";

// `MockApi.seedPrStates`: one thread per state the sidebar's PR glyph draws, and one with several PRs,
// so the glyph's colours and its hover card can be seen side by side.

export interface MockPrStateThread {
  readonly id: string;
  readonly title: string;
  readonly git: GitState;
  readonly extraPrs?: readonly BoundPr[];
}

const badge = (
  repo: string,
  number: number,
  title: string,
  patch: Partial<PrStatus> = {},
): PrStatus => ({
  number,
  state: "OPEN",
  url: `https://github.com/${repo}/pull/${number}`,
  title,
  isDraft: false,
  checks: "passing",
  headMatches: true,
  aheadOfPr: false,
  baseRef: "main",
  headRef: `feat/pr-${number}`,
  author: "jordan",
  additions: number % 97,
  deletions: number % 23,
  changedFiles: 3,
  updatedAt: "2026-10-14T10:20:00Z",
  mergeState: "CLEAN",
  ...patch,
});

const gitWith = (repo: string, pr: PrStatus, extraPrs?: readonly PrStatus[]): GitState => ({
  repo: true,
  branch: pr.headRef ?? `feat/pr-${pr.number}`,
  worktree: true,
  head: `mock-head-${pr.number}`,
  changesToken: `mock-pr-states-${pr.number}`,
  changedFiles: 0,
  base: "origin/main",
  behindBase: 0,
  aheadBase: 2,
  conflicts: false,
  upstream: "synced",
  origin: repo,
  pr,
  ...(extraPrs === undefined ? {} : { extraPrs }),
});

const API = "example/api";
const WEB = "example/web";

export function mockPrStateThreads(): readonly MockPrStateThread[] {
  const releaseExtras = [
    badge(API, 731, "Bump the API client for 2.0", { checks: "failing", mergeState: "UNSTABLE" }),
    badge(WEB, 288, "Publish the 2.0 changelog page", { state: "MERGED", additions: 64 }),
  ];
  return [
    {
      id: "t-pr-open",
      title: "Add a settings search",
      git: gitWith(
        WEB,
        badge(WEB, 301, "Search settings by name and keyword", {
          checks: "pending",
          mergeState: "BLOCKED",
        }),
      ),
    },
    {
      id: "t-pr-ready",
      title: "Ship the export button",
      git: gitWith(
        WEB,
        badge(WEB, 302, "Export the board as CSV", {
          additions: 148,
          deletions: 12,
          reviewDecision: "APPROVED",
        }),
      ),
    },
    {
      id: "t-pr-failing",
      title: "Fix the login redirect",
      git: gitWith(
        API,
        badge(API, 703, "Keep the return path across the login redirect", {
          checks: "failing",
          mergeState: "BLOCKED",
        }),
      ),
    },
    {
      id: "t-pr-changes",
      title: "Rework the token refresh",
      git: gitWith(
        API,
        badge(API, 704, "Refresh tokens a minute before they expire", {
          reviewDecision: "CHANGES_REQUESTED",
          mergeState: "BLOCKED",
        }),
      ),
    },
    {
      id: "t-pr-draft",
      title: "Sketch the plugin API",
      git: gitWith(
        API,
        badge(API, 705, "Draft: a first plugin API", {
          isDraft: true,
          checks: "none",
          mergeState: "DRAFT",
        }),
      ),
    },
    {
      id: "t-pr-merged",
      title: "Bump the date library",
      git: gitWith(WEB, badge(WEB, 290, "Bump date-fns to 5.1", { state: "MERGED" })),
    },
    {
      id: "t-pr-closed",
      title: "Try a new cache layer",
      git: gitWith(
        API,
        badge(API, 699, "Cache the session lookups in memory", { state: "CLOSED" }),
      ),
    },
    {
      id: "t-pr-many",
      title: "Release 2.0",
      git: gitWith(
        WEB,
        badge(WEB, 310, "Release 2.0", {
          additions: 2140,
          deletions: 865,
          reviewDecision: "APPROVED",
        }),
        releaseExtras,
      ),
      extraPrs: [
        { repo: API, number: 731, monitor: false },
        { repo: WEB, number: 288, monitor: false },
      ],
    },
  ];
}
