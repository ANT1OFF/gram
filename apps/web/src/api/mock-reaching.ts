import {
  orchestrationMode,
  type FinishedWorkerDetail,
  type GramUIMessage,
  type ProjectId,
  type StuckView,
  type ThreadId,
  type WorkerReport,
  type WorkspaceId,
} from "@gram/contracts";

import type { MockOrchestrationHost } from "./mock-orchestration";
import type { MockWorkersSimulation } from "./mock-workers";

// Reaching workers, beside the ⌘J scenario: a worker whose worktree the sweep cleaned up, kept
// read-only as the server's closed list keeps it, and one that hasn't moved in two hours, with the
// helper's "Why is it stuck?" sentence armed and a PR whose checks fail.

export interface MockReachingDeps {
  readonly host: MockOrchestrationHost;
  readonly home: (workspaceId: WorkspaceId) => { readonly id: ProjectId; readonly root: string };
  readonly fileReport: (report: WorkerReport) => void;
  readonly addFinished: (detail: FinishedWorkerDetail) => void;
  readonly stuck: (view: StuckView) => void;
}

export interface MockReachingSimulation extends MockWorkersSimulation {
  /** Merged and closed with its worktree today: only the finished list has it. */
  readonly cleanedUp: ThreadId;
  /** Idle two hours, its last command a `gh pr checks` on a PR whose checks fail. */
  readonly stuck: ThreadId;
}

export const MOCK_STUCK_TEXT = "It waits for the paging API, and no PR in api mentions paging yet.";

const MINUTE = 60_000;

export async function simulateReaching(
  deps: MockReachingDeps,
  workers: MockWorkersSimulation,
): Promise<MockReachingSimulation> {
  const { host } = deps;
  const settings = await host.settings();
  const { workspaceId, orchestratorThreadId } = workers;
  const home = deps.home(workspaceId);
  const now = Date.now();

  // Cleaned up: merged as #428 within the hour, closed with its worktree ten minutes later.
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const closedAt = Math.max(now - 25 * MINUTE, midnight.getTime() + MINUTE);
  const cleanedUp = host.ids() as ThreadId;
  const brief = "Add the dead_letters table and its migration. Keep it additive.";
  const message = (role: "user" | "assistant", at: number, parts: GramUIMessage["parts"]) =>
    ({ id: host.ids(), role, metadata: { createdAt: at }, parts }) as GramUIMessage;
  const report: WorkerReport = {
    threadId: cleanedUp,
    state: "done",
    summary: "The dead_letters table and its migration are in, with tests. Merged as #428.",
    prUrl: "https://github.com/example/api/pull/428",
    at: closedAt - 12 * MINUTE,
  };
  deps.addFinished({
    worker: {
      threadId: cleanedUp,
      workspaceId,
      title: "Dead-letter table",
      feature: "mail-retry-policy",
      orchestratorThreadId,
      closedAt,
      completedReason: "prMerged",
      lastReport: report,
      prs: [
        {
          repo: "example/api",
          number: 428,
          url: "https://github.com/example/api/pull/428",
          merged: true,
        },
      ],
      kept: "closed",
    },
    brief,
    reports: [report],
    files: [
      { path: "migrations/0042_dead_letters.py", additions: 48, deletions: 0 },
      { path: "queue/models.py", additions: 12, deletions: 2 },
      { path: "tests/queue/test_dead_letters.py", additions: 64, deletions: 0 },
    ],
    messages: [
      message("user", closedAt - 60 * MINUTE, [{ type: "text", text: brief }]),
      message("assistant", closedAt - 50 * MINUTE, [
        {
          type: "text",
          text: "Adding the table as a new migration, so nothing existing changes.",
          state: "done",
        },
      ]),
      message("assistant", closedAt - 20 * MINUTE, [
        {
          type: "text",
          text: "Opened example/api#428 with the migration and tests. CI is green.",
          state: "done",
        },
      ]),
    ],
    earlierOmitted: 0,
  });

  // Stuck: idle two hours on a feature of its own, its PR's checks failing.
  const created = await host.createThread({
    projectRoot: home.root,
    title: "Audit log paging",
    mode: orchestrationMode(settings),
    branch: "feat/audit-log-paging",
  });
  const idleSince = now - 2 * 60 * MINUTE;
  host.putMessage(
    created.id,
    message("user", idleSince - 30 * MINUTE, [
      { type: "text", text: "Page the audit log with the new paging API." },
    ]),
  );
  host.putMessage(
    created.id,
    message("assistant", idleSince, [
      {
        type: "text",
        text: "The log needs the paging API's cursor. Waiting for it before wiring the list.",
        state: "done",
      },
    ]),
  );
  // After its messages, which would count as moving.
  host.replace({
    ...created,
    workspaceId,
    spawnedBy: { threadId: orchestratorThreadId, feature: "audit-log" },
    lastActivityAt: idleSince,
    lastViewedAt: now - 30 * MINUTE,
  });
  const stuckReport: WorkerReport = {
    threadId: created.id,
    state: "progress",
    summary: "Waiting on the paging API before wiring the list.",
    at: idleSince - 5 * MINUTE,
  };
  deps.fileReport(stuckReport);
  deps.stuck({
    threadId: created.id,
    facts: {
      idleSince,
      lastReport: stuckReport,
      lastTool: "Bash gh pr list --search paging",
      prs: ["web#91 open, checks failing"],
    },
    text: MOCK_STUCK_TEXT,
  });

  host.emit({ type: "orchestration.changed", workspaceId });
  return { ...workers, cleanedUp, stuck: created.id };
}
