import type {
  FinishedWorker,
  ProjectId,
  Thread,
  ThreadId,
  ThreadSummary,
  WorkerLedgerEntry,
  WorkerState,
  WorkspaceId,
} from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { doneDay, DONE_DAYS, daysBefore, type workersByTab } from "@/orchestration/workers-model";

import {
  filterCounts,
  historyEntries,
  historyWhen,
  IMPORTED_OWNER,
  searchHistory,
  sessionRoots,
  type HistorySession,
  type HistorySources,
} from "./history-model";

// Wednesday 15 October 2026, 14:40 local time.
const NOW = new Date(2026, 9, 15, 14, 40).getTime();
const at = (hour: number, minute = 0) => new Date(2026, 9, 15, hour, minute).getTime();
const DAY = 24 * 60 * 60_000;

const worker = (
  id: string,
  state: WorkerState,
  extra: Partial<WorkerLedgerEntry> = {},
): WorkerLedgerEntry => ({
  feature: "retry",
  projectId: "p-api" as ProjectId,
  project: "api",
  threadId: id as ThreadId,
  title: `Title of ${id}`,
  state,
  status: "idle",
  pendingRequests: [],
  changedFiles: 0,
  overlapsWith: [],
  userIntervened: false,
  messagesFromOrchestrator: 0,
  ...extra,
});

const summary = (
  id: string,
  thread: Partial<Thread>,
  rest: Partial<ThreadSummary> = {},
): ThreadSummary =>
  ({
    thread: {
      id: id as ThreadId,
      title: `Title of ${id}`,
      lastActivityAt: NOW,
      projectId: "p-api",
      checkout: { kind: "current", path: "/code/api" },
      model: { agent: "claude", model: "default" },
      parked: false,
      pinned: false,
      ...thread,
    },
    status: "idle",
    pendingRequests: [],
    queue: [],
    ...rest,
  }) as unknown as ThreadSummary;

const closed = (id: string, closedAt: number, merged: boolean): FinishedWorker => ({
  threadId: id as ThreadId,
  workspaceId: "w2" as WorkspaceId,
  title: `Closed ${id}`,
  feature: "certs",
  closedAt,
  ...(merged ? { completedReason: "prMerged" as const } : {}),
  prs: merged
    ? [{ repo: "example/infra", number: 88, url: "https://x/88", merged: true as const }]
    : [],
  kept: "closed",
  agent: "codex",
});

const ledger = {
  features: [
    {
      feature: "retry",
      workers: [
        worker("t-merged", "merged", { pr: { repo: "example/api", number: 412 } }),
        worker("t-done", "delivered"),
        worker("t-live", "working", { status: "running" }),
        worker("t-old", "merged"),
        // Archived by the orchestrator once its PR merged: it still reads merged.
        worker("t-merged-archived", "archived", {
          stateBase: { state: "merged", parked: true },
          pr: { repo: "example/api", number: 400 },
        }),
        // Archived with nothing merged: that is all it came to.
        worker("t-parked", "archived", { stateBase: { state: "briefed", parked: true } }),
        worker("t-week", "delivered"),
      ],
    },
  ],
} as unknown as Parameters<typeof workersByTab>[0];

const workerSummaries = [
  summary("t-merged", {
    completedAt: at(13, 5),
    spawnedBy: { threadId: "o", feature: "retry" },
  } as never),
  summary("t-done", { completedAt: at(9, 30) }),
  summary("t-live", {}, { status: "running" }),
  summary("t-old", { completedAt: at(9) - DAY, model: { agent: "codex", model: "default" } }),
  summary("t-merged-archived", { completedAt: at(16) - 3 * DAY, parked: true }),
  summary("t-parked", { parked: true, lastActivityAt: at(7) - 2 * DAY }),
  summary("t-week", { completedAt: daysBefore(NOW, DONE_DAYS - 1) }),
];

const sources = (extra: Partial<HistorySources> = {}): HistorySources => {
  const summaries = [...workerSummaries, ...(extra.summaries ?? [])];
  return {
    workspaces: [
      { workspaceId: "w1" as WorkspaceId, name: "agent-platform", ledger, finished: [] },
      {
        workspaceId: "w2" as WorkspaceId,
        name: "infra",
        ledger: undefined,
        finished: [closed("t-closed", at(11, 45), true), closed("t-swept", at(8), false)],
      },
    ],
    projects: [
      { id: "p-api" as ProjectId, name: "api", root: "/code/api" },
      { id: "p-web" as ProjectId, name: "web", root: "/code/web" },
    ],
    sessions: [],
    ...extra,
    summaries,
    facts: {
      byId: Object.fromEntries(summaries.map((s) => [s.thread.id, s])),
      statusDetail: {},
      now: NOW,
    },
  };
};

