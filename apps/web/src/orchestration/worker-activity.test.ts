import type {
  FeatureCardWorker,
  ThreadSummary,
  PendingWake,
  ProjectId,
  ThreadId,
  ThreadStatus,
  WorkerLedgerEntry,
  WorkerPr,
  WorkerState,
} from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { dotTone } from "@/views/quiet-model";

import { rowTone } from "./overview-model";
import { railTone, TONE_DOT } from "./rail-model";
import { isBusy, workerActivity } from "./wait-model";
import { workerActivities, workerRow, workerTones } from "./workers-model";

// The one busy selector Quiet, the sidebar's worker rows and the Board share: a live turn and a
// wait on automation are busy, a stop that needs somebody is attention, finished work is done.

const NOW = new Date(2026, 9, 20, 17, 16).getTime();

const worker = (
  state: WorkerState,
  extra: Partial<WorkerLedgerEntry> = {},
  status: ThreadStatus = "idle",
): WorkerLedgerEntry => ({
  feature: "quiet",
  projectId: "p-app" as ProjectId,
  project: "app",
  threadId: "t-1" as ThreadId,
  title: "A worker",
  state,
  status,
  pendingRequests: [],
  changedFiles: 0,
  overlapsWith: [],
  userIntervened: false,
  messagesFromOrchestrator: 0,
  ...extra,
});

const pr = (extra: Partial<WorkerPr> = {}): WorkerPr => ({
  repo: "acme/app",
  number: 12,
  state: "open",
  ...extra,
});

const wake: PendingWake = {
  id: "w-1",
  at: NOW + 60_000,
  note: "look at CI again",
};

const activity = (entry: WorkerLedgerEntry) => workerActivity(entry);

describe("the busy selector", () => {
  it("counts a live turn as busy", () => {
    expect(activity(worker("working", {}, "running"))).toEqual({ activity: "working" });
    expect(activity(worker("inReview", { pr: pr({ mergeState: "DIRTY" }) }, "running"))).toEqual({
      activity: "working",
    });
    expect(activity(worker("working", { compacting: true })).activity).toBe("working");
    expect(isBusy("working")).toBe(true);
  });

  it("counts work waiting on CI or a review as busy, with the reason", () => {
    expect(activity(worker("inReview", { pr: pr({ checks: "pending 3/5" }) }))).toEqual({
      activity: "automation",
      reason: "CI pending",
    });
    expect(activity(worker("inReview", { pr: pr({ botOnHead: "reviewing" }) }))).toEqual({
      activity: "automation",
      reason: "bot reviewing",
    });
    expect(isBusy("automation")).toBe(true);
  });

  it("counts a wake, a dependency, a local check and an armed monitor as busy", () => {
    expect(activity(worker("working", { wakes: [wake] }))).toEqual({
      activity: "automation",
      reason: "wake scheduled",
    });
    const dependency = pr({
      dependsOn: [{ repo: "acme/app", number: 11, state: "open", setBy: "thread" }],
    });
    expect(activity(worker("inReview", { pr: dependency }))).toEqual({
      activity: "automation",
      reason: "dependency",
    });
    const checking = pr({
      mergeState: "CLEAN",
      checks: "passing",
      mergeWhenReady: {},
      localCheck: { status: "running" },
    });
    expect(activity(worker("readyToMerge", { pr: checking }))).toEqual({
      activity: "automation",
      reason: "local check",
    });
    // A monitor armed before the PR's badge has been looked up.
    expect(activity(worker("working", { waitingOnAutomation: true }))).toEqual({
      activity: "automation",
      reason: "monitor armed",
    });
  });

  it("says conflicts with nothing armed to bring the worker back need attention", () => {
    expect(activity(worker("inReview", { pr: pr({ mergeState: "DIRTY" }) }))).toEqual({
      activity: "attention",
      reason: "conflicts",
    });
    // A monitor has nothing left to wait for: the conflict is already there.
    const monitored = pr({ mergeState: "DIRTY", monitored: true });
    expect(activity(worker("inReview", { pr: monitored, waitingOnAutomation: true }))).toEqual({
      activity: "attention",
      reason: "conflicts",
    });
    // A wake will bring it back to them.
    expect(
      activity(worker("inReview", { pr: pr({ mergeState: "DIRTY" }), wakes: [wake] })).activity,
    ).toBe("automation");
    expect(isBusy("attention")).toBe(false);
  });

  it("says failing checks the worker hasn't picked up need attention", () => {
    expect(activity(worker("inReview", { pr: pr({ checks: "failing 1/5" }) }))).toEqual({
      activity: "attention",
      reason: "CI failing",
    });
    // Its monitor fired on them and it stopped: nothing will move it on.
    const monitored = pr({ checks: "failing 1/5", monitored: true });
    expect(activity(worker("inReview", { pr: monitored })).activity).toBe("attention");
  });

  it("says a question, a request or an error needs attention", () => {
    expect(activity(worker("question")).activity).toBe("attention");
    expect(activity(worker("blocked")).activity).toBe("attention");
    expect(activity(worker("error")).activity).toBe("attention");
    expect(activity(worker("working", {}, "needsApproval")).activity).toBe("attention");
  });

  it("says finished work is done and work with nothing going on is idle", () => {
    expect(activity(worker("merged", { pr: pr({ state: "merged" }) })).activity).toBe("done");
    expect(activity(worker("delivered")).activity).toBe("done");
    expect(activity(worker("done")).activity).toBe("done");
    expect(activity(worker("briefed")).activity).toBe("idle");
    // Held by the user (a message, a paused feature): theirs by choice, not stalled.
    expect(activity(worker("working", { userIntervened: true }))).toEqual({
      activity: "idle",
      reason: "you hold it",
    });
    expect(isBusy("done")).toBe(false);
    expect(isBusy("idle")).toBe(false);
  });
});

