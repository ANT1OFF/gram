import {
  orchestrationMode,
  type FeatureStage,
  type PendingRequest,
  type ProjectId,
  type RequestId,
  type Thread,
  type ThreadId,
  type WorkerQuestion,
  WORKER_QUESTION_TRIAGE_MS,
} from "@gram/contracts";

import type { MockBoardSimulation, MockFinishedSimulation, MockScenes } from "./mock-orchestration";

// The board scenario and what builds on it: the cross-repo workspace `simulateBoard` makes, its live
// cards, its workers' questions, its finished work and its archived groups.

/**
 * A workspace across `projectIds` with its orchestrator and three features. `mail-trigger` spans
 * the repos: one worker running tests (the user stepped in, and it overlaps a sibling in its
 * repo), two waiting on the same `git push` and a third on one that differs only in an argument
 * no card leads with, one in review with a PR that also works in the two
 * other repos, with a PR in one of them. `registry-paging` has one worker just briefed. Those two
 * are the group `q4-platform`, staged as a release; `mail-trigger` has a planned stage of its own
 * and `registry-paging` a free label the user set over a day ago. `docs-refresh` is in no group.
 * Answering a push through `respond` sets that worker running again. The orchestrator's own
 * checkout was left on a branch with a red PR, which says nothing about the workspace.
 */