const session = (id: string, updatedAt: number, extra: Partial<HistorySession> = {}) =>
  ({
    agentSessionId: id,
    title: `Session ${id}`,
    updatedAt,
    agent: "claude",
    projectRoot: "/code/web",
    ...extra,
  }) as HistorySession;

describe("History's rows", () => {
  it("has every finished worker Done had, latest first, and leaves live ones out", () => {
    const rows = historyEntries(sources());
    expect(rows.map((row) => row.threadId)).toEqual([
      "t-merged",
      "t-closed",
      "t-done",
      "t-swept",
      "t-old",
      "t-parked",
      "t-merged-archived",
      "t-week",
    ]);
    expect(rows.every((row) => row.kind === "worker")).toBe(true);
  });

  it("says each worker's place, repo, outcome, agent and whether it is archived", () => {
    const rows = historyEntries(sources());
    expect(
      rows.map((row) => [row.threadId, row.place, row.repo, row.outcome, row.agent, row.archived]),
    ).toEqual([
      ["t-merged", "agent-platform", "api", "merged", "claude", false],
      ["t-closed", "infra", "infra", "merged", "codex", false],
      ["t-done", "agent-platform", "api", "delivered", "claude", false],
      // Closed with its worktree, with nothing delivered.
      ["t-swept", "infra", "", "stopped", "codex", false],
      ["t-old", "agent-platform", "api", "merged", "codex", false],
      ["t-parked", "agent-platform", "api", "archived", "claude", true],
      ["t-merged-archived", "agent-platform", "api", "merged", "claude", false],
      ["t-week", "agent-platform", "api", "delivered", "claude", false],
    ]);
    expect(rows.find((row) => row.threadId === "t-closed")?.cleanedUp).toBe(true);
  });

  it("adds the threads over and done with: done, archived, failed, orchestrators too, never dreams", () => {
    const rows = historyEntries(
      sources({
        summaries: [
          summary("s-noon", { completedAt: at(12), completedReason: "user" }),
          summary("s-merged", { completedAt: at(10) - 2 * DAY, completedReason: "prMerged" }),
          summary("s-parked", {
            parked: true,
            parkedAt: at(10, 30),
            projectId: "p-web" as ProjectId,
          }),
          summary("s-failed", { parked: true, lastError: { message: "boom" } } as never),
          summary("s-open", {}),
          summary("s-pinned-done", { completedAt: at(12), pinned: true }),
          summary("o-old", {
            role: "orchestrator",
            workspaceId: "w1" as WorkspaceId,
            parked: true,
            parkedAt: at(6),
          }),
          summary("d-dream", { role: "dream", parked: true }),
        ],
      }),
    );
    const byId = new Map(rows.map((row) => [row.threadId, row]));
    expect(byId.get("s-noon")).toMatchObject({
      kind: "thread",
      place: "Solo threads",
      repo: "api",
      outcome: "delivered",
      archived: false,
      finishedAt: at(12),
    });
    expect(byId.get("s-merged")).toMatchObject({ outcome: "merged" });
    expect(byId.get("s-parked")).toMatchObject({
      outcome: "archived",
      archived: true,
      repo: "web",
      finishedAt: at(10, 30),
    });
    // Archived after an error: it says how it ended, and is under Archived all the same.
    expect(byId.get("s-failed")).toMatchObject({ outcome: "failed", archived: true });
    expect(byId.get("o-old")).toMatchObject({
      kind: "orchestrator",
      place: "agent-platform",
      owner: { key: "w1", label: "agent-platform" },
    });
    expect(byId.has("s-open")).toBe(false);
    // Pinned keeps it in the sidebar, where its flag puts it.
    expect(byId.has("s-pinned-done")).toBe(false);
    expect(byId.has("d-dream")).toBe(false);
    // A ledger's worker is listed once, from its ledger row.
    expect(rows.filter((row) => row.threadId === "t-parked")).toHaveLength(1);
    expect(byId.has("t-live")).toBe(false);
  });

  it("leaves out a thread whose error still needs you, until it is archived", () => {
    const failing = summary("s-err", {}, { status: "error" });
    expect(historyEntries(sources({ summaries: [failing] })).map((r) => r.threadId)).not.toContain(
      "s-err",
    );
    const archived = summary("s-err", { parked: true, parkedAt: at(9) }, { status: "error" });
    expect(
      historyEntries(sources({ summaries: [archived] })).find((r) => r.threadId === "s-err"),
    ).toMatchObject({ outcome: "failed", archived: true });
  });

  it("lists the past CLI sessions no thread shows, as imported and resumable", () => {
    const rows = historyEntries(
      sources({
        sessions: [
          session("a", at(14)),
          session("b", at(10), { threadId: "t-done" as ThreadId }),
          session("c", at(5) - DAY, { agent: "codex", projectRoot: "/elsewhere/tools" }),
        ],
      }),
    );
    const imported = rows.filter((row) => row.kind === "imported");
    expect(imported.map((row) => [row.threadId, row.repo, row.agent, row.outcome])).toEqual([
      ["session:claude:a", "web", "claude", undefined],
      ["session:codex:c", "tools", "codex", undefined],
    ]);
    expect(imported[0]).toMatchObject({ owner: IMPORTED_OWNER, place: "Imported sessions" });
    expect(imported[0]?.session?.projectRoot).toBe("/code/web");
    // Latest first among the rest.
    expect(rows[0]?.threadId).toBe("session:claude:a");
  });
});

