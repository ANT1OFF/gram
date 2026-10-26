import { orchestrationMode, type ProjectId, type Thread, type WorkerReport } from "@gram/contracts";

import type { MockOrchestrationSimulation, MockScenes } from "./mock-orchestration";

// The `report` scenario: one orchestrator at work in a one-project workspace, with a worker that
// reports back.

/**
 * One orchestrator at work in `projectId`'s one-project workspace: its session-start digest, a
 * worker in a new worktree that reports back, a memory write, a handoff, and the digest that
 * report woke it with. Works with the setting off, as roles outlive the setting.
 */
export async function simulate(
  scenes: MockScenes,
  projectId: ProjectId,
): Promise<MockOrchestrationSimulation> {
  const {
    host,
    reports,
    find,
    project,
    fillSlot,
    oneProjectWorkspace,
    buildLedger,
    digestMessage,
    assistantMessage,
  } = scenes;
  const settings = await host.settings();
  const state = await oneProjectWorkspace(projectId);
  const workspaceId = state.workspace.id;
  const orchestrator = await fillSlot(state, settings);
  const feature = "rate-limit-headers";

  const boot = buildLedger(find(workspaceId));
  host.putMessage(
    orchestrator.id,
    digestMessage({
      kind: "orchestration",
      variant: "boot",
      generation: 0,
      workspaceId,
      workspaceName: state.workspace.name,
      reasons: [],
      changes: [],
      reports: [],
      features: boot.features,
      budget: boot.budget,
      notes: [
        "You were opened by the user. Nothing is running yet.",
        "Memory index (MEMORY.md)\n- map.md: the repos of this workspace and how they fit\n- conventions.md: branch names and review habits",
      ],
    }),
  );

  const created = await host.createThread({
    projectRoot: project(state.workspace.homeProjectId).root,
    title: "Return rate-limit headers",
    mode: orchestrationMode(settings),
    branch: `feat/${feature}`,
  });
  const worker: Thread = {
    ...created,
    workspaceId,
    spawnedBy: { threadId: orchestrator.id, feature },
  };
  host.replace(worker);

  const before = "# Map\n\n- api: the HTTP service\n";
  const after = `${before}- api/src/middleware: where rate limiting lives\n`;
  host.putMessage(
    orchestrator.id,
    assistantMessage([
      { type: "text", text: `Spawned a worker for ${feature}. I'll be woken when it reports.` },
      {
        type: "data-memory-write",
        id: host.ids(),
        data: { path: "map.md", action: "write", before, after, bytes: after.length },
      },
      {
        type: "data-handoff",
        id: host.ids(),
        data: { reason: "context", at: Date.now() },
      },
    ]),
  );

  const report: WorkerReport = {
    threadId: worker.id,
    state: "done",
    summary:
      "Added X-RateLimit-Limit, -Remaining and -Reset to every response.\n**Not markdown**: this text is the worker's own, shown as written.",
    prUrl: "https://github.com/example/api/pull/431",
    interface:
      "X-RateLimit-Limit: number\nX-RateLimit-Remaining: number\nX-RateLimit-Reset: epoch seconds",
    at: Date.now(),
  };
  reports.set(worker.id, report);
  host.putMessage(
    worker.id,
    assistantMessage([
      { type: "text", text: "The headers are in and the tests pass." },
      { type: "data-worker-report", id: host.ids(), data: report },
    ]),
  );

  const ledger = buildLedger(find(workspaceId));
  host.putMessage(
    orchestrator.id,
    digestMessage({
      kind: "orchestration",
      variant: "digest",
      generation: 1,
      workspaceId,
      workspaceName: state.workspace.name,
      reasons: ["worker report"],
      changes: [{ threadId: worker.id, feature, title: worker.title, from: "working", to: "done" }],
      reports: [{ ...report, title: worker.title, feature }],
      features: ledger.features,
      budget: ledger.budget,
      notes: [],
    }),
  );
  host.emit({ type: "orchestration.changed", workspaceId });
  return { workspaceId, orchestratorThreadId: orchestrator.id, workerThreadId: worker.id };
}