export async function simulateBoard(
  scenes: MockScenes,
  projectIds: readonly ProjectId[],
): Promise<MockBoardSimulation> {
  const {
    host,
    workspaces,
    reports,
    askedAt,
    overlaps,
    intervened,
    alsoIn,
    find,
    project,
    put,
    create,
    fillSlot,
    buildLedger,
    digestMessage,
    assistantMessage,
    notFound,
  } = scenes;
  const settings = await host.settings();
  const [home, ...rest] = projectIds;
  if (home === undefined) throw notFound("project", "(none)");
  const second = rest[0] ?? home;
  const third = rest[1] ?? second;
  const name = "agent-platform";
  const state =
    workspaces().find((w) => w.workspace.name === name) ??
    (await create({ name, projectIds: [home, ...rest], homeProjectId: home }));
  const workspaceId = state.workspace.id;
  const orchestrator = await fillSlot(state, settings);
  // 92 % of its window, so the board and the banner offer a fresh session.
  host.setUsage(orchestrator.id, {
    tokens: { inputTokens: 0, outputTokens: 0 },
    contextWindow: 200_000,
    contextTokens: 184_000,
    costUsd: 1.85,
  });

  const spawn = async (projectId: ProjectId, feature: string, title: string, slug: string) => {
    const created = await host.createThread({
      projectRoot: project(projectId).root,
      title,
      mode: orchestrationMode(settings),
      branch: `feat/${slug}`,
    });
    const worker: Thread = {
      ...created,
      workspaceId,
      spawnedBy: { threadId: orchestrator.id, feature },
    };
    host.replace(worker);
    return worker;
  };
  const cost = (threadId: ThreadId, costUsd: number) =>
    host.setUsage(threadId, { tokens: { inputTokens: 0, outputTokens: 0 }, costUsd });
  const progress = (worker: Thread, summary: string, minutesAgo: number) =>
    reports.set(worker.id, {
      threadId: worker.id,
      state: "progress",
      summary,
      at: Date.now() - minutesAgo * 60_000,
    });

  const feature = "mail-trigger";
  const inReview = await spawn(home, feature, "Mail trigger endpoint", "mail-trigger");
  const working = await spawn(home, feature, "Mail trigger queue worker", "mail-trigger-queue");
  const waitingWeb = await spawn(second, feature, "Trigger form", "mail-trigger");
  const waitingDocs = await spawn(third, feature, "Document the mail trigger", "mail-trigger");
  const waitingApart = await spawn(home, feature, "Mail trigger rate limit", "mail-trigger-limit");
  const briefed = await spawn(
    second,
    "registry-paging",
    "Page the registry list",
    "registry-paging",
  );

  const ungrouped = await spawn(third, "docs-refresh", "Refresh the setup guide", "docs-refresh");

  const hour = 60 * 60_000;
  put({
    ...find(workspaceId),
    stages: {
      "mail-trigger": {
        plan: ["contract agreed", "build", "preview deployed", "merge in order", "rolled out"],
        stage: "build",
        note: "The endpoint's contract is settled; the form and the docs build against it.",
        setBy: "orchestrator",
        setAt: Date.now() - 2 * hour,
      },
      "registry-paging": {
        stage: "waiting on the API team",
        setBy: "user",
        setAt: Date.now() - 26 * hour,
      },
    },
    groups: {
      "q4-platform": {
        features: ["mail-trigger", "registry-paging"],
        stage: {
          plan: ["build features", "merge", "release candidate", "test RC", "release"],
          stage: "build features",
          setBy: "orchestrator",
          setAt: Date.now() - 3 * hour,
        },
      },
    },
  });

  const origin = `example/${project(home).name}`;
  host.setGit(orchestrator.id, {
    repo: true,
    branch: "fix/login-redirect",
    worktree: false,
    head: "9d3c1a7e5b2f4c6d8e0a1b3c5d7e9f1a2b4c6d8e",
    changesToken: "mock-orchestrator-1",
    changedFiles: 0,
    base: "origin/main",
    behindBase: 0,
    aheadBase: 2,
    conflicts: false,
    upstream: "synced",
    origin,
    pr: {
      number: 198,
      state: "OPEN",
      url: `https://github.com/${origin}/pull/198`,
      title: "Fix the login redirect",
      isDraft: false,
      checks: "failing",
      headMatches: true,
      aheadOfPr: false,
      baseRef: "main",
      headRef: "fix/login-redirect",
      review: {
        bots: ["code-review-bot"],
        reviewedHead: true,
        roundInFlight: false,
        threads: { unresolved: 2, blockers: 0, suggestions: 0, outdatedUnresolved: 0 },
      },
    },
    workElsewhere: { branch: "feat/session-store", path: "/tmp/mock/session-store" },
  });
  host.setGit(inReview.id, {
    repo: true,
    branch: "feat/mail-trigger",
    worktree: true,
    head: "5b1e77c0d2f4b6a8c0e2d4f6a8b0c2d4e6f8a0c4",
    changesToken: "mock-mail-trigger-1",
    changedFiles: 0,
    base: "origin/main",
    behindBase: 0,
    aheadBase: 4,
    conflicts: false,
    upstream: "synced",
    origin,
    pr: {
      number: 212,
      state: "OPEN",
      url: `https://github.com/${origin}/pull/212`,
      title: "Mail trigger endpoint",
      isDraft: false,
      checks: "passing",
      headMatches: true,
      aheadOfPr: false,
      baseRef: "main",
      headRef: "feat/mail-trigger",
      mergeState: "BLOCKED",
      reviewDecision: "REVIEW_REQUIRED",
    },
  });
  cost(inReview.id, 4.2);
  const secondOrigin = `example/${project(second).name}`;
  alsoIn.set(inReview.id, [
    {
      projectId: second,
      project: project(second).name,
      branch: "feat/mail-trigger",
      pr: {
        repo: secondOrigin,
        number: 88,
        checks: "pending",
        url: `https://github.com/${secondOrigin}/pull/88`,
      },
      changedFiles: 2,
    },
    {
      projectId: third,
      project: project(third).name,
      branch: "feat/mail-trigger",
      changedFiles: 1,
    },
  ]);
  host.replace({
    ...inReview,
    // The endpoint merges after the form that calls it, in the other repo.
    boundPr: {
      repo: origin,
      number: 212,
      monitor: false,
      dependsOn: [
        {
          repo: secondOrigin,
          number: 88,
          setBy: "orchestrator",
          setAt: Date.now() - 30 * 60_000,
          seen: { state: "open" },
        },
      ],
    },
    extraCheckouts: [second, third].map((id) => ({
      kind: "worktree" as const,
      path: `${project(id).root}/.worktrees/mail-trigger`,
      branch: "feat/mail-trigger",
      repoRoot: project(id).root,
    })),
  });
  reports.set(inReview.id, {
    threadId: inReview.id,
    state: "done",
    summary: "POST /triggers/mail is in, with tests. Waiting on review.",
    prUrl: `https://github.com/${origin}/pull/212`,
    interface: "POST /triggers/mail { to: string; template: string } → 202 { id: string }",
    at: Date.now() - 25 * 60_000,
  });

  host.setStatus(working.id, "running", "uv run pytest tests/queue");
  cost(working.id, 3.1);
  progress(working, "The queue consumer retries with backoff; running the suite now.", 6);
  intervened.add(working.id);
  overlaps.set(working.id, [inReview.id]);
  overlaps.set(inReview.id, [working.id]);

  const push = (
    worker: Thread,
    minutesAgo: number,
    costUsd: number,
    more: Readonly<Record<string, unknown>> = {},
  ) => {
    const request: PendingRequest = {
      kind: "approval",
      id: `r-push-${worker.id}` as RequestId,
      toolName: "Bash",
      displayName: "Bash",
      input: { command: "git push -u origin feat/mail-trigger", ...more },
      description: "Publish the branch so the pull request can be opened.",
      suggestions: [],
      scopes: ["once"],
    };
    askedAt.set(request.id, Date.now() - minutesAgo * 60_000);
    cost(worker.id, costUsd);
    host.ask(worker.id, request, (answer) => {
      askedAt.delete(request.id);
      const allowed = answer.kind === "approval" && answer.decision === "allow";
      host.setStatus(worker.id, allowed ? "running" : "idle", allowed ? "git push" : undefined);
      host.emit({ type: "orchestration.changed", workspaceId });
    });
  };
  progress(waitingWeb, "The form posts to the new endpoint. Ready to publish.", 14);
  progress(waitingDocs, "The how-to is written. Ready to publish.", 5);
  push(waitingWeb, 12, 2.4);
  push(waitingDocs, 3, 0.9);
  // The same command line under another `timeout`: what the inbox has to keep out of the group,
  // since "Allow all" shows one input and answers every member.
  progress(waitingApart, "The limiter is in, behind a flag. Ready to publish.", 2);
  push(waitingApart, 1, 0.6, { timeout: 600_000 });

  const question: PendingRequest = {
    kind: "question",
    id: `r-question-${ungrouped.id}` as RequestId,
    toolUseId: `toolu_question_${ungrouped.id}`,
    questions: [
      {
        question: "The setup guide covers both pip and uv. Keep both, or uv only?",
        header: "Installer",
        multiSelect: false,
        options: [
          { label: "uv only", description: "What the repo's own scripts use." },
          { label: "Keep both", description: "Longer, but nobody is left out." },
        ],
      },
    ],
  };
  askedAt.set(question.id, Date.now() - 7 * 60_000);
  host.ask(ungrouped.id, question, () => {
    askedAt.delete(question.id);
    host.setStatus(ungrouped.id, "running", "rewriting docs/setup.md");
    host.emit({ type: "orchestration.changed", workspaceId });
  });

  // What `full` autonomy looks like afterwards: the orchestrator's answer, shown in both threads.
  const answered = {
    threadId: briefed.id,
    requestId: `r-answered-${briefed.id}` as RequestId,
    question: "Should the page size be a query parameter, or fixed at 50?",
    answer:
      "A query parameter, capped at 100: decisions.md says list endpoints take `limit`, and the brief asks for the registry to match the others.",
    at: Date.now() - 9 * 60_000,
  };
  for (const threadId of [briefed.id, orchestrator.id]) {
    host.putMessage(
      threadId,
      assistantMessage([{ type: "data-worker-answer", id: host.ids(), data: answered }]),
    );
  }
  await host.seedMemory(workspaceId, [home, ...rest]);

  const ledger = buildLedger(find(workspaceId));
  host.putMessage(
    orchestrator.id,
    digestMessage({
      kind: "orchestration",
      variant: "away",
      generation: 1,
      workspaceId,
      workspaceName: name,
      reasons: [],
      changes: [],
      reports: [],
      features: ledger.features,
      ...(ledger.groups === undefined ? {} : { groups: ledger.groups }),
      budget: ledger.budget,
      notes: [],
    }),
  );

  host.emit({ type: "orchestration.changed", workspaceId });
  return {
    workspaceId,
    orchestratorThreadId: orchestrator.id,
    working: working.id,
    waiting: [waitingWeb.id, waitingDocs.id],
    waitingApart: waitingApart.id,
    inReview: inReview.id,
    briefed: briefed.id,
    ungrouped: ungrouped.id,
  };
}

