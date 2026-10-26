import type { OwnPr, ReviewRequest } from "@gram/contracts";

// Review requests for MockApi: one in a known project (so it can be checked out), one elsewhere.

export const seedReviewRequests = (): ReviewRequest[] => [
  {
    repo: "example/api",
    number: 530,
    title: "Add rate limit headers",
    url: "https://github.com/example/api/pull/530",
    author: "jordan",
    updatedAt: "2026-09-17T08:40:00Z",
    createdAt: "2026-09-15T08:40:00Z",
    checks: "failing",
    reviewDecision: "REVIEW_REQUIRED",
    bot: { verdict: "changesRequested", onHead: false },
    projectRoot: "/Users/dev/code/api",
  },
  {
    repo: "example/infra",
    number: 88,
    title: "Rotate the staging certificates",
    url: "https://github.com/example/infra/pull/88",
    author: "ola",
    updatedAt: "2026-09-16T15:10:00Z",
    createdAt: "2026-08-30T15:10:00Z",
    checks: "passing",
    bot: { verdict: "approved", onHead: true },
  },
];

/** Requested from a team the user is on, so listed only once "direct requests only" is off. */
export const seedTeamReviewRequests = (): ReviewRequest[] => [
  {
    repo: "example/platform",
    number: 412,
    title: "Move the runners to arm64",
    url: "https://github.com/example/platform/pull/412",
    author: "nils",
    updatedAt: "2026-09-15T11:20:00Z",
    createdAt: "2026-09-14T11:20:00Z",
    checks: "pending",
  },
];

/**
 * The user's own open PRs: t-flaky's (owned through its badge), one with conflicts and no thread,
 * and a draft in a repository no project is open for.
 */
export const seedOwnPrs = (): OwnPr[] => [
  {
    repo: "example/api",
    number: 412,
    title: "Make the retry test deterministic",
    url: "https://github.com/example/api/pull/412",
    isDraft: false,
    updatedAt: "2026-09-16T11:20:00Z",
    createdAt: "2026-09-14T09:00:00Z",
    headRef: "fix/flaky-retry",
    mergeState: "BLOCKED",
    checks: "failing",
    reviewDecision: "CHANGES_REQUESTED",
    projectRoot: "/Users/dev/code/api",
  },
  {
    repo: "example/api",
    number: 538,
    title: "Paginate the audit log",
    url: "https://github.com/example/api/pull/538",
    isDraft: false,
    updatedAt: "2026-09-15T14:05:00Z",
    createdAt: "2026-09-08T10:30:00Z",
    headRef: "feat/audit-pages",
    mergeState: "DIRTY",
    checks: "passing",
    reviewDecision: "APPROVED",
    bot: { verdict: "approved", onHead: true },
    projectRoot: "/Users/dev/code/api",
  },
  {
    repo: "example/platform",
    number: 419,
    title: "Cache the runner images per architecture",
    url: "https://github.com/example/platform/pull/419",
    isDraft: true,
    updatedAt: "2026-09-12T16:45:00Z",
    createdAt: "2026-09-11T08:15:00Z",
    headRef: "feat/runner-cache",
    mergeState: "DRAFT",
    checks: "pending",
  },
];
