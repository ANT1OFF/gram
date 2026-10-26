import type {
  FinishedWorker,
  OpenPrRow,
  ProjectId,
  ReviewRequest,
  Thread,
  ThreadId,
  ThreadSummary,
  WorkerLedgerEntry,
  WorkerState,
  WorkspaceId,
} from "@gram/contracts";
import { describe, expect, it } from "vitest";

import type { UsageLimits } from "@/stores/usage-limits";

import {
  doneTodayRows,
  footMeters,
  MAX_SLOT_PIPS,
  overviewPrRows,
  prSubLine,
  workerSlots,
} from "./overview-extras-model";
import { workersByTab } from "./workers-model";

// Wednesday 15 October 2026, 14:40 local time.
const NOW = new Date(2026, 9, 15, 14, 40).getTime();
const at = (hour: number, minute = 0) => new Date(2026, 9, 15, hour, minute).getTime();

const request = (repo: string, number: number, updatedAt: string, extra = {}): ReviewRequest =>
  ({
    repo,
    number,
    title: `Request ${number}`,
    url: `https://github.com/${repo}/pull/${number}`,
    author: "jordan",
    updatedAt,
    createdAt: updatedAt,
    ...extra,
  }) as unknown as ReviewRequest;

const own = (repo: string, number: number, updatedAt: string, extra = {}): OpenPrRow =>
  ({
    repo,
    number,
    title: `Mine ${number}`,
    url: `https://github.com/${repo}/pull/${number}`,
    author: "me",
    isDraft: false,
    updatedAt,
    createdAt: updatedAt,
    ...extra,
  }) as unknown as OpenPrRow;

describe("the overview's pull requests", () => {
  const requests = [
    request("example/api", 530, "2026-10-15T10:00:00Z"),
    request("example/infra", 88, "2026-10-15T12:00:00Z", {
      author: "renovate[bot]",
      isBot: true,
      title: "",
    }),
  ];
  const mine = [own("example/api", 412, "2026-10-14T09:00:00Z", { owner: "t-1" as ThreadId })];

  it("lists the review requests, then your own, each latest first", () => {
    const rows = overviewPrRows(requests, mine, { reviews: true, own: true });
    expect(rows.map((row) => [row.kind, row.ref])).toEqual([
      ["review", "infra#88"],
      ["review", "api#530"],
      ["yours", "api#412"],
    ]);
    // A title-less PR is named by its ref; a bot by its name without the suffix.
    expect(rows[0]).toMatchObject({ title: "example/infra#88", author: "renovate" });
    expect(rows[2]).toMatchObject({
      url: "https://github.com/example/api/pull/412",
      owner: "t-1",
    });
    expect(rows.every((row) => row.glyph.word.length > 0)).toBe(true);
  });

  it("leaves out a list placed nowhere", () => {
    expect(overviewPrRows(requests, mine, { reviews: false, own: true })).toHaveLength(1);
    expect(overviewPrRows(requests, mine, { reviews: true, own: false })).toHaveLength(2);
    expect(overviewPrRows(requests, mine, { reviews: false, own: false })).toEqual([]);
  });

  it("puts the repo and author under the title", () => {
    expect(prSubLine({ ref: "api#530", author: "jordan" })).toBe("api#530 · jordan");
    expect(prSubLine({ ref: "api#530", author: undefined })).toBe("api#530");
  });
});

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

const summary = (id: string, thread: Partial<Thread>): ThreadSummary =>
  ({
    thread: { id: id as ThreadId, title: `Title of ${id}`, lastActivityAt: NOW, ...thread },
    status: "idle",
    pendingRequests: [],
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
});