/** A worker's line on its feature card, as the Board and the sidebar read it. */
const card = (entry: WorkerLedgerEntry): FeatureCardWorker => ({
  threadId: entry.threadId,
  title: entry.title,
  project: entry.project,
  state: entry.state,
  station: entry.state === "briefed" ? "briefed" : "working",
  now: "",
  prs: [],
  overlapsWith: [],
  overlapFiles: [],
});

describe("Quiet, the Board and the sidebar", () => {
  const cases: readonly { name: string; entry: WorkerLedgerEntry; busy: boolean }[] = [
    { name: "live turn", entry: worker("working", {}, "running"), busy: true },
    {
      name: "CI pending",
      entry: worker("inReview", { pr: pr({ checks: "pending" }) }),
      busy: true,
    },
    { name: "wake", entry: worker("working", { wakes: [wake] }), busy: true },
    {
      name: "conflicts",
      entry: worker("inReview", { pr: pr({ mergeState: "DIRTY" }) }),
      busy: false,
    },
    { name: "question", entry: worker("question"), busy: false },
    { name: "idle", entry: worker("briefed"), busy: false },
  ];

  it.each(cases)("agree whether a worker is busy: $name", ({ entry, busy }) => {
    const ledger = { features: [{ feature: "quiet", state: entry.state, workers: [entry] }] };
    const shared = workerActivities(ledger as never, {});
    const row = workerRow(entry, { byId: {}, statusDetail: {}, now: NOW });
    expect(row.activity).toBe(shared[entry.threadId]);
    expect(isBusy(row.activity)).toBe(busy);

    // Quiet's dot.
    const quiet = dotTone(row);
    expect(quiet === "working" || quiet === "waiting").toBe(busy);

    // The Board's chip.
    const board = railTone(card(entry), {
      asking: new Set(),
      status: () => entry.status,
      activity: shared,
    });
    expect(board === "working" || board === "waiting").toBe(busy);

    // The sidebar's dot: the working colour, solid or hollow, only while busy.
    const dot = TONE_DOT[sidebarTone(entry, shared)];
    expect(dot.includes("status-working")).toBe(busy);
  });

  it("reads a wait on automation as waiting, not working, everywhere", () => {
    const entry = worker("inReview", { pr: pr({ checks: "pending" }) });
    const shared = workerActivities(
      { features: [{ feature: "quiet", state: entry.state, workers: [entry] }] } as never,
      {},
    );
    const row = workerRow(entry, { byId: {}, statusDetail: {}, now: NOW });
    expect(row.glyph).toBe("waiting");
    expect(row.now).toBe("CI pending");
    expect(dotTone(row)).toBe("waiting");
    expect(
      railTone(card(entry), { asking: new Set(), status: () => "idle", activity: shared }),
    ).toBe("waiting");
    expect(sidebarTone(entry, shared, "idle")).toBe("waiting");
    expect(TONE_DOT.waiting).toContain("border-status-working");
  });

  it("reads work still running under a thread at rest as working, everywhere", () => {
    const entry = worker("inReview", { pr: pr({ checks: "pending" }) });
    const summary = {
      thread: { id: entry.threadId, title: entry.title },
      status: "idle",
      pendingRequests: [],
      background: [{ id: "b-1", kind: "shell", command: "bun run check", description: "" }],
    } as unknown as ThreadSummary;
    const byId = { [entry.threadId]: summary };
    const shared = workerActivities(
      { features: [{ feature: "quiet", state: entry.state, workers: [entry] }] } as never,
      byId,
    );
    expect(shared[entry.threadId]).toBe("working");
    const row = workerRow(entry, { byId, statusDetail: {}, now: NOW });
    expect(dotTone(row)).toBe("working");
    expect(
      railTone(card(entry), { asking: new Set(), status: () => "idle", activity: shared }),
    ).toBe("working");
    expect(sidebarTone(entry, shared, "idle")).toBe("working");
  });
});

/** The sidebar's tone for a ledger worker, its row built as the overview builds it. */
const sidebarTone = (
  entry: WorkerLedgerEntry,
  shared: Readonly<Record<string, ReturnType<typeof workerActivity>["activity"]>>,
  status: ThreadStatus = entry.status,
) =>
  rowTone(
    {
      askKey: undefined,
      state: entry.state,
      failed: false,
      activity: shared[entry.threadId],
    },
    { status, working: status === "running" || status === "starting" },
  );