/**
 * The live stream (feature cards, budget lines, "Since you left") over the finished-work board:
 * the user last looked two and a half hours ago; since then a worker merged and one got blocked,
 * and the helper wrote `mail-trigger`'s sentence.
 */
export function simulateLiveCards(scenes: MockScenes, finished: MockFinishedSimulation) {
  const { host, find, holder, buildLedger, summaries, digestMessage } = scenes;
  const state = find(finished.workspaceId);
  const orchestrator = holder(state);
  if (orchestrator === undefined) throw new Error("the board has no orchestrator");
  host.replace({ ...orchestrator, lastViewedAt: Date.now() - 150 * 60_000 });
  summaries.set(
    "mail-trigger",
    "Endpoint in review, waiting on the form; three branches ready to push.",
  );
  const ledger = buildLedger(state);
  const workers = ledger.features.flatMap((feature) => feature.workers);
  const merged = workers.find((worker) => worker.threadId === finished.merged.at(-1));
  const working = workers.find((worker) => worker.threadId === finished.working);
  const changes = [
    ...(merged === undefined
      ? []
      : [
          {
            threadId: merged.threadId,
            feature: merged.feature,
            title: merged.title,
            from: "readyToMerge" as const,
            to: "merged" as const,
          },
        ]),
    ...(working === undefined
      ? []
      : [
          {
            threadId: working.threadId,
            feature: working.feature,
            title: working.title,
            from: "working" as const,
            to: "blocked" as const,
          },
        ]),
  ];
  host.putMessage(
    orchestrator.id,
    digestMessage({
      kind: "orchestration",
      variant: "digest",
      generation: 2,
      workspaceId: finished.workspaceId,
      workspaceName: state.workspace.name,
      reasons: ["wake: check on the suite"],
      changes,
      reports: [],
      features: ledger.features,
      ...(ledger.groups === undefined ? {} : { groups: ledger.groups }),
      budget: ledger.budget,
      notes: [],
    }),
  );
  host.emit({ type: "orchestration.changed", workspaceId: finished.workspaceId });
  return finished;
}