describe("History's chips and search", () => {
  const rows = historyEntries(
    sources({
      summaries: [
        summary("s-noon", { completedAt: at(12), title: "Fix the login page" }),
        summary("s-parked", { parked: true, parkedAt: at(10), projectId: "p-web" as ProjectId }),
        summary("o-old", {
          role: "orchestrator",
          workspaceId: "w1" as WorkspaceId,
          parked: true,
          parkedAt: at(6),
        }),
      ],
      sessions: [session("a", at(14))],
    }),
  );

  it("counts each chip's rows", () => {
    expect(filterCounts(rows)).toEqual({
      all: 12,
      workers: 8,
      threads: 3,
      archived: 3,
      imported: 1,
    });
  });

  it("narrows by chip, then by every word of the search in title, repo or place", () => {
    expect(searchHistory(rows, "threads", "").map((row) => row.threadId)).toEqual([
      "s-noon",
      "s-parked",
      "o-old",
    ]);
    expect(searchHistory(rows, "archived", "").map((row) => row.threadId)).toEqual([
      "s-parked",
      "o-old",
      "t-parked",
    ]);
    expect(searchHistory(rows, "all", "login").map((row) => row.threadId)).toEqual(["s-noon"]);
    // By repo, and by repo and title together.
    expect(searchHistory(rows, "all", "web").map((row) => row.threadId)).toEqual([
      "session:claude:a",
      "s-parked",
    ]);
    expect(searchHistory(rows, "all", "INFRA closed t-swept").map((row) => row.threadId)).toEqual([
      "t-swept",
    ]);
    expect(searchHistory(rows, "imported", "login")).toEqual([]);
  });
});

describe("History's times", () => {
  it("says the clock under a day heading, else the date and the clock, 24-hour", () => {
    expect(historyWhen(at(9, 5), "date", NOW)).toBe("09:05");
    expect(historyWhen(daysBefore(NOW, DONE_DAYS - 1), "date", NOW)).toBe("00:00");
    expect(historyWhen(at(17, 30) - 10 * DAY, "date", NOW)).toBe("5 Oct 17:30");
    expect(historyWhen(new Date(2025, 11, 30, 8, 0).getTime(), "date", NOW)).toBe(
      "30 Dec 2025 08:00",
    );
    expect(historyWhen(at(9, 5), "orchestrator", NOW)).toBe("09:05");
    expect(historyWhen(at(9, 5) - DAY, "orchestrator", NOW)).toBe("14 Oct 09:05");
    expect(historyWhen(undefined, "date", NOW)).toBe("");
    expect(doneDay(at(9) - DAY, NOW).label).toBe("Yesterday");
  });
});

describe("the folders whose sessions History reads", () => {
  it("goes by the threads' latest activity, at most the cap", () => {
    const projects = [
      { id: "p-a" as ProjectId, root: "/a" },
      { id: "p-b" as ProjectId, root: "/b" },
      { id: "p-c" as ProjectId, root: "/c" },
    ];
    const summaries = [
      summary("x", { projectId: "p-b" as ProjectId, lastActivityAt: at(10) }),
      summary("y", { projectId: "p-c" as ProjectId, lastActivityAt: at(12) }),
      summary("z", { projectId: "p-b" as ProjectId, lastActivityAt: at(13) }),
    ];
    expect(sessionRoots(projects, summaries, 2)).toEqual(["/b", "/c"]);
    expect(sessionRoots(projects, [], 5)).toEqual(["/a", "/b", "/c"]);
  });
});
