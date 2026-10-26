import type { LabelId, ThreadId, ThreadSummary } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { createMockApi, type MockApi } from "./mock";

const FLAKY = "t-flaky" as ThreadId;

async function snapshot(api: MockApi): Promise<readonly ThreadSummary[]> {
  const abort = new AbortController();
  for await (const event of api.events(abort.signal)) {
    if (event.type === "threads.snapshot") {
      abort.abort();
      return event.threads;
    }
  }
  return [];
}

describe("MockApi thread actions", () => {
  it("refuses to delete a dirty worktree unless forced", async () => {
    const api = createMockApi({ speed: 0, autoplay: false });
    await expect(
      api.closeThread(FLAKY, { removeWorktree: { force: false } }),
    ).rejects.toMatchObject({
      _tag: "WorktreeDirty",
      changedFiles: 5,
    });
    await api.closeThread(FLAKY, {
      removeWorktree: { force: true },
      permissionRules: ["Bash(pnpm test:*)"],
    });
    expect(api.lastClose).toEqual({
      threadId: FLAKY,
      options: { removeWorktree: { force: true }, permissionRules: ["Bash(pnpm test:*)"] },
    });
    expect((await snapshot(api)).some((s) => s.thread.id === FLAKY)).toBe(false);
  });

  it("offers pending permission rules only for worktrees", async () => {
    const api = createMockApi({ speed: 0, autoplay: false });
    const threads = await snapshot(api);
    const main = threads.find((s) => s.thread.checkout.kind === "main")!;
    expect(await api.pendingPermissions(FLAKY)).toContain("Bash(pnpm test:*)");
    expect(await api.pendingPermissions(main.thread.id)).toEqual([]);
  });

  it("lists a project's worktrees with open state", async () => {
    const api = createMockApi({ speed: 0, autoplay: false });
    const list = await api.listWorktrees("/Users/dev/code/api");
    expect(list.worktrees[0]).toMatchObject({ isMain: true, path: "/Users/dev/code/api" });
    expect(list.worktrees.find((w) => w.path.endsWith("fix-flaky-retry"))).toMatchObject({
      isOpen: true,
    });
    expect(list.worktrees.find((w) => w.branch === "experiment/cache")).toMatchObject({
      isOpen: false,
    });
  });

  it("upserts and removes labels, stripping them from threads", async () => {
    const api = createMockApi({ speed: 0, autoplay: false });
    const label = { id: "l-new" as LabelId, name: "new", color: "#9ece6a" };
    await api.upsertLabel(label);
    await api.upsertLabel({ ...label, name: "renamed" });
    expect((await api.labels()).find((l) => l.id === label.id)?.name).toBe("renamed");
    await api.label(FLAKY, [label.id]);
    await api.removeLabel(label.id);
    expect((await api.labels()).some((l) => l.id === label.id)).toBe(false);
    expect((await snapshot(api)).find((s) => s.thread.id === FLAKY)?.thread.labels).toEqual([]);
    await expect(api.removeLabel(label.id)).rejects.toThrow("NotFound");
  });

  it("opens one orchestrator per workspace, and frees the slot when it is closed", async () => {
    const api = createMockApi({ speed: 0, autoplay: false });
    const before = (await snapshot(api)).length;
    const [home, second] = await api.listProjects();

    const first = await api.openOrchestrator({ projectId: home!.id });
    expect(first).toMatchObject({ role: "orchestrator", projectId: home!.id, mode: "auto" });
    const [state] = await api.listWorkspaces();
    expect(state?.workspace).toMatchObject({
      name: home!.name,
      projectIds: [home!.id],
      orchestratorThreadId: first.id,
    });
    expect(first.workspaceId).toBe(state!.workspace.id);
    const workspaceId = state!.workspace.id;
    expect((await api.openOrchestrator({ workspaceId })).id).toBe(first.id);
    expect((await api.openOrchestrator({ projectId: home!.id })).id).toBe(first.id);
    expect(await snapshot(api)).toHaveLength(before + 1);
    await expect(api.removeWorkspace(workspaceId)).rejects.toMatchObject({ _tag: "InvalidState" });

    const paused = await api.setOrchestratorPaused(workspaceId, true);
    expect(paused.paused?.reason).toBe("user");
    const charter = { ...paused.charter, maxConcurrentWorkers: 2 };
    expect((await api.setOrchestratorCharter(workspaceId, charter)).charter).toEqual(charter);
    expect(await api.orchestratorLedger(workspaceId)).toMatchObject({
      orchestratorThreadId: first.id,
      features: [],
      budget: { liveWorkers: 0, maxConcurrentWorkers: 2 },
      paused: { reason: "user" },
    });
    expect("paused" in (await api.setOrchestratorPaused(workspaceId, false))).toBe(false);
    await expect(api.threadDetach(first.id)).rejects.toMatchObject({ _tag: "InvalidState" });

    const saved = await api.saveWorkspace({
      id: workspaceId,
      name: "Both",
      projectIds: [home!.id, second!.id],
      homeProjectId: home!.id,
    });
    expect(saved.workspace).toMatchObject({ name: "Both", orchestratorThreadId: first.id });
    await expect(
      api.saveWorkspace({ name: "x", projectIds: [home!.id], homeProjectId: second!.id }),
    ).rejects.toMatchObject({ _tag: "InvalidState" });

    await api.closeThread(first.id);
    const next = await api.openOrchestrator({ workspaceId });
    expect(next.id).not.toBe(first.id);
    await api.closeThread(next.id);
    await api.removeWorkspace(workspaceId);
    expect(await api.listWorkspaces()).toEqual([]);
    await expect(api.orchestratorLedger(workspaceId)).rejects.toMatchObject({
      _tag: "NotFound",
      entity: "workspace",
    });
  });
});