/** A thread the window has for `entry`, at `status`, with work running under it when `shell`. */
const threadOf = (entry: WorkerLedgerEntry, status: ThreadStatus, shell = false) =>
  ({
    thread: { id: entry.threadId, title: entry.title },
    status,
    pendingRequests: [],
    ...(shell
      ? { background: [{ id: "b-1", kind: "shell", command: "bun run check", description: "" }] }
      : {}),
  }) as unknown as ThreadSummary;

/** Every view's tone for one worker, each built as that view builds it. */
const everyTone = (entry: WorkerLedgerEntry, summary: ThreadSummary | undefined) => {
  const ledger = { features: [{ feature: "quiet", state: entry.state, workers: [entry] }] };
  const byId = summary === undefined ? {} : { [entry.threadId]: summary };
  const running = summary !== undefined && summary.status === "running" ? [entry.threadId] : [];
  const { tones } = workerTones(ledger as never, running, { byId, statusDetail: {} });
  const row = workerRow(entry, { byId, statusDetail: {}, now: NOW });
  return {
    shared: tones[entry.threadId],
    board: railTone(card(entry), {
      asking: new Set(),
      status: () => summary?.status,
      activity: workerActivities(ledger as never, byId),
      tones,
    }),
    sidebar: rowTone(
      {
        askKey: undefined,
        state: entry.state,
        failed: entry.state === "error",
        activity: undefined,
        tone: tones[entry.threadId],
      },
      { status: summary?.status, working: false },
    ),
    workers: row.tone,
    quiet: dotTone(row),
  };
};

describe("one tone for a worker", () => {
  it("is working everywhere while work runs under a thread its ledger says needs attention", () => {
    const entry = worker("inReview", { pr: pr({ mergeState: "DIRTY" }) });
    const tones = everyTone(entry, threadOf(entry, "idle", true));
    expect(tones).toEqual({
      shared: "working",
      board: "working",
      sidebar: "working",
      workers: "working",
      quiet: "working",
    });
  });

  it("is an error everywhere once the thread errors, before the ledger catches up", () => {
    const entry = worker("working");
    const tones = everyTone(entry, threadOf(entry, "error"));
    expect(tones).toEqual({
      shared: "error",
      board: "error",
      sidebar: "error",
      workers: "error",
      quiet: "error",
    });
  });

  it("is idle everywhere while the user holds it, the Workers list's glyph included", () => {
    const entry = worker("working", { userIntervened: true });
    const tones = everyTone(entry, threadOf(entry, "idle"));
    expect(tones.shared).toBe("idle");
    expect(tones.board).toBe("idle");
    expect(tones.quiet).toBe("idle");
    const row = workerRow(entry, { byId: {}, statusDetail: {}, now: NOW });
    expect(row.glyph).toBe("idle");
    expect(row.now).toBe("you hold it");
  });
});

/** A ledger of one feature with these workers, by id and state. */
const ledgerOf = (...entries: [string, WorkerState][]) => ({
  features: [
    {
      feature: "quiet",
      state: "working",
      workers: entries.map(([id, state]) => worker(state, { threadId: id as ThreadId })),
    },
  ],
});

/** The window's threads with these at work now. */
const running = (ids: string[]) => ({
  byId: Object.fromEntries(
    ids.map((id) => [id, threadOf(worker("working", { threadId: id as ThreadId }), "running")]),
  ),
  statusDetail: {},
});

describe("an orchestrator's line", () => {
  const facts = { byId: {}, statusDetail: {} };

  it("counts its live workers from its ledger, and any at work besides", () => {
    const ledger = ledgerOf(
      ["endpoint", "working"],
      ["queue", "inReview"],
      ["schema", "merged"],
      ["mail", "delivered"],
      ["old", "archived"],
      ["said", "done"],
    ) as never;
    const count = (ids: string[], over = facts) => {
      const { live, working } = workerTones(ledger, ids as ThreadId[], over);
      return { live, working };
    };
    expect(count([])).toEqual({ live: 2, working: 0 });
    // At work now: a worker its ledger doesn't have yet counts once, one it has isn't counted
    // twice, and one it has finished is live again.
    expect(count(["endpoint", "fresh"], running(["endpoint", "fresh"]))).toEqual({
      live: 3,
      working: 2,
    });
    expect(count(["schema"], running(["schema"])).working).toBe(1);
    expect(workerTones(undefined, [], facts)).toMatchObject({ live: 0, working: 0 });
  });

  it("counts as working only the workers whose tone is working: an ask is not", () => {
    const ledger = ledgerOf(["turn", "working"], ["asks", "working"], ["rest", "working"]) as never;
    const byId = {
      turn: threadOf(worker("working", { threadId: "turn" as ThreadId }), "running"),
      asks: threadOf(worker("working", { threadId: "asks" as ThreadId }), "running"),
    };
    const tally = workerTones(ledger, ["turn", "asks"] as ThreadId[], {
      byId,
      statusDetail: {},
      asking: new Set(["asks" as ThreadId]),
    });
    expect(tally).toMatchObject({ live: 3, working: 1 });
    expect(tally.tones).toEqual({ turn: "working", asks: "needs", rest: "idle" });
  });
});
