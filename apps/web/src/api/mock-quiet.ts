import {
  orchestrationMode,
  type PrStatus,
  type ProjectId,
  type Thread,
  type ThreadId,
  type WorkspaceId,
} from "@gram/contracts";

import type {
  MockQuietBusySimulation,
  MockScenes,
  MockWaitingOnSimulation,
} from "./mock-orchestration";

// Quiet's scenarios: a workspace whose workers are all busy somewhere, and two more workspaces at
// rest beside the board's for the sidebar's realistic load.

/**
 * `casefiles`, a workspace with nothing to ask whose six workers are all somewhere: two running a
 * turn, three waiting on automation (CI under a monitor, the review bot, a dependency PR), and
 * one stopped on a conflict with nothing armed. What Quiet's summary and strip count as busy.
 */
export async function simulateQuietBusy(
  scenes: MockScenes,
  projectIds: readonly ProjectId[],
): Promise<MockQuietBusySimulation> {
  const { host, workspaces, project, create, fillSlot, notFound } = scenes;
  const settings = await host.settings();
  const [home, ...rest] = projectIds;
  if (home === undefined) throw notFound("project", "(none)");
  const name = "casefiles";
  const state =
    workspaces().find((w) => w.workspace.name === name) ??
    (await create({ name, projectIds: [home, ...rest], homeProjectId: home }));
  const workspaceId = state.workspace.id;
  const orchestrator = await fillSlot(state, settings);
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
      spawnedBy: { threadId: orchestrator.id, feature },
    };
    host.replace(worker);
    return worker;
  };
  const withPr = (worker: Thread, number: number, pr: Partial<PrStatus>) =>
    host.setGit(worker.id, {
      repo: true,
      branch: worker.checkout.branch!,
      worktree: true,
      head: `${number}`.padEnd(40, "b"),
      changesToken: `mock-quiet-${number}`,
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
  const bind = (
    worker: Thread,
    number: number,
    more: Omit<NonNullable<Thread["boundPr"]>, "repo" | "number">,
  ) => host.replace({ ...worker, boundPr: { repo: origin, number, ...more } });

  const editing = await spawn("casefile-export", "Configurable export command", "export-cmd");
  host.setStatus(editing.id, "running", "Editing src/export/command.ts");
  const ci = await spawn("casefile-index", "Label owner changes", "owner-labels");
  withPr(ci, 341, { checks: "pending", mergeState: "BLOCKED" });
  bind(ci, 341, { monitor: true, reviewMonitor: true });
  const conflicts = await spawn("casefile-retention", "Retention footer", "retention-footer");
  withPr(conflicts, 342, { mergeState: "DIRTY" });
  const reviewing = await spawn("casefile-index", "Backfill the owner index", "owner-backfill");
  withPr(reviewing, 343, {
    mergeState: "BLOCKED",
    review: {
      bots: ["example-code-review"],
      reviewedHead: false,
      roundInFlight: true,
      threads: { unresolved: 0, blockers: 0, suggestions: 0, outdatedUnresolved: 0 },
    },
  });
  bind(reviewing, 343, { monitor: false, reviewMonitor: true });
  const testing = await spawn("casefile-search", "Search casefiles by tag", "tag-search");
  host.setStatus(testing.id, "running", "pnpm vitest run search");
  const stacked = await spawn("casefile-index", "Owner filter in the list", "owner-filter");
  withPr(stacked, 344, { mergeState: "BLOCKED" });
  bind(stacked, 344, {
    monitor: false,
    dependsOn: [{ repo: origin, number: 341, setBy: "thread", setAt: Date.now() }],
  });
  host.emit({ type: "orchestration.changed", workspaceId });
  return {
    workspaceId,
    orchestratorThreadId: orchestrator.id,
    editing: editing.id,
    testing: testing.id,
    ci: ci.id,
    reviewing: reviewing.id,
    stacked: stacked.id,
    conflicts: conflicts.id,
  };
}

/**
 * `casefiles` as `simulateQuietBusy` leaves it, with a worker more for each other kind of wait the
 * sidebar names: a timed wake, a release run it watches, a usage limit it waits out, a merge Gram
 * makes once ready, and a wake on another PR; and the orchestrator resting on a wake of its own.
 * Times sit on the half hour after now, so a shot's labels move only with the clock's half hour.
 */
export async function simulateWaitingOn(
  scenes: MockScenes,
  projectIds: readonly ProjectId[],
): Promise<MockWaitingOnSimulation> {
  const busy = await simulateQuietBusy(scenes, projectIds);
  const { host, wakesOf, project, find } = scenes;
  const settings = await host.settings();
  const home = find(busy.workspaceId).workspace.homeProjectId;
  const origin = `example/${project(home).name}`;
  const minute = 60_000;
  const base = Math.ceil(Date.now() / (30 * minute)) * 30 * minute;
  const spawn = async (feature: string, title: string, slug: string) => {
    const created = await host.createThread({
      projectRoot: project(home).root,
      title,
      mode: orchestrationMode(settings),
      branch: `feat/${slug}`,
    });
    const worker: Thread = {
      ...created,
      workspaceId: busy.workspaceId,
      spawnedBy: { threadId: busy.orchestratorThreadId, feature },
    };
    host.replace(worker);
    return worker;
  };
  const wake = (threadId: ThreadId, at: number, note: string, more: object = {}) =>
    wakesOf.set(threadId, [
      ...(wakesOf.get(threadId) ?? []),
      { id: `wake-${at}`, at, note, ...more },
    ]);

  const timed = await spawn("casefile-export", "Nightly export retry", "export-retry");
  wake(timed.id, base + 40 * minute, "Retry the export once the archive job is done");
  const release = await spawn("casefile-release", "Cut 2.4.0", "release-240");
  host.replace({
    ...release,
    completedAt: Date.now(),
    completedReason: "agent",
    runWatches: [{ repo: origin, runId: 8812, name: "Release", since: Date.now() - 4 * minute }],
  });
  const limited = await spawn("casefile-index", "Reindex old casefiles", "reindex-old");
  host.replace({
    ...limited,
    limitWait: {
      kind: "limit",
      account: `${limited.model.agent}/`,
      resumeAt: base + 70 * minute,
      since: Date.now(),
      attempt: 1,
    },
  });
  const merging = await spawn("casefile-retention", "Retention settings page", "retention-page");
  host.setGit(merging.id, {
    repo: true,
    branch: merging.checkout.branch!,
    worktree: true,
    head: "345".padEnd(40, "c"),
    changesToken: "mock-waiting-345",
    changedFiles: 0,
    base: "origin/main",
    behindBase: 0,
    aheadBase: 1,
    conflicts: false,
    upstream: "synced",
    origin,
    pr: {
      number: 345,
      state: "OPEN",
      url: `https://github.com/${origin}/pull/345`,
      title: merging.title,
      isDraft: false,
      checks: "passing",
      headMatches: true,
      aheadOfPr: false,
      baseRef: "main",
      headRef: merging.checkout.branch!,
      mergeState: "CLEAN",
    },
  });
  host.replace({
    ...merging,
    boundPr: {
      repo: origin,
      number: 345,
      monitor: true,
      mergeWhenReady: { method: "squash", allowedBy: "autonomy", setAt: Date.now() },
    },
  });
  const rebase = await spawn("casefile-index", "Owner column sort", "owner-sort");
  wake(rebase.id, base + 120 * minute, "Rebase onto #341 once it lands", {
    onPr: { repo: origin, number: 341 },
    on: ["merged"],
  });
  wake(busy.orchestratorThreadId, base + 10 * minute, "Check #341 and #343, then merge the index");
  host.emit({ type: "orchestration.changed", workspaceId: busy.workspaceId });
  return {
    ...busy,
    timed: timed.id,
    release: release.id,
    limited: limited.id,
    merging: merging.id,
    rebase: rebase.id,
  };
}

/**
 * Two more workspaces beside the board scenario's busy one, for the sidebar's realistic load: one
 * at rest, its workers idle or merged, and one whose orchestrator the caller parks. Returns the
 * orchestrator to park.
 */
export async function simulateQuietWorkspaces(
  scenes: MockScenes,

  projectIds: readonly ProjectId[],
): Promise<{ readonly idle: WorkspaceId; readonly toPark: ThreadId }> {
  const { host, workspaces, project, create, fillSlot, notFound } = scenes;
  const settings = await host.settings();
  const hour = 60 * 60_000;
  const [first, second = first, third = second] = projectIds;
  if (first === undefined || third === undefined || second === undefined) {
    throw notFound("project", "(none)");
  }
  const make = async (name: string, home: ProjectId, others: readonly ProjectId[]) => {
    const state =
      workspaces().find((w) => w.workspace.name === name) ??
      (await create({ name, projectIds: [home, ...others], homeProjectId: home }));
    const orchestrator = await fillSlot(state, settings);
    const spawn = async (feature: string, title: string, hoursAgo: number) => {
      const created = await host.createThread({
        projectRoot: project(home).root,
        title,
        mode: orchestrationMode(settings),
        branch: `feat/${feature}`,
      });
      const worker: Thread = {
        ...created,
        workspaceId: state.workspace.id,
        spawnedBy: { threadId: orchestrator.id, feature },
        lastActivityAt: Date.now() - hoursAgo * hour,
      };
      host.replace(worker);
      return worker;
    };
    host.replace({ ...orchestrator, lastActivityAt: Date.now() - 3 * hour });
    return { workspaceId: state.workspace.id, orchestrator, spawn };
  };

  const docs = await make("docs-site", third, [second]);
  await docs.spawn("search-index", "Index the docs for search", 3);
  await docs.spawn("search-index", "Search box in the header", 4);
  const typos = await docs.spawn("typo-sweep", "Sweep the typos", 20);
  host.replace({ ...typos, completedAt: Date.now() - 20 * hour, completedReason: "agent" });
  host.emit({ type: "orchestration.changed", workspaceId: docs.workspaceId });

  const infra = await make("infra-migration", second, []);
  await infra.spawn("terraform-state", "Move the Terraform state", 50);
  await infra.spawn("dns-cutover", "Cut DNS over", 52);
  host.emit({ type: "orchestration.changed", workspaceId: infra.workspaceId });
  return { idle: docs.workspaceId, toPark: infra.orchestrator.id };
}
