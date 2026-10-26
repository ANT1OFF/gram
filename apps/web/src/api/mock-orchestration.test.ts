import type { DraftId, OrchestratorLedger, ProjectId, RequestId, ThreadId } from "@gram/contracts";
import { describe, expect, it, vi } from "vitest";

import { createThreadFeed, syncScheduler } from "@/stores/thread-feed";

import { createMockApi, type MockApi } from "./mock";
import { groupByFeature, mockWorkerState } from "./mock-orchestration";
import type { ApiServerEvent } from "./types";

const messagesOf = async (api: MockApi, threadId: ThreadId) => {
  const abort = new AbortController();
  const feed = createThreadFeed({ scheduler: syncScheduler });
  for await (const event of api.threadFeed(threadId, abort.signal)) {
    feed.apply(event);
    if (event.type === "caughtUp") break;
  }
  abort.abort();
  return feed.store.getState().messages;
};

const partTypes = (messages: Awaited<ReturnType<typeof messagesOf>>) =>
  messages.flatMap((message) => message.parts.map((part) => part.type));

const states = (ledger: OrchestratorLedger) =>
  Object.fromEntries(ledger.features.flatMap((f) => f.workers).map((w) => [w.threadId, w.state]));

describe("MockApi orchestration", () => {
  it.each(["open", "task"])(
    "chooses an available implicit workspace name for %s",
    async (action) => {
      const api = createMockApi({ speed: 0, autoplay: false });
      const projectId = "p-api" as ProjectId;
      for (const name of [" API ", "api (2)"]) {
        await api.saveWorkspace({
          name,
          projectIds: ["p-web" as ProjectId],
          homeProjectId: "p-web" as ProjectId,
        });
      }
      const thread =
        action === "open"
          ? await api.openOrchestrator({ projectId })
          : await api.startTask({ target: { projectId }, input: { text: "Review the project" } });
      const workspaces = await api.listWorkspaces();
      expect(
        workspaces.find(({ workspace }) => workspace.id === thread.workspaceId)?.workspace,
      ).toMatchObject({
        name: "api (3)",
        projectIds: [projectId],
      });
      expect((await api.openOrchestrator({ projectId })).id).toBe(thread.id);
      expect(await api.listWorkspaces()).toHaveLength(3);
      await expect(
        api.saveWorkspace({ name: " API (3) ", projectIds: [projectId], homeProjectId: projectId }),
      ).rejects.toMatchObject({ _tag: "InvalidState" });
    },
  );

  it("opens one orchestrator per workspace", async () => {
    const api = createMockApi({ speed: 0, autoplay: false });
    const thread = await api.openOrchestrator({ projectId: "p-api" as ProjectId });
    expect(thread).toMatchObject({ role: "orchestrator", mode: "auto" });
    const [state] = await api.listWorkspaces();
    expect(state?.workspace).toMatchObject({
      name: "api",
      projectIds: ["p-api"],
      orchestratorThreadId: thread.id,
    });
    // The slot is taken: asking again, by project or by workspace, is the same thread.
    expect((await api.openOrchestrator({ projectId: "p-api" as ProjectId })).id).toBe(thread.id);
    expect((await api.openOrchestrator({ workspaceId: state!.workspace.id })).id).toBe(thread.id);

    await expect(api.removeWorkspace(state!.workspace.id)).rejects.toMatchObject({
      _tag: "InvalidState",
    });
    await api.closeThread(thread.id);
    await api.removeWorkspace(state!.workspace.id);
    expect(await api.listWorkspaces()).toEqual([]);
  });

  it("starts a task: a repo's workspace, the words to its orchestrator, or a held worker", async () => {
    const api = createMockApi({ speed: 0, autoplay: false });
    const draftId = "5a9b6bc9-01d5" as DraftId;
    const staged = await api.uploadAttachment(
      { draftId },
      { name: "shot.png", mediaType: "image/png", data: "iVBORw0KGgo=" },
    );
    const orchestrator = await api.startTask({
      target: { projectId: "p-api" as ProjectId },
      input: { text: "Add a retry to the mail trigger", attachments: [staged] },
      draftId,
    });
    expect(orchestrator).toMatchObject({ role: "orchestrator", projectId: "p-api" });
    // The draft's file moves into the orchestrator's folder, as the server moves it.
    const [message] = await messagesOf(api, orchestrator.id);
    const file = message?.parts.find((part) => part.type === "file");
    expect(file).toMatchObject({ url: expect.stringContaining(`/${orchestrator.id}/shot.png`) });
    await expect(
      api.readAttachment(orchestrator.id, `/mock/attachments/${orchestrator.id}/shot.png`),
    ).resolves.toBeDefined();
    const workspaceId = orchestrator.workspaceId!;
    expect((await api.listWorkspaces()).map((w) => w.workspace.projectIds)).toEqual([["p-api"]]);

    const worker = await api.startTask({
      target: { workspaceId },
      input: { text: "Fix the flaky retry test\nIt fails on Windows." },
      direct: { projectId: "p-api" as ProjectId },
    });
    expect(worker).toMatchObject({
      title: "Fix the flaky retry test",
      workspaceId,
      spawnedBy: { threadId: orchestrator.id, feature: "fix-the-flaky-retry-test" },
      checkout: { kind: "worktree", branch: "feat/fix-the-flaky-retry-test" },
    });
    const again = await api.startTask({
      target: { workspaceId },
      input: { text: "Fix the flaky retry test" },
      direct: { projectId: "p-api" as ProjectId },
    });
    expect(again.spawnedBy?.feature).toBe("fix-the-flaky-retry-test-2");
    const ledger = await api.orchestratorLedger(workspaceId);
    const entry = ledger.features.flatMap((f) => f.workers).find((w) => w.threadId === worker.id);
    expect(entry?.userIntervened).toBe(true);
    await expect(
      api.startTask({
        target: { workspaceId },
        input: { text: "Anything" },
        direct: { projectId: "p-web" as ProjectId },
      }),
    ).rejects.toMatchObject({ _tag: "InvalidState" });
  });

  it("saves, pauses and budgets a workspace, and rejects what the server would", async () => {
    const api = createMockApi({ speed: 0, autoplay: false });
    const projectIds = ["p-api" as ProjectId, "p-web" as ProjectId] as const;
    await expect(
      api.saveWorkspace({ name: "x", projectIds, homeProjectId: "p-docs" as ProjectId }),
    ).rejects.toMatchObject({ _tag: "InvalidState" });
    await expect(
      api.saveWorkspace({
        name: "x",
        projectIds: ["p-gone" as ProjectId],
        homeProjectId: "p-gone" as ProjectId,
      }),
    ).rejects.toMatchObject({ _tag: "NotFound", entity: "project" });

    const saved = await api.saveWorkspace({
      name: "platform",
      projectIds,
      homeProjectId: "p-web" as ProjectId,
    });
    const id = saved.workspace.id;
    await expect(
      api.saveWorkspace({ name: " PLATFORM ", projectIds, homeProjectId: projectIds[0] }),
    ).rejects.toMatchObject({
      _tag: "InvalidState",
      message: "A workspace with that name already exists.",
    });
    expect(
      (
        await api.saveWorkspace({
          id,
          name: " PLATFORM ",
          projectIds,
          homeProjectId: projectIds[0],
        })
      ).workspace.name,
    ).toBe("PLATFORM");
    const renamed = await api.saveWorkspace({
      id,
      name: "platform-2",
      projectIds,
      homeProjectId: "p-api" as ProjectId,
    });
    expect(renamed.workspace).toMatchObject({ id, name: "platform-2", homeProjectId: "p-api" });
    const given = { maxConcurrentWorkers: 3, autonomy: "publish" } as const;
    const chartered = await api.saveWorkspace({
      name: "given",
      projectIds,
      homeProjectId: "p-api" as ProjectId,
      charter: given,
    });
    expect(chartered.charter).toEqual(given);
    await expect(
      api.saveWorkspace({
        id,
        name: "x",
        projectIds,
        homeProjectId: "p-api" as ProjectId,
        charter: given,
      }),
    ).rejects.toMatchObject({ _tag: "InvalidState" });

    const paused = await api.setOrchestratorPaused(id, true);
    expect(paused.paused).toMatchObject({ reason: "user" });
    expect((await api.orchestratorLedger(id)).paused).toMatchObject({ reason: "user" });
    expect((await api.setOrchestratorPaused(id, false)).paused).toBeUndefined();

    const charter = { ...saved.charter, maxConcurrentWorkers: 2 };
    expect((await api.setOrchestratorCharter(id, charter)).charter.maxConcurrentWorkers).toBe(2);
    expect((await api.orchestratorLedger(id)).budget.maxConcurrentWorkers).toBe(2);
    expect((await api.orchestratorLedger(id)).features).toEqual([]);
  });

  it("simulates an orchestrator with a worker, and the ledger follows the threads", async () => {
    const api = createMockApi({ speed: 0, autoplay: false });
    const abort = new AbortController();
    const events: ApiServerEvent[] = [];
    void (async () => {
      for await (const event of api.events(abort.signal)) events.push(event);
    })();

    const made = await api.simulateOrchestration();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const snapshot = events.find((e) => e.type === "threads.snapshot");
    const seeded = new Set(
      snapshot?.type === "threads.snapshot" ? snapshot.threads.map((t) => t.thread.id) : [],
    );
    const upserts = events.flatMap((e) => (e.type === "thread.upsert" ? [e.thread] : []));
    // Two threads join the seeded ones, which stay as many as the specs count.
    expect(new Set(upserts.map((t) => t.id).filter((id) => !seeded.has(id)))).toEqual(
      new Set([made.orchestratorThreadId, made.workerThreadId]),
    );
    const worker = upserts.findLast((t) => t.id === made.workerThreadId)!;
    expect(worker.spawnedBy).toEqual({
      threadId: made.orchestratorThreadId,
      feature: "rate-limit-headers",
    });
    expect(worker.checkout).toMatchObject({ kind: "worktree", branch: "feat/rate-limit-headers" });

    const orchestrator = await messagesOf(api, made.orchestratorThreadId);
    const digests = orchestrator.flatMap((message) =>
      message.parts.flatMap((part) =>
        part.type === "data-orchestration-digest" ? [part.data] : [],
      ),
    );
    expect(digests.map((digest) => digest.variant)).toEqual(["boot", "digest"]);
    expect(digests[1]).toMatchObject({
      generation: 1,
      changes: [{ threadId: made.workerThreadId, from: "working", to: "done" }],
      reports: [{ state: "done", feature: "rate-limit-headers" }],
    });
    // The agent's text is the serialized digest, which is what the card's collapsible shows.
    expect(orchestrator.at(-1)!.parts[0]).toMatchObject({
      type: "text",
      text: /^Orchestration digest #1/,
    });
    expect(partTypes(orchestrator)).toEqual(
      expect.arrayContaining(["data-memory-write", "data-handoff"]),
    );
    expect(partTypes(await messagesOf(api, made.workerThreadId))).toContain("data-worker-report");

    const ledger = await api.orchestratorLedger(made.workspaceId);
    expect(ledger).toMatchObject({
      orchestratorThreadId: made.orchestratorThreadId,
      budget: { liveWorkers: 1, maxConcurrentWorkers: 10 },
      features: [
        {
          feature: "rate-limit-headers",
          state: "done",
          workers: [{ threadId: made.workerThreadId, state: "done", project: "api" }],
        },
      ],
    });

    const detached = await api.threadDetach(made.workerThreadId);
    expect(detached.spawnedBy).toBeUndefined();
    expect(detached.workspaceId).toBeUndefined();
    expect((await api.orchestratorLedger(made.workspaceId)).features).toEqual([]);
    await expect(api.threadDetach(made.workerThreadId)).rejects.toMatchObject({
      _tag: "InvalidState",
    });
    expect(events.some((e) => e.type === "orchestration.changed")).toBe(true);
    expect(events.some((e) => e.type === "workspaces.changed")).toBe(true);
    abort.abort();
  });

  it("reopens a closed orchestrator and its worker into the workspace, a removed worktree too", async () => {
    const api = createMockApi({ speed: 0, autoplay: false });
    const made = await api.simulateOrchestration();
    await api.closeThread(made.workerThreadId, { removeWorktree: { force: true } });
    await api.closeThread(made.orchestratorThreadId);
    expect((await api.listClosedThreads()).map((c) => [c.thread.id, c.problem])).toEqual([
      [made.orchestratorThreadId, undefined],
      [made.workerThreadId, "folderMissing"],
    ]);

    const orchestrator = await api.reopenClosedThread();
    expect(orchestrator).toMatchObject({
      membership: "restored",
      thread: {
        id: made.orchestratorThreadId,
        role: "orchestrator",
        workspaceId: made.workspaceId,
      },
    });
    const worker = await api.reopenClosedThread();
    expect(worker).toMatchObject({
      membership: "restored",
      closed: { problem: "folderMissing" },
      thread: {
        id: made.workerThreadId,
        spawnedBy: { threadId: made.orchestratorThreadId, feature: "rate-limit-headers" },
      },
    });
    expect((await api.orchestratorLedger(made.workspaceId)).features).toMatchObject([
      { feature: "rate-limit-headers", workers: [{ threadId: made.workerThreadId }] },
    ]);
    expect(await api.restoreWorktree(made.workerThreadId)).toMatchObject({ _tag: "restored" });

    // Replaced since, the old orchestrator comes back as a plain thread in its workspace.
    await api.closeThread(made.orchestratorThreadId);
    const next = await api.openOrchestrator({ workspaceId: made.workspaceId });
    const displaced = await api.reopenClosedThread();
    expect(displaced?.membership).toBe("slotTaken");
    expect(displaced?.thread?.role).toBeUndefined();
    expect(displaced?.thread?.workspaceId).toBe(made.workspaceId);
    expect(
      (await api.listWorkspaces()).find((w) => w.workspace.id === made.workspaceId),
    ).toMatchObject({ workspace: { orchestratorThreadId: next.id } });
  });

  it("simulates a board: a cross-repo feature whose pushes resolve through respond", async () => {
    const api = createMockApi({ speed: 0, autoplay: false });
    const made = await api.simulateOrchestration("board");
    const ledger = await api.orchestratorLedger(made.workspaceId);
    expect(ledger.features.map((f) => [f.feature, f.state, f.workers.length])).toEqual([
      ["mail-trigger", "needsUser", 5],
      ["registry-paging", "briefed", 1],
      ["docs-refresh", "needsUser", 1],
    ]);
    // Two of them run as one staged group; the third is in none.
    expect(ledger.features.map((f) => f.group)).toEqual(["q4-platform", "q4-platform", undefined]);
    expect(ledger.groups).toMatchObject([
      {
        group: "q4-platform",
        features: ["mail-trigger", "registry-paging"],
        state: "needsUser",
        stage: { stage: "build features" },
      },
    ]);
    expect(ledger.features[0]?.stage).toMatchObject({ stage: "build", setBy: "orchestrator" });
    expect(ledger.features[1]?.stage?.plan).toBeUndefined();
    expect(states(ledger)).toEqual({
      [made.inReview]: "inReview",
      [made.working]: "working",
      [made.waiting[0]]: "needsUser",
      [made.waiting[1]]: "needsUser",
      [made.waitingApart]: "needsUser",
      [made.briefed]: "briefed",
      [made.ungrouped]: "needsUser",
    });
    expect(ledger.budget).toMatchObject({ liveWorkers: 7, maxConcurrentWorkers: 10 });
    expect(ledger.budget.costUsdToday).toBeCloseTo(13.05);
    const workers = ledger.features.flatMap((f) => f.workers);
    expect(workers.find((w) => w.threadId === made.working)).toMatchObject({
      userIntervened: true,
      overlapsWith: [made.inReview],
      project: "api",
    });
    expect(workers.find((w) => w.threadId === made.inReview)?.pr).toMatchObject({ number: 212 });
    // The worker in review spans the other two repos, with a PR in one of them.
    expect(
      workers
        .find((w) => w.threadId === made.inReview)
        ?.alsoIn?.map((r) => [r.project, r.pr?.number]),
    ).toEqual([
      ["web", 88],
      ["docs", undefined],
    ]);

    // The dev hook steps a plan along as `set_stage` would, and stops at its end or with no plan.
    expect(api.advanceOrchestrationStage(made.workspaceId, { group: "q4-platform" })).toMatchObject(
      { stage: "merge", setBy: "orchestrator" },
    );
    expect(
      api.advanceOrchestrationStage(made.workspaceId, { feature: "registry-paging" }),
    ).toBeUndefined();
    const [state] = await api.listWorkspaces();
    expect(state?.groups?.["q4-platform"]?.stage?.stage).toBe("merge");
    expect(workers.find((w) => w.threadId === made.waiting[0])).toMatchObject({
      project: "web",
      pendingRequests: [
        {
          kind: "approval",
          ageMin: 12,
          requestId: `r-push-${made.waiting[0]}`,
          summary: "git push -u origin feat/mail-trigger",
        },
      ],
    });
    // The worker in no group waits on a question, named as `thread.respond` names it.
    const [asked] = workers.find((w) => w.threadId === made.ungrouped)?.pendingRequests ?? [];
    expect(asked).toMatchObject({
      kind: "question",
      requestId: `r-question-${made.ungrouped}`,
      summary: "The setup guide covers both pip and uv. Keep both, or uv only?",
    });
    expect(Date.now() - (asked?.askedAt ?? 0)).toBeGreaterThanOrEqual(7 * 60_000);

    await api.respond(made.waiting[0], `r-push-${made.waiting[0]}` as RequestId, {
      kind: "approval",
      decision: "allow",
      scope: "once",
    });
    expect(states(await api.orchestratorLedger(made.workspaceId))[made.waiting[0]]).toBe("working");

    // Typing into a worker is what marks it, as the server's ledger does.
    await api.send(made.briefed, { text: "Use cursor paging." });
    const after = (await api.orchestratorLedger(made.workspaceId)).features.flatMap(
      (f) => f.workers,
    );
    expect(after.find((w) => w.threadId === made.briefed)?.userIntervened).toBe(true);
    // Handing it back clears the mark and nothing else.
    await api.releaseWorker(made.briefed);
    const released = (await api.orchestratorLedger(made.workspaceId)).features.flatMap(
      (f) => f.workers,
    );
    expect(released.find((w) => w.threadId === made.briefed)?.userIntervened).toBe(false);
    await expect(api.releaseWorker(made.workspaceId as unknown as ThreadId)).rejects.toThrow();
  });

  it("answers many requests in one call, each in its own row", async () => {
    const api = createMockApi({ speed: 0, autoplay: false });
    const made = await api.simulateOrchestration("board");
    const allow = { kind: "approval", decision: "allow", scope: "once" } as const;
    const results = await api.respondMany([
      {
        threadId: made.waiting[0],
        requestId: `r-push-${made.waiting[0]}` as RequestId,
        answer: allow,
      },
      { threadId: made.waiting[1], requestId: "r-gone" as RequestId, answer: allow },
      {
        threadId: made.waiting[1],
        requestId: `r-push-${made.waiting[1]}` as RequestId,
        answer: allow,
      },
    ]);
    expect(results.map((r) => r.ok)).toEqual([true, false, true]);
    expect(results[1]?.error).toContain("RequestNotFound");
    const after = states(await api.orchestratorLedger(made.workspaceId));
    expect([after[made.waiting[0]], after[made.waiting[1]]]).toEqual(["working", "working"]);
  });

  it("streams the ledger: now, then on a change, and not again while it reads the same", async () => {
    const api = createMockApi({ speed: 0, autoplay: false });
    const made = await api.simulateOrchestration("board");
    const abort = new AbortController();
    const seen: string[] = [];
    const done = (async () => {
      for await (const ledger of api.watchLedger(made.workspaceId, abort.signal)) {
        seen.push(ledger.features[0]?.stage?.stage ?? "");
      }
    })();
    await settle();
    expect(seen).toEqual(["build"]);

    const state = await api.setOrchestratorStage(made.workspaceId, {
      feature: "mail-trigger",
      stage: "merge in order",
    });
    expect(state.stages?.["mail-trigger"]).toMatchObject({
      stage: "merge in order",
      setBy: "user",
      plan: ["contract agreed", "build", "preview deployed", "merge in order", "rolled out"],
    });
    expect(state.stages?.["mail-trigger"]?.note).toBeUndefined();
    await settle();
    expect(seen).toEqual(["build", "merge in order"]);

    // An event that changes nothing the ledger holds sends nothing.
    await api.rename(made.orchestratorThreadId, "Renamed");
    await settle();
    expect(seen).toEqual(["build", "merge in order"]);
    abort.abort();
    await done;
  });

  it("holds a stage to its plan, and regroups features", async () => {
    const api = createMockApi({ speed: 0, autoplay: false });
    const made = await api.simulateOrchestration("board");
    const id = made.workspaceId;
    await expect(
      api.setOrchestratorStage(id, { feature: "mail-trigger", stage: "nowhere" }),
    ).rejects.toMatchObject({ _tag: "InvalidState" });
    await expect(
      api.setOrchestratorStage(id, { feature: "mail-trigger", group: "q4-platform", stage: "x" }),
    ).rejects.toMatchObject({ _tag: "InvalidState" });
    await expect(
      api.setOrchestratorStage(id, {
        group: "q4-platform",
        stage: "s0",
        plan: Array.from({ length: 9 }, (_, i) => `s${i}`),
      }),
    ).rejects.toMatchObject({ _tag: "InvalidState" });
    // An empty plan is how a plan is dropped for a free label.
    const free = await api.setOrchestratorStage(id, {
      feature: "mail-trigger",
      stage: "parked",
      plan: [],
      note: "until the API team is back",
    });
    expect(free.stages?.["mail-trigger"]).toMatchObject({ stage: "parked", setBy: "user" });
    expect(free.stages?.["mail-trigger"]?.plan).toBeUndefined();

    const moved = await api.setOrchestratorGroup(id, "docs-refresh", "Docs Push");
    expect(moved.groups?.["docs-push"]?.features).toEqual(["docs-refresh"]);
    const out = await api.setOrchestratorGroup(id, "docs-refresh");
    expect(out.groups?.["docs-push"]).toBeUndefined();
    // A group somebody staged keeps its row when its last feature leaves.
    await api.setOrchestratorGroup(id, "mail-trigger");
    const emptied = await api.setOrchestratorGroup(id, "registry-paging");
    expect(emptied.groups?.["q4-platform"]).toMatchObject({ features: [] });
  });

  it("hands off: the thread gets a new agent session, and a second handoff waits for the first", async () => {
    const api = createMockApi({ speed: 0, autoplay: false });
    const made = await api.simulateOrchestration("board");
    const abort = new AbortController();
    const sessions: (string | undefined)[] = [];
    void (async () => {
      for await (const event of api.events(abort.signal)) {
        if (event.type === "thread.upsert" && event.thread.id === made.orchestratorThreadId) {
          sessions.push(event.thread.agentSessionId);
        }
      }
    })();
    const thread = await api.orchestratorHandoff(made.workspaceId);
    expect(thread.id).toBe(made.orchestratorThreadId);
    await expect(api.orchestratorHandoff(made.workspaceId)).rejects.toMatchObject({
      _tag: "InvalidState",
    });
    await new Promise((resolve) => setTimeout(resolve, 700));
    abort.abort();
    expect(sessions.at(-1)).toMatch(/^mock-session-/);
    expect(sessions.at(-1)).not.toBe(thread.agentSessionId);
  });

  it("keeps a held handoff running until the spec releases it", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { gramMockHoldGates: true });
    const abort = new AbortController();
    try {
      const api = createMockApi({ speed: 0, autoplay: false });
      const made = await api.simulateOrchestration("board");
      let changed = false;
      const changedSession = (async () => {
        for await (const event of api.events(abort.signal)) {
          if (event.type === "thread.upsert" && event.thread.id === made.orchestratorThreadId) {
            changed = true;
            return event.thread.agentSessionId;
          }
        }
        return undefined;
      })();
      await api.orchestratorHandoff(made.workspaceId);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(changed).toBe(false);
      await expect(api.orchestratorHandoff(made.workspaceId)).rejects.toMatchObject({
        _tag: "InvalidState",
      });
      api.release("handoff");
      expect(await changedSession).toMatch(/^mock-session-/);
    } finally {
      abort.abort();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("seeds memory with open questions, two versions and dreams, and adopts through a conflict", async () => {
    const api = createMockApi({ speed: 0, autoplay: false });
    const made = await api.simulateOrchestration("board");
    const id = made.workspaceId;
    expect((await api.listMemory(id)).map((f) => f.path)).toEqual([
      "decisions.md",
      "goals.md",
      "map.md",
      "MEMORY.md",
      "questions.md",
      "repos/api.md",
    ]);
    expect((await api.readMemory(id, "questions.md")).content).toContain("## Q3 · open");
    // An answer closes its entry and reaches the orchestrator; a closed one isn't answered twice.
    const question = "The docs repo has no preview deploy.";
    await expect(
      api.answerQuestion({ workspaceId: id, questionId: "Q3", question, answer: "Yes" }),
    ).resolves.toMatchObject({ questionId: "Q3" });
    expect((await api.readMemory(id, "questions.md")).content).toContain("## Q3 · answered ");
    await expect(
      api.answerQuestion({ workspaceId: id, questionId: "Q3", question, answer: "No" }),
    ).rejects.toMatchObject({ _tag: "InvalidState" });
    expect((await api.listMemoryVersions(id)).map((v) => [v.version, v.current])).toEqual([
      ["0001", false],
      ["0002", true],
    ]);

    await expect(api.writeMemory(id, "notes.txt", "x")).rejects.toMatchObject({
      _tag: "InvalidState",
    });
    await expect(api.writeMemory(id, "MEMORY.md", "x".repeat(8 * 1024 + 1))).rejects.toMatchObject({
      _tag: "InvalidState",
    });
    expect(await api.writeMemory(id, "repos/web.md", "# web\n")).toMatchObject({
      action: "write",
      bytes: 6,
    });
    expect(await api.deleteMemory(id, "repos/web.md")).toMatchObject({ action: "delete" });

    const dreams = await api.listDreams(id);
    expect(dreams.map((d) => [d.kind, d.status])).toEqual([
      ["import", "running"],
      ["dream", "completed"],
      ["dream", "failed"],
    ]);
    const completed = dreams[1]!;
    await expect(api.startDream(id, { kind: "dream" })).rejects.toMatchObject({
      _tag: "InvalidState",
    });
    await expect(api.discardDream(dreams[0]!.id)).rejects.toMatchObject({ _tag: "InvalidState" });
    expect((await api.cancelDream(dreams[0]!.id)).status).toBe("canceled");

    const review = await api.reviewDream(completed.id);
    expect(review.files.map((f) => [f.path, f.status])).toEqual([
      ["conventions.md", "added"],
      ["decisions.md", "conflict"],
      ["goals.md", "unchanged"],
      ["map.md", "changed"],
      ["repos/docs-notes.md", "removed"],
    ]);
    expect(review.files[1]?.current).toContain("Queue consumers retry");
    const seen = { basedOn: review.memoryVersion, outputDigest: review.outputDigest };
    await expect(api.adoptDream(completed.id, seen)).rejects.toMatchObject({
      _tag: "InvalidState",
    });
    // A restore in between means the review no longer describes what would be adopted.
    await api.restoreMemory(id, "0001");
    await expect(
      api.adoptDream(completed.id, { ...seen, resolutions: { "decisions.md": "current" } }),
    ).rejects.toThrow(/Review the dream again/);
    await api.restoreMemory(id, "0002");
    const adopted = await api.adoptDream(completed.id, {
      ...seen,
      resolutions: { "decisions.md": "current" },
    });
    expect(adopted.adoptedVersion).toBe("0003");
    expect((await api.readMemory(id, "decisions.md")).content).toContain("Queue consumers retry");
    expect((await api.listMemory(id)).map((f) => f.path)).toContain("conventions.md");
    expect((await api.listMemoryVersions(id)).at(-1)).toMatchObject({
      version: "0003",
      current: true,
    });

    const preview = await api.previewDream(id, { perRepo: 10, includeMemory: true });
    expect(preview.sources.every((source) => source.sessions <= 10)).toBe(true);
    expect(preview).toMatchObject({ worktreesCovered: 4, worktreesTotal: 4, seedFiles: 7 });
    expect(preview.notes.length).toBeGreaterThan(0);

    // A discard closes the dream's thread, as the server has to: it ran in the folder that goes.
    const closedBefore = (await api.listClosedThreads()).map((closed) => closed.thread.id);
    expect(closedBefore).not.toContain(completed.threadId);
    await api.discardDream(completed.id);
    expect((await api.listClosedThreads()).map((closed) => closed.thread.id)).toContain(
      completed.threadId,
    );
  });
});

/** Longer than the mock's ledger debounce. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

const summary = (
  status: Parameters<typeof mockWorkerState>[0]["status"],
  parked = false,
): Parameters<typeof mockWorkerState>[0] => ({
  status,
  thread: { parked } as Parameters<typeof mockWorkerState>[0]["thread"],
});
const report = (state: "progress" | "blocked" | "question" | "done") => ({
  threadId: "t-w" as ThreadId,
  state,
  summary: "",
  at: 0,
});
const entry = (feature: string, state: "done" | "working" | "blocked", id: string) =>
  ({ feature, state, threadId: id }) as Parameters<typeof groupByFeature>[0][number];

describe("mock ledger rules", () => {
  it("derives a worker's state from its thread before its word", () => {
    expect(mockWorkerState(summary("idle"), undefined)).toBe("briefed");
    expect(mockWorkerState(summary("running"), undefined)).toBe("working");
    expect(mockWorkerState(summary("idle"), report("progress"))).toBe("working");
    expect(mockWorkerState(summary("idle"), report("blocked"))).toBe("blocked");
    expect(mockWorkerState(summary("needsApproval"), report("done"))).toBe("needsUser");
    expect(mockWorkerState(summary("error"), report("done"))).toBe("error");
    expect(mockWorkerState(summary("idle", true), report("done"))).toBe("archived");
    // Done where the checkout is known to have no GitHub remote is delivered, never merged.
    type Git = NonNullable<Parameters<typeof mockWorkerState>[0]["git"]>;
    const local = { ...summary("idle"), git: { repo: true } as Git };
    const hosted = { ...summary("idle"), git: { repo: true, origin: "example/api" } as Git };
    expect(mockWorkerState(local, report("done"))).toBe("delivered");
    expect(mockWorkerState(local, report("progress"))).toBe("working");
    expect(mockWorkerState(hosted, report("done"))).toBe("done");
    expect(mockWorkerState(summary("idle"), report("done"))).toBe("done");
  });

  it("groups by feature, each as far along as its slowest worker", () => {
    const groups = groupByFeature([
      entry("a", "done", "1"),
      entry("b", "done", "2"),
      entry("a", "blocked", "3"),
    ]);
    expect(groups.map((g) => [g.feature, g.state, g.workers.length])).toEqual([
      ["a", "blocked", 2],
      ["b", "done", 1],
    ]);
  });
});