describe("Done today across the workspaces", () => {
  const ledger = {
    features: [
      {
        feature: "retry",
        workers: [
          worker("t-merged", "merged", { pr: { repo: "example/api", number: 412 } }),
          worker("t-done", "delivered"),
          worker("t-live", "working", { status: "running" }),
          worker("t-old", "merged"),
        ],
      },
    ],
  } as unknown as Parameters<typeof workersByTab>[0];
  const byId = {
    "t-merged": summary("t-merged", { completedAt: at(13, 5) }),
    "t-done": summary("t-done", { completedAt: at(9, 30) }),
    "t-old": summary("t-old", { completedAt: at(9) - 24 * 60 * 60_000 }),
  };
  const facts = { byId, statusDetail: {}, now: NOW };
  const sources = [
    {
      workspaceId: "w1" as WorkspaceId,
      name: "agent-platform",
      ledger,
      finished: [],
    },
    {
      workspaceId: "w2" as WorkspaceId,
      name: "infra",
      ledger: undefined,
      finished: [closed("t-closed", at(11, 45), true), closed("t-swept", at(8), false)],
    },
  ];

  it("has the rows ⌘J's Done today has for each workspace, latest first across them", () => {
    const rows = doneTodayRows(sources, facts);
    expect(rows.map((row) => row.threadId)).toEqual(["t-merged", "t-closed", "t-done", "t-swept"]);
    for (const source of sources) {
      const listed = workersByTab(source.ledger, facts, source.finished).doneToday.flatMap((f) =>
        f.rows.map((row) => row.threadId),
      );
      expect(
        rows.filter((row) => row.workspaceId === source.workspaceId).map((row) => row.threadId),
      ).toEqual(expect.arrayContaining(listed));
      expect(rows.filter((row) => row.workspaceId === source.workspaceId)).toHaveLength(
        listed.length,
      );
    }
  });

  it("gives each its time on a 24-hour clock and its workspace and outcome", () => {
    const rows = doneTodayRows(sources, facts);
    expect(rows.map((row) => [row.time, row.merged, row.sub])).toEqual([
      ["13:05", true, "agent-platform · merged api#412"],
      ["11:45", true, "infra · merged infra#88"],
      ["09:30", false, "agent-platform · done"],
      ["08:00", false, "infra · cleaned up"],
    ]);
  });

  it("is empty with nothing finished today", () => {
    expect(doneTodayRows([], facts)).toEqual([]);
  });
});

const reading = (utilization: number, resetsAt: number) => ({
  utilization,
  status: "allowed",
  at: NOW - 60_000,
  resetsAt,
  expiresAt: resetsAt,
});

describe("the overview's foot", () => {
  it("has a 5-hour meter for each provider with a reading, warning as the title bar's does", () => {
    const limits = {
      claude: { fiveHour: reading(0.42, at(18)), weekly: reading(0.9, at(18) + 86_400_000) },
      codex: { fiveHour: reading(0.85, at(16, 30)) },
    } as unknown as UsageLimits;
    expect(
      footMeters(limits, NOW).map(({ name, percent, resets, warns }) => ({
        name,
        percent,
        resets,
        warns,
      })),
    ).toEqual([
      { name: "Claude", percent: 42, resets: "18:00", warns: false },
      { name: "Codex", percent: 85, resets: "16:30", warns: true },
    ]);
  });

  it("leaves out a provider with only a weekly reading, or one that ran out", () => {
    const limits = {
      claude: { weekly: reading(0.3, at(18) + 86_400_000) },
      codex: { fiveHour: reading(0.2, NOW - 60_000) },
    } as unknown as UsageLimits;
    expect(footMeters(limits, NOW)).toEqual([]);
    expect(footMeters({}, NOW)).toEqual([]);
  });

  it("counts the worker slots against the cap, with the briefs held for later", () => {
    expect(workerSlots({ liveWorkers: 6, maxConcurrentWorkers: 8 }, 1)).toEqual({
      live: 6,
      cap: 8,
      held: 1,
      pips: [true, true, true, true, true, true, false, false],
      text: "6 of 8 · 1 held",
    });
    expect(workerSlots({ liveWorkers: 2, maxConcurrentWorkers: 4 }, 0).text).toBe("2 of 4");
    // Past the cap (a worker reopened), every pip is taken; a big cap draws only so many.
    expect(workerSlots({ liveWorkers: 5, maxConcurrentWorkers: 4 }, 0).pips).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(workerSlots({ liveWorkers: 1, maxConcurrentWorkers: 40 }, 0).pips).toHaveLength(
      MAX_SLOT_PIPS,
    );
  });
});
