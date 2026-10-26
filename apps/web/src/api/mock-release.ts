import {
  orchestrationMode,
  type PendingRequest,
  type RequestId,
  type Thread,
  type ThreadId,
} from "@gram/contracts";

import type { MockBoardSimulation, MockReleaseSimulation, MockScenes } from "./mock-orchestration";

// `release-0-8-0` beside the board scenario: a group that has collected a release's worth of work.

/**
 * `release-0-8-0`, a group at its `fixes` stage that has collected a release's worth of work:
 * thirty-odd merged, delivered and archived features, `worktree-sweep` among them, around four
 * still going (one running, one in review, one asking, and `0-8-notes`, whose third worker still
 * writes beside two merged ones).
 */
export async function simulateRelease(
  scenes: MockScenes,
  board: MockBoardSimulation,
): Promise<MockReleaseSimulation> {
  const { host, reports, askedAt, find, project, put } = scenes;
  const settings = await host.settings();
  const { workspaceId, orchestratorThreadId } = board;
  const home = find(workspaceId).workspace.homeProjectId;
  const origin = `example/${project(home).name}`;
  const hour = 60 * 60_000;
  const spawn = async (feature: string, title: string, slug = feature) => {
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
  const withPr = (worker: Thread, number: number, state: "OPEN" | "MERGED") =>
    host.setGit(worker.id, {
      repo: true,
      branch: worker.checkout.branch!,
      worktree: true,
      head: `${number}`.padEnd(40, "b"),
      changesToken: `mock-release-${number}`,
      changedFiles: 0,
      base: "origin/main",
      behindBase: state === "MERGED" ? 4 : 0,
      aheadBase: state === "MERGED" ? 0 : 3,
      conflicts: false,
      upstream: "synced",
      origin,
      pr: {
        number,
        state,
        url: `https://github.com/${origin}/pull/${number}`,
        title: worker.title,
        isDraft: false,
        checks: "passing",
        headMatches: true,
        aheadOfPr: false,
        baseRef: "main",
        headRef: worker.checkout.branch!,
        ...(state === "OPEN" ? { mergeState: "BLOCKED" as const } : {}),
      },
    });
  const merge = (worker: Thread, number: number, hoursAgo: number) => {
    withPr(worker, number, "MERGED");
    host.replace({
      ...worker,
      completedAt: Date.now() - hoursAgo * hour,
      completedReason: "prMerged",
      lastActivityAt: Date.now() - hoursAgo * hour,
    });
  };
  const shipped: [string, string][] = [
    ["0-8-design", "0.8 design review"],
    ["0-8-retro", "0.8 retro actions"],
    ["0-8-turn-errors", "0.8: say why a turn failed"],
    ["0-8-max-effort", "0.8: max effort for Opus"],
    ["0-8-plans", "0.8: a plan for every thread"],
    ["0-8-ai-helpers", "0.8: Settings → AI helpers"],
    ["0-8-suggested-replies", "0.8: suggested replies"],
    ["0-8-gateway-pickers", "0.8: gateway model pickers"],
    ["0-8-repo-picker", "0.8: every repo in your folder"],
    ["0-8-standing", "0.8: standing decisions"],
    ["0-8-connectors", "0.8: orchestrators travel light"],
    ["0-8-wakes", "0.8: scheduled wakes"],
    ["0-8-narrow", "0.8: narrow windows keep the chat"],
    ["0-8-paused", "0.8: paused workspaces say so"],
    ["0-8-requests", "0.8: requests and decisions"],
    ["0-8-autonomy", "0.8: first workspace autonomy"],
    ["0-8-approvals", "0.8: approval arguments"],
    ["0-8-needs-you", "0.8: needs you, in words"],
    ["0-8-stopped", "0.8: a stopped worker says why"],
    ["0-8-cli-versions", "0.8: agent CLI versions"],
    ["0-8-catalogue", "0.8: MCP platform catalogue"],
    ["0-8-waits", "0.8: what each worker waits on"],
    ["audit-logging", "Audit: what the server logs"],
    ["audit-ipc", "Audit: the preload bridge"],
    ["audit-updater", "Audit: the updater's checks"],
    ["audit-deps", "Audit: dependency licences"],
  ];
  const merged: ThreadId[] = [];
  let number = 240;
  for (const [index, [feature, title]] of shipped.entries()) {
    const worker = await spawn(feature, title);
    merge(worker, number++, 2 + index * 3);
    merged.push(worker.id);
  }
  const delivered = await spawn("0-8-audit-summary", "Audit: summary for the release notes");
  reports.set(delivered.id, {
    threadId: delivered.id,
    state: "done",
    summary: "docs/audit-0.8.md is written up.",
    at: Date.now() - 6 * hour,
  });
  host.replace({ ...delivered, completedAt: Date.now() - 6 * hour, completedReason: "agent" });
  const archived = await spawn("worktree-sweep", "Sweep finished worktrees");
  host.replace({ ...archived, parked: true, lastActivityAt: Date.now() - 40 * hour });

  const notesA = await spawn("0-8-notes", "Release notes: highlights", "0-8-notes");
  const notesB = await spawn("0-8-notes", "Release notes: screenshots", "0-8-notes-shots");
  const notesRunning = await spawn("0-8-notes", "Release notes: FEATURES.md", "0-8-notes-docs");
  merge(notesA, number++, 3);
  merge(notesB, number++, 1);
  merged.push(notesA.id, notesB.id);
  host.setStatus(notesRunning.id, "running", "editing docs/FEATURES.md");

  const running = await spawn("0-8-sidebar-fold", "0.8: fold finished threads");
  host.setStatus(running.id, "running", "pnpm vitest run tree");
  const inReview = await spawn("0-8-board-split", "0.8: board split by waits");
  withPr(inReview, number++, "OPEN");
  const asking = await spawn("0-8-signing", "0.8: notarise the Windows build");
  const question: PendingRequest = {
    kind: "question",
    id: `r-question-${asking.id}` as RequestId,
    toolUseId: `toolu_question_${asking.id}`,
    questions: [
      {
        question: "Sign the RC with the release certificate or the test one?",
        header: "Signing",
        multiSelect: false,
        options: [
          { label: "Release", description: "What 0.8.0 ships with." },
          { label: "Test", description: "Only the RC's testers see it." },
        ],
      },
    ],
  };
  askedAt.set(question.id, Date.now() - 2 * 60_000);
  host.ask(asking.id, question, () => {
    askedAt.delete(question.id);
    host.setStatus(asking.id, "running", "signing the RC");
    host.emit({ type: "orchestration.changed", workspaceId });
  });

  const features = [
    ...shipped.slice(0, 12).map(([feature]) => feature),
    "0-8-sidebar-fold",
    ...shipped.slice(12).map(([feature]) => feature),
    "0-8-board-split",
    "0-8-audit-summary",
    "worktree-sweep",
    "0-8-notes",
    "0-8-signing",
  ];
  put({
    ...find(workspaceId),
    groups: {
      ...find(workspaceId).groups,
      "release-0-8-0": {
        features,
        stage: {
          plan: ["design", "build", "fixes", "release candidate", "release"],
          stage: "fixes",
          setBy: "orchestrator",
          setAt: Date.now() - 5 * hour,
        },
      },
    },
  });
  host.emit({ type: "orchestration.changed", workspaceId });
  return {
    running: running.id,
    inReview: inReview.id,
    asking: asking.id,
    notesRunning: notesRunning.id,
    merged,
    archived: archived.id,
  };
}
