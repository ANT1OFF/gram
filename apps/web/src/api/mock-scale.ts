import {
  orchestrationMode,
  type GitState,
  type GramUIMessage,
  type ProjectId,
  type Thread,
  type ThreadId,
  type WorkerReport,
  type WorkspaceId,
} from "@gram/contracts";
import { longTranscript } from "@gram/contracts/testing";

import type { MockScenes } from "./mock-orchestration";

// The scale scenario's workspaces, for the performance specs: ten workspaces, the first with an
// orchestrator running forty workers over ten features, the others with nine workers each. Every
// worker has a short generated transcript; the big orchestrator a long one. Names are invented.

const MINUTE = 60_000;
const FEATURES = [
  "retry-policy",
  "rate-headers",
  "audit-log",
  "search-index",
  "billing-export",
  "cold-start",
  "sso-login",
  "queue-metrics",
  "schema-migrate",
  "cache-warmup",
];

/** What the scale scenario's workspaces are, for a spec to navigate by. */
export interface MockScaleWorkspaces {
  readonly workspaceIds: readonly WorkspaceId[];
  /** The first workspace's orchestrator, with its forty workers. */
  readonly orchestratorThreadId: ThreadId;
  readonly workerIds: readonly ThreadId[];
  /** Every thread the workspaces hold: orchestrators and workers. */
  readonly threadIds: readonly ThreadId[];
}

export async function simulateScaleWorkspaces(
  scenes: MockScenes,
  {
    projects,
    workspaces = 10,
    bigWorkers = 40,
    otherWorkers = 9,
  }: {
    readonly projects: readonly ProjectId[];
    readonly workspaces?: number;
    readonly bigWorkers?: number;
    readonly otherWorkers?: number;
  },
): Promise<MockScaleWorkspaces> {
  const { host, create, fillSlot, project, reports } = scenes;
  const settings = await host.settings();
  const now = Date.now();
  const workspaceIds: WorkspaceId[] = [];
  const threadIds: ThreadId[] = [];
  const workerIds: ThreadId[] = [];
  let orchestratorThreadId: ThreadId | undefined;

  const put = (threadId: ThreadId, messages: readonly GramUIMessage[]) => {
    for (const message of messages) host.putMessage(threadId, message);
  };

  for (let w = 0; w < workspaces; w++) {
    const home = projects[w % projects.length]!;
    const state = await create({ name: `scale-${w + 1}`, projectIds: [home], homeProjectId: home });
    const orchestrator = await fillSlot(state, settings);
    workspaceIds.push(state.workspace.id);
    threadIds.push(orchestrator.id);
    if (w === 0) orchestratorThreadId = orchestrator.id;
    put(
      orchestrator.id,
      longTranscript({
        threadId: orchestrator.id,
        turns: w === 0 ? 60 : 4,
        toolOutputBytes: 1_000,
        diffLines: 8,
        startAt: now - 6 * 60 * MINUTE,
      }),
    );

    const count = w === 0 ? bigWorkers : otherWorkers;
    for (let i = 0; i < count; i++) {
      const feature = FEATURES[i % FEATURES.length]!;
      const slug = `${feature}-${w}-${i}`;
      const created = await host.createThread({
        projectRoot: project(home).root,
        title: `${feature.replace("-", " ")} part ${Math.floor(i / FEATURES.length) + 1}`,
        mode: orchestrationMode(settings),
        branch: `feat/${slug}`,
      });
      const minutesAgo = 5 + ((i * 7) % 300);
      const worker: Thread = {
        ...created,
        workspaceId: state.workspace.id,
        spawnedBy: { threadId: orchestrator.id, feature },
        createdAt: now - (minutesAgo + 30) * MINUTE,
        lastActivityAt: now - minutesAgo * MINUTE,
      };
      host.replace(worker);
      put(
        worker.id,
        longTranscript({
          threadId: worker.id,
          turns: 3,
          toolOutputBytes: 600,
          diffLines: 6,
          startAt: worker.createdAt,
        }),
      );
      // A spread of what workers are doing: a third running, some with an open PR, a few merged.
      const kind = i % 6;
      const git: GitState = {
        repo: true,
        branch: worker.checkout.branch!,
        worktree: true,
        head: `${w}${i}`.padEnd(40, "0"),
        changesToken: `mock-scale-${worker.id}`,
        changedFiles: kind === 0 ? 0 : (i % 9) + 1,
        base: "origin/main",
        behindBase: 0,
        aheadBase: 2,
        conflicts: false,
        upstream: "synced",
        origin: "example/api",
        ...(kind >= 3
          ? {
              pr: {
                number: 1_000 + w * 100 + i,
                state: kind === 5 ? ("MERGED" as const) : ("OPEN" as const),
                url: `https://github.com/example/api/pull/${1_000 + w * 100 + i}`,
                title: worker.title,
                isDraft: false,
                checks: kind === 4 ? ("pending" as const) : ("passing" as const),
                headMatches: true,
                aheadOfPr: false,
                baseRef: "main",
                headRef: worker.checkout.branch!,
              },
            }
          : {}),
      };
      host.setGit(worker.id, git);
      if (kind === 5) {
        host.replace({
          ...worker,
          completedAt: now - minutesAgo * MINUTE,
          completedReason: "prMerged",
        });
      }
      if (kind < 2) host.setStatus(worker.id, "running", `Reading src/${feature}/module-${i}.ts`);
      const report: WorkerReport = {
        threadId: worker.id,
        state: kind === 5 ? "done" : "progress",
        summary: `${feature}: step ${i % 5} of 5 done.`,
        at: now - minutesAgo * MINUTE,
      };
      reports.set(worker.id, report);
      threadIds.push(worker.id);
      if (w === 0) workerIds.push(worker.id);
    }
    host.emit({ type: "orchestration.changed", workspaceId: state.workspace.id });
  }
  host.emit({ type: "workspaces.changed" });
  return { workspaceIds, orchestratorThreadId: orchestratorThreadId!, workerIds, threadIds };
}
