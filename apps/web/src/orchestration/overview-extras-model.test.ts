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

import { doneWhen, SOLO_OWNER } from "./done-model";
import {
  doneRows,
  footMeters,
  MAX_SLOT_PIPS,
  overviewPrRows,
  prSubLine,
  workerSlots,
} from "./overview-extras-model";
import { DONE_DAYS, daysBefore, doneDay, workersByTab } from "./workers-model";

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

describe("Done across the workspaces", () => {
  const DAY = 24 * 60 * 60_000;
  const ledger = {
    features: [
      {
        feature: "retry",
        workers: [
          worker("t-merged", "merged", { pr: { repo: "example/api", number: 412 } }),
          worker("t-done", "delivered"),
          worker("t-live", "working", { status: "running" }),
          worker("t-old", "merged"),
          // Archived by the orchestrator once its PR merged: finished all the same.
          worker("t-archived", "archived", {
            stateBase: { state: "merged", parked: true },
            pr: { repo: "example/api", number: 400 },
          }),
          worker("t-week", "delivered"),
          worker("t-gone", "merged"),
        ],
      },
    ],
  } as unknown as Parameters<typeof workersByTab>[0];
  const byId = {
    "t-merged": summary("t-merged", { completedAt: at(13, 5) }),
    "t-done": summary("t-done", { completedAt: at(9, 30) }),
    "t-old": summary("t-old", { completedAt: at(9) - DAY }),
    "t-archived": summary("t-archived", { completedAt: at(16) - 3 * DAY }),
    // The first minute of the week's first day, and the last of the day before it.
    "t-week": summary("t-week", { completedAt: daysBefore(NOW, DONE_DAYS - 1) }),
    "t-gone": summary("t-gone", { completedAt: daysBefore(NOW, DONE_DAYS - 1) - 60_000 }),
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
      finished: [
        closed("t-closed", at(11, 45), true),
        closed("t-swept", at(8), false),
        closed("t-swept-old", at(8) - 10 * DAY, false),
      ],
    },
  ];
  const ids = [
    "t-merged",
    "t-closed",
    "t-done",
    "t-swept",
    "t-old",
    "t-archived",
    "t-week",
    "t-gone",
    "t-swept-old",
  ];

  it("has every row ⌘J's Done has for each workspace, latest first, with no time window", () => {
    const rows = doneRows(sources, [], facts);
    expect(rows.map((row) => row.threadId)).toEqual(ids);
    for (const source of sources) {
      const listed = workersByTab(source.ledger, facts, source.finished)
        .done.flatMap((f) => f.rows)
        .map((row) => row.threadId);
      expect(
        rows.filter((row) => row.workspaceId === source.workspaceId).map((row) => row.threadId),
      ).toEqual(listed);
    }
    // Past the week's first midnight too, and work closed ten days ago.
    expect(rows.map((row) => row.threadId)).toEqual(
      expect.arrayContaining(["t-week", "t-gone", "t-swept-old"]),
    );
  });

  it("gives each its time, its group by date, and its workspace and outcome", () => {
    const rows = doneRows(sources, [], facts);
    expect(
      rows.map((row) => [
        doneDay(row.finishedAt, NOW).label,
        doneWhen(row.finishedAt, "date", NOW),
        row.merged,
        row.sub,
      ]),
    ).toEqual([
      ["Today", "13:05", true, "agent-platform · merged api#412"],
      ["Today", "11:45", true, "infra · merged infra#88"],
      ["Today", "09:30", false, "agent-platform · done"],
      ["Today", "08:00", false, "infra · cleaned up"],
      ["Yesterday", "09:00", true, "agent-platform · merged"],
      ["Mon 12 Oct", "16:00", true, "agent-platform · merged api#400"],
      ["Fri 9 Oct", "00:00", false, "agent-platform · done"],
      // Before the week, by month, each with its date.
      ["October 2026", "8 Oct", true, "agent-platform · merged"],
      ["October 2026", "5 Oct", false, "infra · cleaned up"],
    ]);
    expect(rows.map((row) => row.owner)).toEqual(
      rows.map((row) =>
        row.workspaceId === "w1"
          ? { key: "w1", label: "agent-platform" }
          : { key: "w2", label: "infra" },
      ),
    );
  });

  it("interleaves the solo threads marked done with the workers, by when each finished", () => {
    const solo = [
      summary("s-noon", { completedAt: at(12), completedReason: "user" }),
      summary("s-merged", { completedAt: at(10) - 2 * DAY, completedReason: "prMerged" }),
      summary("s-ancient", { completedAt: new Date(2026, 6, 3, 9).getTime() }),
    ];
    const rows = doneRows(sources, solo, facts);
    expect(rows.map((row) => row.threadId)).toEqual([
      "t-merged",
      "s-noon",
      "t-closed",
      "t-done",
      "t-swept",
      "t-old",
      "s-merged",
      "t-archived",
      "t-week",
      "t-gone",
      "t-swept-old",
      "s-ancient",
    ]);
    const noon = rows.find((row) => row.threadId === "s-noon")!;
    expect(noon).toMatchObject({
      kind: "solo",
      owner: SOLO_OWNER,
      merged: false,
      title: "Title of s-noon",
      sub: "Solo threads · done",
    });
    expect(noon.workspaceId).toBeUndefined();
    expect(rows.find((row) => row.threadId === "s-merged")).toMatchObject({
      merged: true,
      sub: "Solo threads · merged",
    });
    expect(doneDay(rows.at(-1)!.finishedAt, NOW).label).toBe("July 2026");
  });

  it("goes by a solo thread's last activity when no completion time is on record", () => {
    const [row] = doneRows([], [summary("s-bare", { lastActivityAt: at(7) })], facts);
    expect(row).toMatchObject({ threadId: "s-bare", finishedAt: at(7) });
  });

  it("is empty with nothing finished", () => {
    expect(doneRows([], [], facts)).toEqual([]);
    expect(doneRows([{ ...sources[1]!, finished: [] }], [], facts)).toEqual([]);
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