/**
 * Dev and e2e hook: questions beside the board scenario's workers, one at each stage. The
 * working worker's is forwarded with the orchestrator's line, the docs worker's forwarded on its
 * own after ten minutes, the reviewer's still in triage, and two are closed: one answered by
 * the orchestrator, one dismissed by the user.
 */
export function simulateWorkerQuestions(
  scenes: MockScenes,
  board: MockBoardSimulation,
): readonly WorkerQuestion[] {
  const { host, questionsOf, showQuestion } = scenes;
  const minute = 60_000;
  const now = Date.now();
  const asked = (
    threadId: ThreadId,
    id: string,
    askedAgo: number,
    rest: Omit<
      WorkerQuestion,
      "id" | "workspaceId" | "threadId" | "feature" | "title" | "askedAt" | "triageUntil"
    >,
  ): WorkerQuestion => {
    const thread = host.threads().find((t) => t.id === threadId);
    const at = now - askedAgo * minute;
    return {
      id,
      workspaceId: board.workspaceId,
      threadId,
      feature: thread?.spawnedBy?.feature ?? "",
      title: thread?.title ?? threadId,
      askedAt: at,
      triageUntil: at + WORKER_QUESTION_TRIAGE_MS,
      ...rest,
    };
  };
  const questions: WorkerQuestion[] = [
    asked(board.working, "WQ1", 26, {
      question:
        "Should the retry queue drop a job after three attempts, or keep it for a manual replay?",
      context: "A dropped job is lost for good: the queue has no dead-letter table yet.",
      options: [
        { label: "Drop after three", description: "What the mail relay does today." },
        { label: "Keep for replay", description: "Needs a replay button on the jobs page." },
      ],
      recommended: "Keep for replay",
      stage: "forwarded",
      forwardedAt: now - 24 * minute,
      forwardedBy: "orchestrator",
      note: "I'd keep them: the relay worker reads the same queue, so its brief changes too.",
    }),
    asked(board.ungrouped, "WQ2", 18, {
      question: "Can the setup guide drop its Python 3.9 notes?",
      recommended: "Yes: 3.9 is past end of life and CI no longer runs it.",
      stage: "forwarded",
      forwardedAt: now - 8 * minute,
      forwardedBy: "timeout",
    }),
    asked(board.inReview, "WQ3", 2, {
      question: "Name the flag `retry_v2` or `queue_retry`?",
      options: [{ label: "retry_v2" }, { label: "queue_retry" }],
      stage: "triage",
    }),
    asked(board.briefed, "WQ4", 52, {
      question: "Should the page size be a query parameter, or fixed at 50?",
      stage: "answered",
      answer: "A query parameter named `limit`, capped at 100.",
      closedBy: "orchestrator",
      source: "decisions.md: list endpoints take `limit`",
      closedAt: now - 50 * minute,
      delivered: "sent",
    }),
    asked(board.working, "WQ5", 95, {
      question: "Add a metrics endpoint while I'm in here?",
      recommended: "No, a separate PR",
      stage: "dismissed",
      forwardedAt: now - 93 * minute,
      forwardedBy: "orchestrator",
      closedBy: "user",
      reason: "Out of scope for this feature.",
      closedAt: now - 70 * minute,
      delivered: "sent",
    }),
  ];
  questionsOf.set(board.workspaceId, questions);
  for (const question of questions) showQuestion(question);
  host.emit({ type: "orchestration.changed", workspaceId: board.workspaceId });
  return questions;
}

