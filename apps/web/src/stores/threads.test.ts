import type {
  ProjectId,
  QueueItemId,
  RequestId,
  TerminalId,
  ThreadId,
  ThreadSummary,
  TurnId,
  WaitId,
} from "@gram/contracts";
import { describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";

import { activityLine, rowStatus } from "@/sidebar/status";
import { finishedWorker } from "@/worktrees/finished-worker";

import { useLapsedDismissals } from "./lapsed-connectors";
import { useSuggestionsStore } from "./suggestions";
import { createThreadsSlice, queueOps, rateLimitTitle, type ThreadsState } from "./threads";

const T = "t1" as ThreadId;
const q = (id: string) => id as QueueItemId;

const base: ThreadSummary = {
  status: "idle",
  pendingRequests: [],
  queue: [
    { id: q("q1"), input: { text: "one" } },
    { id: q("q2"), input: { text: "two" } },
    { id: q("q3"), input: { text: "three" } },
  ],
  thread: {
    id: T,
    projectId: "p" as ProjectId,
    title: "t",
    userNamed: false,
    model: { agent: "claude", model: "opus" },
    mode: "default",
    checkout: { kind: "main", path: "/" },
    labels: [],
    pinned: false,
    parked: false,
    unread: false,
    createdAt: 0,
    lastActivityAt: 0,
  },
};

const makeStore = () => {
  const store = createStore<ThreadsState>()((set) => createThreadsSlice(set));
  store.getState().applyEvent({ type: "threads.snapshot", threads: [base] });
  return store;
};

const texts = (store: ReturnType<typeof makeStore>) =>
  store.getState().byId[T]!.queue.map((item) => item.input.text);

describe("threads store events", () => {
  it("drops an upsert older than the thread it holds", () => {
    const store = makeStore();
    const { applyEvent } = store.getState();
    const upsert = (title: string, revision?: number) =>
      applyEvent({
        type: "thread.upsert",
        thread: { ...base.thread, title, ...(revision === undefined ? {} : { revision }) },
      });
    upsert("second", 2);
    expect(store.getState().byId[T]!.thread.title).toBe("second");
    // Writers committed 1 then 2 and published 2 then 1.
    upsert("first", 1);
    expect(store.getState().byId[T]!.thread.title).toBe("second");
    upsert("again", 2);
    expect(store.getState().byId[T]!.thread.title).toBe("again");
    // A thread no write stamped has nothing to compare.
    upsert("unstamped");
    expect(store.getState().byId[T]!.thread.title).toBe("unstamped");
  });

  it("uses fresh snapshot activity after missing status events during a disconnect", () => {
    const store = makeStore();
    const { applyEvent } = store.getState();
    const activity = () => {
      const state = store.getState();
      const summary = state.byId[T]!;
      return activityLine(summary.status, state.statusDetail[T], summary.activity);
    };
    applyEvent({ type: "thread.status", threadId: T, status: "running", detail: "Reading a.ts" });
    expect(activity()).toBe("Reading a.ts");

    // The connection missed the next status. The reconnect snapshot carries the current line.
    applyEvent({
      type: "threads.snapshot",
      threads: [{ ...base, status: "running", activity: "Running tests" }],
    });
    expect(activity()).toBe("Running tests");

    // Events received after the snapshot still override it, including an explicit empty line.
    applyEvent({
      type: "thread.status",
      threadId: T,
      status: "running",
      detail: "Checking output",
    });
    expect(activity()).toBe("Checking output");
    applyEvent({ type: "thread.status", threadId: T, status: "idle" });
    expect(activity()).toBeUndefined();
  });

  it("stops showing missed background work after a quiet reconnect snapshot", () => {
    const store = makeStore();
    const { applyEvent } = store.getState();
    applyEvent({ type: "thread.status", threadId: T, status: "idle", detail: "Subagent: testing" });
    const display = () => {
      const state = store.getState();
      const summary = state.byId[T]!;
      return rowStatus(
        summary.thread,
        summary.status,
        activityLine(summary.status, state.statusDetail[T], summary.activity),
      );
    };
    expect(display().working).toBe(true);
    applyEvent({ type: "threads.snapshot", threads: [base] });
    expect(display()).toMatchObject({ working: false, label: "Idle" });
  });

  it("does not hide a snapshot's new subagent behind the previous empty status line", () => {
    const store = makeStore();
    const { applyEvent } = store.getState();
    applyEvent({ type: "thread.status", threadId: T, status: "idle" });
    const worker = {
      ...base,
      thread: {
        ...base.thread,
        parked: true,
        spawnedBy: { threadId: "root" as ThreadId, feature: "offline fixture" },
      },
      activity: "Subagent: checking output",
    };
    applyEvent({ type: "threads.snapshot", threads: [worker] });
    const state = store.getState();
    expect(
      activityLine(state.byId[T]!.status, state.statusDetail[T], state.byId[T]!.activity),
    ).toBe(worker.activity);
    expect(finishedWorker(state.byId[T], state.statusDetail[T])).toBeUndefined();

    // Once a subsequent event says the subagent stopped, the existing refusal can end.
    applyEvent({ type: "thread.status", threadId: T, status: "idle" });
    expect(finishedWorker(store.getState().byId[T], store.getState().statusDetail[T])).toBe(
      "archived",
    );
    applyEvent({ type: "threads.snapshot", threads: [] });
    expect(store.getState().statusDetail).toEqual({});
  });

  it("tracks status, requests, queue and identity updates", () => {
    const store = makeStore();
    const { applyEvent } = store.getState();
    applyEvent({ type: "thread.status", threadId: T, status: "running", detail: "Running tests…" });
    applyEvent({
      type: "thread.request",
      threadId: T,
      request: { kind: "plan", id: "r1" as RequestId, plan: "do it" },
    });
    applyEvent({ type: "thread.queue", threadId: T, queue: [] });
    applyEvent({
      type: "thread.identity",
      threadId: T,
      identity: { model: "sonnet", commands: [{ name: "review", description: "Review" }] },
    });

    const s = store.getState();
    expect(s.byId[T]!.status).toBe("running");
    expect(s.statusDetail[T]).toBe("Running tests…");
    expect(s.byId[T]!.pendingRequests.map((r) => r.id)).toEqual(["r1"]);
    expect(s.byId[T]!.queue).toEqual([]);
    expect(s.byId[T]!.identity?.model).toBe("sonnet");

    applyEvent({ type: "thread.requestResolved", threadId: T, requestId: "r1" as RequestId });
    expect(store.getState().byId[T]!.pendingRequests).toEqual([]);
  });

  it("leaves the thread map alone when a status event only moves the activity line", () => {
    const store = makeStore();
    const { applyEvent } = store.getState();
    applyEvent({ type: "thread.status", threadId: T, status: "running", detail: "Reading a.ts" });
    const { byId } = store.getState();
    applyEvent({ type: "thread.status", threadId: T, status: "running", detail: "Reading b.ts" });
    expect(store.getState().byId).toBe(byId);
    expect(store.getState().statusDetail[T]).toBe("Reading b.ts");
    const settled = store.getState().statusDetail;
    applyEvent({ type: "thread.status", threadId: T, status: "running", detail: "Reading b.ts" });
    expect(store.getState().statusDetail).toBe(settled);
    applyEvent({ type: "thread.status", threadId: T, status: "idle" });
    expect(store.getState().byId[T]!.status).toBe("idle");
    expect(store.getState().statusDetail[T]).toBe("");
  });

  it("keeps a compaction while statuses carry it and drops it with the first that doesn't", () => {
    const store = makeStore();
    const { applyEvent } = store.getState();
    const compaction = { startedAt: 5, preTokens: 182_000 };
    const compacting = (c: typeof compaction & { trigger?: "auto" }) =>
      applyEvent({
        type: "thread.status",
        threadId: T,
        status: "running",
        detail: "Compacting context",
        compaction: c,
      });
    compacting(compaction);
    expect(store.getState().byId[T]!.compaction).toEqual(compaction);
    const { byId } = store.getState();
    compacting({ ...compaction });
    expect(store.getState().byId).toBe(byId);
    compacting({ ...compaction, trigger: "auto" });
    expect(store.getState().byId[T]!.compaction?.trigger).toBe("auto");
    applyEvent({ type: "thread.status", threadId: T, status: "running" });
    expect(store.getState().byId[T]!.status).toBe("running");
    expect(store.getState().byId[T]).not.toHaveProperty("compaction");
  });

  it("toasts a completed review round", () => {
    const store = makeStore();
    const counts = { unresolved: 3, blockers: 1, suggestions: 2, outdatedUnresolved: 0 };
    store.getState().applyEvent({
      type: "pr.reviewRound",
      threadId: T,
      round: { number: 3, reviewId: "PRR_3", verdict: "changesRequested", counts },
    });
    store.getState().applyEvent({
      type: "pr.reviewRound",
      threadId: T,
      round: {
        number: 4,
        reviewId: "PRR_4",
        verdict: "changesRequested",
        verdictOnHead: "changesRequested",
        counts,
      },
    });
    store.getState().applyEvent({
      type: "pr.reviewRound",
      threadId: T,
      round: {
        number: 5,
        reviewId: "PRR_5",
        verdict: "approved",
        verdictOnHead: "approved",
        counts: { ...counts, unresolved: 0, blockers: 0, suggestions: 0 },
      },
    });
    expect(store.getState().notifications).toMatchObject([
      {
        kind: "info",
        title: "Review round 3: changes requested",
        body: "1 blocker, 3 unresolved",
        threadId: T,
      },
      { kind: "needsInput", title: "Review round 4: changes requested" },
      { kind: "done", title: "Review round 5: approved", body: "No unresolved findings" },
    ]);
  });

  it("toasts a rate limit with its reset on the limits' clock and its window by its one name", () => {
    const store = makeStore();
    store.getState().applyEvent({
      type: "rateLimit",
      threadId: T,
      status: "warning",
      window: "overage",
      utilization: 0.94,
    });
    expect(store.getState().notifications).toMatchObject([
      { kind: "info", title: "Approaching rate limit: 94% of overage", threadId: T },
    ]);

    const now = Date.UTC(2026, 8, 29, 9);
    const intl = { locale: "en-GB", timeZone: "UTC" };
    const nextMonth = Date.UTC(2026, 9, 1);
    expect(
      rateLimitTitle(
        { status: "warning", window: "overage", utilization: 0.94, resetsAt: nextMonth },
        now,
        intl,
      ),
    ).toBe("Approaching rate limit: 94% of overage, resets Thu 00:00");
    const later = Date.UTC(2026, 8, 29, 14);
    expect(
      rateLimitTitle(
        { status: "warning", window: "five_hour", utilization: 0.8, resetsAt: later },
        now,
        intl,
      ),
    ).toBe("Approaching rate limit: 80% of 5-hour, resets 14:00");
    expect(
      rateLimitTitle(
        {
          status: "warning",
          window: "five_hour",
          utilization: 0.8,
          resetsAt: Date.UTC(2026, 8, 30, 8),
        },
        Date.UTC(2026, 8, 29, 23),
        intl,
      ),
    ).toBe("Approaching rate limit: 80% of 5-hour, resets Wed 08:00");
    expect(
      rateLimitTitle(
        { status: "rejected", window: "seven_day_opus", resetsAt: nextMonth },
        now,
        intl,
      ),
    ).toBe("Rate limited (weekly opus, resets Thu 00:00)");
    expect(
      rateLimitTitle({ status: "rejected", window: "five_hour", resetsAt: now - 1 }, now, intl),
    ).toBe("Rate limited (5-hour)");
  });

  it("caps a rate limit's share short of 100% as the meter does, and gives a far reset its date", () => {
    const now = Date.UTC(2026, 8, 29, 9);
    const intl = { locale: "en-GB", timeZone: "UTC" };
    expect(
      rateLimitTitle(
        { status: "warning", window: "seven_day", utilization: 0.996, resetsAt: now + 3_600_000 },
        now,
        intl,
      ),
    ).toBe("Approaching rate limit: 99% of weekly, resets 10:00");
    expect(
      rateLimitTitle(
        {
          status: "warning",
          window: "seven_day",
          utilization: 1,
          resetsAt: Date.UTC(2026, 9, 9, 7),
        },
        now,
        intl,
      ),
    ).toBe("Approaching rate limit: 100% of weekly, resets 9 Oct, 07:00");
  });

  it.each([
    [Date.UTC(2026, 8, 29, 9), Date.UTC(2026, 8, 29, 14), "14:00"],
    [Date.UTC(2026, 8, 29, 23), Date.UTC(2026, 8, 30, 0, 5), "Wed 00:05"],
  ])("uses a 24-hour rate-limit reset clock in en-US", (now, resetsAt, reset) => {
    expect(
      rateLimitTitle({ status: "rejected", window: "five_hour", resetsAt }, now, {
        locale: "en-US",
        timeZone: "UTC",
      }),
    ).toBe(`Rate limited (5-hour, resets ${reset})`);
  });

  it("tracks usage and the agent's plan, and forgets both on removal", () => {
    const store = makeStore();
    const { applyEvent } = store.getState();
    const byId = store.getState().byId;
    applyEvent({
      type: "thread.usage",
      threadId: T,
      usage: {
        tokens: { inputTokens: 5000, outputTokens: 800 },
        contextWindow: 200_000,
        costUsd: 0.42,
      },
    });
    applyEvent({
      type: "thread.plan",
      threadId: T,
      items: [{ content: "Fix the retry", status: "inProgress", activeForm: "Fixing the retry" }],
    });
    expect(store.getState().usage[T]?.costUsd).toBe(0.42);
    // Nothing that reads the thread map renders for a report.
    expect(store.getState().byId).toBe(byId);
    expect(store.getState().plans[T]).toHaveLength(1);

    applyEvent({ type: "thread.status", threadId: T, status: "running", detail: "Reading" });
    applyEvent({ type: "thread.removed", threadId: T });
    expect(store.getState().plans).toEqual({});
    expect(store.getState().usage).toEqual({});
    expect(store.getState().statusDetail).toEqual({});

    // A plan that lands after the thread went doesn't come back with it if it is reopened.
    applyEvent({
      type: "thread.plan",
      threadId: T,
      items: [{ content: "Late", status: "pending" }],
    });
    expect(store.getState().plans).toEqual({});
  });

  it("keeps the thread's plan in the thread map, and its todo list beside it", () => {
    const store = makeStore();
    const turnPlan = [{ content: "Push", status: "pending" as const }];
    store.getState().applyEvent({ type: "threads.snapshot", threads: [{ ...base, turnPlan }] });
    expect(store.getState().plans[T]).toEqual(turnPlan);
    expect(store.getState().byId[T]).toEqual(base);

    const plan = {
      goal: "Ship it",
      steps: [],
      basis: "",
      updatedAt: 1,
      updatedBy: "agent" as const,
    };
    store.getState().applyEvent({ type: "thread.plan", threadId: T, items: turnPlan, plan });
    const byId = store.getState().byId;
    expect(byId[T]?.plan).toEqual(plan);
    // The same plan again, with only the todo list moving, leaves the thread map alone.
    store.getState().applyEvent({ type: "thread.plan", threadId: T, items: [], plan: { ...plan } });
    expect(store.getState().byId).toBe(byId);
    store.getState().applyEvent({ type: "thread.plan", threadId: T, items: [] });
    expect(store.getState().byId[T]).toEqual(base);
  });

  it("keeps the thread's open Waiting on you items, and drops the field once none is left", () => {
    const store = makeStore();
    const wait = {
      id: "w-1" as WaitId,
      kind: "draft" as const,
      title: "Teams message",
      source: "agent" as const,
      createdAt: 1,
    };
    store.getState().applyEvent({ type: "thread.waits", threadId: T, waits: [wait] });
    expect(store.getState().byId[T]?.waits).toEqual([wait]);
    store.getState().applyEvent({ type: "thread.waits", threadId: T, waits: [] });
    expect(store.getState().byId[T]).toEqual(base);
    const resolved = { ...wait, resolvedAt: 2, resolvedBy: "helper" as const };
    store
      .getState()
      .applyEvent({ type: "thread.waits", threadId: T, waits: [], helperResolved: [resolved] });
    expect(store.getState().byId[T]?.helperResolved).toEqual([resolved]);
    store.getState().applyEvent({ type: "thread.waits", threadId: T, waits: [] });
    expect(store.getState().byId[T]).toEqual(base);
  });

  it("hands suggested replies to the composer, and drops them once a turn starts", () => {
    const store = makeStore();
    const { applyEvent } = store.getState();
    const byId = store.getState().byId;
    const turnId = "turn-1" as TurnId;
    applyEvent({ type: "thread.suggestions", threadId: T, turnId, replies: ["Push it"] });
    expect(useSuggestionsStore.getState().byThread[T]).toMatchObject({
      turnId,
      replies: ["Push it"],
    });
    expect(store.getState().byId).toBe(byId);
    // The same turn's again keeps where the user had cycled to.
    useSuggestionsStore.getState().choose(T, "Push it");
    applyEvent({ type: "thread.suggestions", threadId: T, turnId, replies: ["Push it"] });
    expect(useSuggestionsStore.getState().byThread[T]?.chosen).toBe("Push it");
    // Made again for an edited plan: the new replies replace the old, still put away if they were.
    useSuggestionsStore.getState().dismiss(T);
    applyEvent({ type: "thread.suggestions", threadId: T, turnId, replies: ["Wait for review"] });
    expect(useSuggestionsStore.getState().byThread[T]).toMatchObject({
      replies: ["Wait for review"],
      chosen: undefined,
      dismissed: true,
    });
    // Taken back: stale until the composer asks again, whatever the answer then, an empty one too.
    applyEvent({ type: "thread.suggestions", threadId: T, turnId, replies: [], stale: true });
    expect(useSuggestionsStore.getState().byThread[T]).toMatchObject({
      replies: [],
      stale: true,
      dismissed: true,
      takenBack: 1,
    });
    applyEvent({ type: "thread.suggestions", threadId: T, turnId, replies: [] });
    expect(useSuggestionsStore.getState().byThread[T]).toMatchObject({
      stale: false,
      takenBack: 1,
    });
    applyEvent({ type: "thread.suggestions", threadId: T, turnId, replies: [], stale: true });
    expect(useSuggestionsStore.getState().byThread[T]?.takenBack).toBe(2);
    // Another turn's taking back takes nothing.
    applyEvent({
      type: "thread.suggestions",
      threadId: T,
      turnId: "turn-0" as TurnId,
      replies: [],
      stale: true,
    });
    expect(useSuggestionsStore.getState().byThread[T]?.turnId).toBe(turnId);
    applyEvent({ type: "thread.status", threadId: T, status: "running" });
    expect(useSuggestionsStore.getState().byThread[T]).toBeUndefined();
    // A snapshot after a dropped connection may have skipped a whole turn.
    applyEvent({ type: "thread.suggestions", threadId: T, turnId, replies: ["Push it"] });
    applyEvent({ type: "threads.snapshot", threads: [base] });
    expect(useSuggestionsStore.getState().byThread).toEqual({});
  });

  it("takes a snapshot's usage out of the thread map", () => {
    const store = makeStore();
    const usage = { tokens: { inputTokens: 1, outputTokens: 2 }, costUsd: 0.1 };
    store.getState().applyEvent({ type: "threads.snapshot", threads: [{ ...base, usage }] });
    expect(store.getState().usage[T]).toEqual(usage);
    expect(store.getState().byId[T]).toEqual(base);
  });

  it("keeps the agent's background tasks and the terminals' processes on the summary", () => {
    const store = makeStore();
    const { applyEvent } = store.getState();
    const task = {
      taskId: "b1",
      kind: "shell" as const,
      description: "Run the checks",
      command: "pnpm check",
      startedAt: 1,
    };
    applyEvent({ type: "thread.background", threadId: T, tasks: [task] });
    applyEvent({
      type: "thread.terminalProcesses",
      threadId: T,
      processes: [
        { terminalId: "term1" as TerminalId, pid: 4120, command: "pnpm dev", startedAt: 2 },
      ],
    });
    expect(store.getState().byId[T]!.background).toEqual([task]);
    expect(store.getState().byId[T]!.terminalProcesses?.map((p) => p.command)).toEqual([
      "pnpm dev",
    ]);

    applyEvent({ type: "thread.background", threadId: T, tasks: [] });
    expect(store.getState().byId[T]!.background).toEqual([]);

    // A background shell's output: each task's latest, kept past its end, the newest few only.
    const output = (taskId: string, text: string) =>
      applyEvent({
        type: "thread.backgroundOutput",
        threadId: T,
        taskId,
        toolCallId: `call-${taskId}`,
        output: text,
      });
    output("b1", "one");
    output("b1", "one\ntwo");
    expect(store.getState().byId[T]!.backgroundOutput).toEqual([
      { taskId: "b1", toolCallId: "call-b1", output: "one\ntwo" },
    ]);
    for (let i = 2; i <= 9; i++) output(`b${i}`, `task ${i}`);
    expect(store.getState().byId[T]!.backgroundOutput?.map((each) => each.taskId)).toEqual([
      "b2",
      "b3",
      "b4",
      "b5",
      "b6",
      "b7",
      "b8",
      "b9",
    ]);

    applyEvent({ type: "thread.pendingRestart", threadId: T, reason: "mcpConfig" });
    expect(store.getState().byId[T]!.pendingRestart).toBe("mcpConfig");
    applyEvent({ type: "thread.pendingRestart", threadId: T });
    expect(store.getState().byId[T]).not.toHaveProperty("pendingRestart");
  });

  it("keeps the lapsed connectors, and forgets a dismissal once its connector is back", () => {
    const store = makeStore();
    const { applyEvent } = store.getState();
    const lapsed = (names: ReadonlyArray<string>) =>
      applyEvent({ type: "thread.lapsedConnectors", threadId: T, names });
    lapsed(["claude.ai Atlassian", "claude.ai Snowflake"]);
    useLapsedDismissals.getState().dismiss(T, "claude.ai Atlassian");
    useLapsedDismissals.getState().dismiss(T, "claude.ai Snowflake");
    lapsed(["claude.ai Snowflake"]);
    expect(store.getState().byId[T]!.lapsedConnectors).toEqual(["claude.ai Snowflake"]);
    expect(useLapsedDismissals.getState().byThread[T]).toEqual(["claude.ai Snowflake"]);
    lapsed([]);
    expect(store.getState().byId[T]).not.toHaveProperty("lapsedConnectors");
    expect(useLapsedDismissals.getState().byThread[T]).toEqual([]);

    // Back while the app was disconnected: the snapshot stands in for the event it missed.
    lapsed(["claude.ai Atlassian"]);
    useLapsedDismissals.getState().dismiss(T, "claude.ai Atlassian");
    applyEvent({ type: "threads.snapshot", threads: [base] });
    expect(useLapsedDismissals.getState().byThread[T]).toBeUndefined();

    // Closed while disconnected, then reopened under the same id: its old dismissal is gone.
    lapsed(["claude.ai Atlassian"]);
    useLapsedDismissals.getState().dismiss(T, "claude.ai Atlassian");
    applyEvent({ type: "threads.snapshot", threads: [] });
    applyEvent({ type: "threads.snapshot", threads: [base] });
    lapsed(["claude.ai Atlassian"]);
    expect(useLapsedDismissals.getState().byThread[T]).toBeUndefined();
    expect(store.getState().byId[T]!.lapsedConnectors).toEqual(["claude.ai Atlassian"]);
  });

  it("ignores events for unknown threads and removes threads", () => {
    const store = makeStore();
    store
      .getState()
      .applyEvent({ type: "thread.status", threadId: "nope" as ThreadId, status: "running" });
    expect(Object.keys(store.getState().byId)).toEqual([T]);
    store.getState().applyEvent({ type: "thread.removed", threadId: T });
    expect(store.getState().byId).toEqual({});
  });
});

const api = () => ({
  queueEdit: vi.fn(async () => {}),
  queueReorder: vi.fn(async () => {}),
  queueRemove: vi.fn(async () => {}),
  queueSteer: vi.fn(async () => {}),
});

describe("queueOps", () => {
  it("removes, edits and moves optimistically", async () => {
    const store = makeStore();
    const client = api();
    await queueOps.remove(client, store.getState, T, q("q2"));
    expect(texts(store)).toEqual(["one", "three"]);
    expect(client.queueRemove).toHaveBeenCalledWith(T, "q2");

    await queueOps.edit(client, store.getState, T, q("q1"), { text: "uno" });
    expect(texts(store)).toEqual(["uno", "three"]);

    await queueOps.move(client, store.getState, T, q("q3"), -1);
    expect(texts(store)).toEqual(["three", "uno"]);
    expect(client.queueReorder).toHaveBeenCalledWith(T, ["q3", "q1"]);
  });

  it("does nothing when a move is clamped at the edge", async () => {
    const store = makeStore();
    const client = api();
    await queueOps.move(client, store.getState, T, q("q1"), -1);
    expect(client.queueReorder).not.toHaveBeenCalled();
  });

  it("rolls back when the server rejects", async () => {
    const store = makeStore();
    const client = api();
    client.queueRemove.mockRejectedValueOnce(new Error("InvalidState"));
    await expect(queueOps.remove(client, store.getState, T, q("q1"))).rejects.toThrow(
      "InvalidState",
    );
    expect(texts(store)).toEqual(["one", "two", "three"]);
  });

  it("keeps a queue the server sent while a rejected change was out, rather than the old one", async () => {
    const store = makeStore();
    const client = api();
    let reject!: (error: Error) => void;
    client.queueRemove.mockImplementationOnce(
      () => new Promise<void>((_, fail) => (reject = fail)),
    );
    const removing = queueOps.remove(client, store.getState, T, q("q3"));
    expect(texts(store)).toEqual(["one", "two"]);
    // Meanwhile a turn starts with the first item: the server's queue no longer has it.
    const queue = base.queue.filter((item) => item.id !== q("q1"));
    store.getState().applyEvent({ type: "thread.queue", threadId: T, queue });
    reject(new Error("InvalidState"));
    await expect(removing).rejects.toThrow("InvalidState");
    expect(texts(store)).toEqual(["two", "three"]);
  });

  it("drops a steered item, and puts it back when the steer is rejected", async () => {
    const store = makeStore();
    const client = api();
    await queueOps.steer(client, store.getState, T, q("q2"));
    expect(texts(store)).toEqual(["one", "three"]);
    expect(client.queueSteer).toHaveBeenCalledWith(T, "q2");

    client.queueSteer.mockRejectedValueOnce(new Error("InvalidState"));
    await expect(queueOps.steer(client, store.getState, T, q("q1"))).rejects.toThrow(
      "InvalidState",
    );
    expect(texts(store)).toEqual(["one", "three"]);
  });
});
