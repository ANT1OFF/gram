import {
  orchestrationMode,
  type PendingRequest,
  type PrStatus,
  type RequestId,
  type Thread,
} from "@gram/contracts";

import type { MockBoardSimulation, MockWaitsSimulation, MockScenes } from "./mock-orchestration";

// `casefile-cleanup` beside the board scenario: workers waiting on everything a worker can wait on.

/**
 * `casefile-cleanup`, a group whose workers wait on everything a worker can wait on: one running,
 * PRs on CI, on the review bot and on a merge Gram makes, and PRs on people, a code-owner
 * team's review, a person's change request and the user's merge, a question for the user, and
 * one merged.
 */
export async function simulateWaits(
  scenes: MockScenes,
  board: MockBoardSimulation,
): Promise<MockWaitsSimulation> {
  const { host, askedAt, find, project, put } = scenes;
  const settings = await host.settings();
  const { workspaceId, orchestratorThreadId } = board;
  const home = find(workspaceId).workspace.homeProjectId;
  const origin = `example/${project(home).name}`;
  const spawn = async (feature: string, title: string, slug: string) => {
    const created = await host.createThread({
      projectRoot: project(home).root,
      title,
      mode: orchestrationMode(settings),
      branch: `feat/${slug}`,
    });
    const worker: Thread = {
      ...created,
      workspaceId,
      spawnedBy: { threadId: orchestratorThreadId, feature },
    };
    host.replace(worker);
    return worker;
  };
  const threads = { unresolved: 0, blockers: 0, suggestions: 0, outdatedUnresolved: 0 };
  const bot = (over: Partial<NonNullable<PrStatus["review"]>> = {}) => ({
    bots: ["example-code-review"],
    reviewedHead: true,
    roundInFlight: false,
    threads,
    ...(over.verdictOnHead === undefined ? {} : { verdictOnHeadBy: "example-code-review" }),
    ...over,
  });
  const approved = bot({ verdictOnHead: "approved", latestVerdict: "approved" });
  const withPr = (worker: Thread, number: number, pr: Partial<PrStatus>) =>
    host.setGit(worker.id, {
      repo: true,
      branch: worker.checkout.branch!,
      worktree: true,
      head: `${number}`.padEnd(40, "a"),
      changesToken: `mock-wait-${number}`,
      changedFiles: 0,
      base: "origin/main",
      behindBase: 0,
      aheadBase: 2,
      conflicts: false,
      upstream: "synced",
      origin,
      pr: {
        number,
        state: "OPEN",
        url: `https://github.com/${origin}/pull/${number}`,
        title: worker.title,
        isDraft: false,
        checks: "passing",
        headMatches: true,
        aheadOfPr: false,
        baseRef: "main",
        headRef: worker.checkout.branch!,
        ...pr,
      },
    });
  const ci = await spawn("casefile-index", "Index casefiles by owner", "casefile-index");
  withPr(ci, 231, { checks: "pending", mergeState: "BLOCKED" });
  const reviewing = await spawn("casefile-index", "Backfill the owner index", "casefile-backfill");
  withPr(reviewing, 232, {
    mergeState: "BLOCKED",
    review: bot({ reviewedHead: false, roundInFlight: true }),
  });
  const owners = await spawn("casefile-export", "Export casefiles as CSV", "casefile-export");
  withPr(owners, 233, {
    mergeState: "BLOCKED",
    reviewDecision: "REVIEW_REQUIRED",
    reviewRequests: [{ kind: "team", name: "platform-owners", codeOwner: true }],
    review: approved,
  });
  const yours = await spawn(
    "casefile-export",
    "Export button on the casefile page",
    "casefile-export-ui",
  );
  withPr(yours, 234, { mergeState: "CLEAN", reviewDecision: "APPROVED", review: approved });
  const merging = await spawn("casefile-search", "Search casefiles by tag", "casefile-search");
  withPr(merging, 235, { mergeState: "CLEAN", review: approved });
  host.replace({
    ...merging,
    boundPr: {
      repo: origin,
      number: 235,
      monitor: true,
      reviewMonitor: true,
      mergeWhenReady: { method: "squash", allowedBy: "autonomy", setAt: Date.now() },
    },
  });
  const changes = await spawn(
    "casefile-tests",
    "Casefile fixtures for the e2e suite",
    "casefile-tests",
  );
  withPr(changes, 236, {
    mergeState: "BLOCKED",
    reviewDecision: "CHANGES_REQUESTED",
    review: bot({
      verdictOnHead: "approved",
      humanReviews: [
        {
          id: "r-jordan",
          author: "jordan",
          verdict: "changesRequested",
          commitOid: "236".padEnd(40, "a"),
          submittedAt: new Date().toISOString(),
          body: "The fixtures need a casefile with no owner.",
        },
      ],
    }),
  });
  const running = await spawn("casefile-search", "Tag suggestions while typing", "casefile-tags");
  host.setStatus(running.id, "running", "pnpm vitest run search");
  const asking = await spawn("casefile-docs", "Document casefile retention", "casefile-docs");
  const question: PendingRequest = {
    kind: "question",
    id: `r-question-${asking.id}` as RequestId,
    toolUseId: `toolu_question_${asking.id}`,
    questions: [
      {
        question: "Retention is seven years in the policy and five in the code. Which is right?",
        header: "Retention",
        multiSelect: false,
        options: [
          { label: "Seven years", description: "What the policy says." },
          { label: "Five years", description: "What the code does today." },
        ],
      },
    ],
  };
  askedAt.set(question.id, Date.now() - 4 * 60_000);
  host.ask(asking.id, question, () => {
    askedAt.delete(question.id);
    host.setStatus(asking.id, "running", "editing docs/retention.md");
    host.emit({ type: "orchestration.changed", workspaceId });
  });
  const merged = await spawn("casefile-tests", "Drop the casefile v1 table", "casefile-v1");
  withPr(merged, 229, { state: "MERGED", review: approved });
  host.replace({ ...merged, completedAt: Date.now(), completedReason: "prMerged" });
  put({
    ...find(workspaceId),
    groups: {
      ...find(workspaceId).groups,
      "casefile-cleanup": {
        features: [
          "casefile-index",
          "casefile-export",
          "casefile-search",
          "casefile-tests",
          "casefile-docs",
        ],
      },
    },
  });
  host.emit({ type: "orchestration.changed", workspaceId });
  return {
    ci: ci.id,
    reviewing: reviewing.id,
    owners: owners.id,
    yours: yours.id,
    merging: merging.id,
    changes: changes.id,
    running: running.id,
    asking: asking.id,
    merged: merged.id,
  };
}