/**
 * Finished work beside the board scenario's, for the tree's Done row: `q3-cleanup`, a group whose
 * two features merged; `changelog-tool`, delivered where no PR can be opened; `sse-spike`,
 * archived; and a merged worker of `mail-trigger`, a feature still going.
 */
export async function simulateFinished(
  scenes: MockScenes,
  board: MockBoardSimulation,
): Promise<MockFinishedSimulation> {
  const { host, reports, find, project, put } = scenes;
  const settings = await host.settings();
  const { workspaceId, orchestratorThreadId } = board;
  const home = find(workspaceId).workspace.homeProjectId;
  const hour = 60 * 60_000;
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
  const origin = `example/${project(home).name}`;
  const merge = (worker: Thread, number: number, hoursAgo: number) => {
    host.setGit(worker.id, {
      repo: true,
      branch: worker.checkout.branch!,
      worktree: true,
      head: `${number}`.padEnd(40, "0"),
      changesToken: `mock-merged-${number}`,
      changedFiles: 0,
      base: "origin/main",
      behindBase: 3,
      aheadBase: 0,
      conflicts: false,
      upstream: "synced",
      origin,
      pr: {
        number,
        state: "MERGED",
        url: `https://github.com/${origin}/pull/${number}`,
        title: worker.title,
        isDraft: false,
        checks: "passing",
        headMatches: true,
        aheadOfPr: false,
        baseRef: "main",
        headRef: worker.checkout.branch!,
      },
    });
    host.replace({
      ...worker,
      completedAt: Date.now() - hoursAgo * hour,
      completedReason: "prMerged",
      lastActivityAt: Date.now() - hoursAgo * hour,
    });
  };
  const tokens = await spawn("auth-refresh", "Refresh tokens before expiry", "auth-refresh");
  const tokensUi = await spawn("auth-refresh", "Sign-in expiry banner", "auth-refresh-ui");
  const flaky = await spawn("flaky-ci", "Quarantine the flaky e2e specs", "flaky-ci");
  const changelog = await spawn("changelog-tool", "Changelog lint script", "changelog-tool");
  const spike = await spawn("sse-spike", "Spike: SSE or polling", "sse-spike");
  const shipped = await spawn("mail-trigger", "Mail trigger schema", "mail-trigger-schema");
  merge(tokens, 198, 20);
  merge(tokensUi, 201, 18);
  merge(flaky, 205, 6);
  merge(shipped, 209, 2);
  host.setGit(changelog.id, {
    repo: true,
    branch: "feat/changelog-tool",
    worktree: true,
    head: "c".repeat(40),
    changesToken: "mock-changelog",
    changedFiles: 0,
    behindBase: 0,
    aheadBase: 2,
    conflicts: false,
  });
  reports.set(changelog.id, {
    threadId: changelog.id,
    state: "done",
    summary: "scripts/changelog-lint.mjs is committed on the branch.",
    at: Date.now() - 5 * hour,
  });
  host.replace({ ...changelog, completedAt: Date.now() - 5 * hour, completedReason: "agent" });
  host.replace({ ...spike, parked: true, lastActivityAt: Date.now() - 30 * hour });
  put({
    ...find(workspaceId),
    groups: {
      ...find(workspaceId).groups,
      "q3-cleanup": { features: ["auth-refresh", "flaky-ci"] },
    },
  });
  host.emit({ type: "orchestration.changed", workspaceId });
  return {
    ...board,
    merged: [tokens.id, tokensUi.id, flaky.id, shipped.id],
    delivered: changelog.id,
    archived: spike.id,
  };
}

/**
 * Groups whose every worker is archived, as a workspace collects them over weeks, each with a
 * plan that never reached its end and a note: they are what the board's filter hides. Beside
 * them `nightly-builds`, a group with one briefed worker, for a spec to archive.
 */
export async function simulateArchivedGroups(
  scenes: MockScenes,

  board: MockBoardSimulation,
): Promise<{ readonly archived: readonly ThreadId[]; readonly nightly: ThreadId }> {
  const { host, find, project, put } = scenes;
  const settings = await host.settings();
  const { workspaceId, orchestratorThreadId } = board;
  const home = find(workspaceId).workspace.homeProjectId;
  const day = 24 * 60 * 60_000;
  const spawn = async (feature: string, title: string) => {
    const created = await host.createThread({
      projectRoot: project(home).root,
      title,
      mode: orchestrationMode(settings),
      branch: `feat/${feature}`,
    });
    const worker: Thread = {
      ...created,
      workspaceId,
      spawnedBy: { threadId: orchestratorThreadId, feature },
    };
    host.replace(worker);
    return worker;
  };
  const plans: Record<string, { features: Record<string, string>; stage: FeatureStage }> = {
    "v030-review": {
      features: {
        "review-fixes": "Fix what the 0.3.0 review found",
        "review-docs": "Docs pass",
      },
      stage: {
        plan: ["review", "fix", "merge", "release"],
        stage: "fix",
        note: "Fixes in; waiting on a last look before merging.",
        setBy: "orchestrator",
        setAt: Date.now() - 9 * day,
      },
    },
    "deps-majors": {
      features: {
        "bump-vite": "Vite major",
        "bump-vitest": "Vitest major",
        "bump-typescript": "TypeScript major",
      },
      stage: {
        plan: ["bump", "fix types", "merge"],
        stage: "fix types",
        note: "TypeScript waits on the Effect release.",
        setBy: "orchestrator",
        setAt: Date.now() - 4 * day,
      },
    },
    "riley-feedback": {
      features: {
        "sidebar-density": "Denser sidebar rows",
        "shortcut-hints": "Shortcut hints",
      },
      stage: {
        plan: ["triage", "build", "demo"],
        stage: "build",
        note: "Two of the five points; the rest went to the backlog.",
        setBy: "orchestrator",
        setAt: Date.now() - 2 * day,
      },
    },
    infra: {
      features: { "runner-cache": "Cache the CI runners' pnpm store" },
      stage: {
        plan: ["plan", "apply", "verify"],
        stage: "apply",
        setBy: "orchestrator",
        setAt: Date.now() - day,
      },
    },
  };
  const archived: ThreadId[] = [];
  for (const { features } of Object.values(plans)) {
    for (const [feature, title] of Object.entries(features)) {
      const worker = await spawn(feature, title);
      host.replace({ ...worker, parked: true, lastActivityAt: Date.now() - 2 * day });
      archived.push(worker.id);
    }
  }
  const nightly = await spawn("nightly-signing", "Sign the nightly builds");
  const state = find(workspaceId);
  put({
    ...state,
    groups: {
      ...state.groups,
      ...Object.fromEntries(
        Object.entries(plans).map(([group, { features, stage }]) => [
          group,
          { features: Object.keys(features), stage },
        ]),
      ),
      "nightly-builds": { features: ["nightly-signing"] },
    },
  });
  host.emit({ type: "orchestration.changed", workspaceId });
  return { archived, nightly: nightly.id };
}
