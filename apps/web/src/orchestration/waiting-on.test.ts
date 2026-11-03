import {
  wakeConditionLabel,
  type PendingWake,
  type ProjectId,
  type RequestId,
  type ThreadId,
  type ThreadStatus,
  type WakeCondition,
  type WorkerLedgerEntry,
  type WorkerLimitWait,
  type WorkerPr,
  type WorkerState,
} from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { railRows, type RailFacts } from "./rail-model";
import { workerActivity } from "./wait-model";
import {
  conditionShort,
  orchestratorWaitingOn,
  waitClock,
  waitingOf,
  workerWaitingOn,
  WAIT_KINDS,
  type WaitKind,
  type WaitReason,
} from "./waiting-on";
import { workerRow, workerTones, workerWaitings } from "./workers-model";

// The one "waiting on" model: what a calm worker or orchestrator waits on, as one short label and
// a hover that lists every wait, read the same by the sidebar, the Board and ⌘J.

const NOW = Date.UTC(2026, 10, 3, 7, 0);
const clock = waitClock(NOW, { timeZone: "UTC" });
const MIN = 60_000;

const worker = (
  state: WorkerState,
  extra: Partial<WorkerLedgerEntry> = {},
  status: ThreadStatus = "idle",
): WorkerLedgerEntry => ({
  feature: "waits",
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
  number: 69,
  state: "open",
  ...extra,
});

const timed = (at: number, note = "check the deploy"): PendingWake => ({ id: `w-${at}`, at, note });

const limit = (resumeAt: number, kind: "limit" | "backoff" = "limit") =>
  ({ kind, resumeAt }) as WorkerLimitWait;

const dependency = (repo: string, number: number) => ({
  repo,
  number,
  state: "open" as const,
  setBy: "orchestrator" as const,
});

const onPr = (on: PendingWake["on"]): PendingWake => ({
  ...timed(NOW + 90 * MIN, "rebase"),
  onPr: { repo: "acme/app", number: 645 },
  ...(on === undefined ? {} : { on }),
});

const reason = (kind: WaitKind, at?: number): WaitReason => ({
  kind,
  short: kind,
  detail: `${kind} detail`,
  ...(at === undefined ? {} : { at }),
});

/** What a worker waits on, by the shared activity selector, as every surface reads it. */
const waitingOn = (entry: WorkerLedgerEntry) =>
  workerWaitingOn(entry, workerActivity(entry), NOW, { clock });

describe("what a worker waits on", () => {
  it("names CI running on its PR", () => {
    const waiting = waitingOn(worker("inReview", { pr: pr({ checks: "pending 3/5" }) }));
    expect(waiting).toMatchObject({ kind: "checks", label: "Waiting · checks on #69" });
    expect(waiting?.hint).toBe("Waiting · checks on #69\nCI is running on #69 in acme/app.");
  });

  it("names Gram's local check", () => {
    const waiting = waitingOn(
      worker("readyToMerge", {
        pr: pr({ mergeState: "CLEAN", localCheck: { status: "running" }, mergeWhenReady: {} }),
      }),
    );
    expect(waiting?.label).toBe("Waiting · local check #69");
  });

  it("names the review bot at work on its head", () => {
    expect(waitingOn(worker("inReview", { pr: pr({ botOnHead: "reviewing" }) }))).toMatchObject({
      kind: "review",
      label: "Waiting · review on #69",
    });
  });

  it("names the merge Gram makes once it is ready", () => {
    const waiting = waitingOn(
      worker("readyToMerge", { pr: pr({ mergeState: "CLEAN", mergeWhenReady: {} }) }),
    );
    expect(waiting).toMatchObject({ kind: "merge", label: "Waiting · merge of #69" });
    expect(waiting?.reasons[0]?.detail).toBe("Gram merges #69 in acme/app once it is ready.");
  });

  it("says why an armed merge waits when the server says so", () => {
    const waiting = waitingOn(
      worker("readyToMerge", {
        pr: pr({ mergeState: "CLEAN", mergeWhenReady: { waiting: "Waits for the merge window." } }),
      }),
    );
    expect(waiting?.reasons[0]?.detail).toBe("Waits for the merge window.");
  });

  it("names a merge held for an agent's work", () => {
    expect(
      waitingOn(
        worker("readyToMerge", {
          pr: pr({
            mergeState: "CLEAN",
            mergeWhenReady: { hold: "re-review", holdWaitsOn: "agent", heldBy: "orchestrator" },
          }),
        }),
      ),
    ).toMatchObject({ kind: "merge", label: "Waiting · #69 held" });
  });

  it("names the PR it depends on, in its own repo or another", () => {
    expect(
      waitingOn(worker("inReview", { pr: pr({ dependsOn: [dependency("acme/app", 102)] }) }))
        ?.label,
    ).toBe("Waiting · #102 to merge");
    const other = waitingOn(
      worker("inReview", { pr: pr({ dependsOn: [dependency("acme/api", 7)] }) }),
    );
    expect(other).toMatchObject({ kind: "dependency", label: "Waiting · acme/api#7 to merge" });
    expect(other?.reasons[0]?.detail).toBe("#69 in acme/app waits for acme/api#7 to merge (open).");
  });

  it("leaves out a dependency that merged or that it doesn't wait to merge after", () => {
    const merged = {
      repo: "acme/app",
      number: 102,
      state: "merged" as const,
      setBy: "orchestrator" as const,
    };
    const loose = { ...merged, state: "open" as const, mergeAfter: false as const };
    expect(
      waitingOn(worker("inReview", { pr: pr({ checks: "pending", dependsOn: [merged, loose] }) }))
        ?.reasons,
    ).toHaveLength(1);
  });

  it("names a wake on another PR by what it waits for", () => {
    const label = (wake: PendingWake) => waitingOn(worker("working", { wakes: [wake] }))?.label;
    expect(label(onPr(undefined))).toBe("Waiting · #645 to merge");
    expect(label(onPr(["headChanged"]))).toBe("Waiting · #645 to move");
    expect(label(onPr(["checksSettled"]))).toBe("Waiting · checks on #645");
    expect(waitingOn(worker("working", { wakes: [onPr(undefined)] }))?.reasons[0]).toMatchObject({
      kind: "dependency",
      detail: "Wakes when #645 merges, is closed or gets a new push, else at 08:30: rebase",
    });
  });

  it("names a condition wake by what it waits for, the thread by its title on hover", () => {
    const moved: PendingWake = {
      ...timed(NOW + 6 * 60 * MIN, "rebase onto main"),
      condition: { kind: "branchMoved", repo: "acme/app", branch: "main" },
    };
    const branch = waitingOn(worker("working", { wakes: [moved] }));
    expect(branch).toMatchObject({ kind: "condition", label: "Waiting · main to move" });
    expect(branch?.reasons[0]?.detail).toBe(
      "Wakes when acme/app main gets a new head, else at 13:00: rebase onto main",
    );
    const finished: PendingWake = {
      ...timed(NOW + 6 * 60 * MIN, "read its findings"),
      condition: { kind: "threadFinished", threadId: "t-research" as ThreadId },
    };
    const named = workerWaitingOn(
      worker("working", { wakes: [finished] }),
      workerActivity(worker("working", { wakes: [finished] })),
      NOW,
      { clock, name: (id) => (id === "t-research" ? "Research the paging API" : undefined) },
    );
    expect(named?.label).toBe("Waiting · thread to finish");
    expect(named?.reasons[0]?.detail).toBe(
      'Wakes when "Research the paging API" finishes, else at 13:00: read its findings',
    );
    expect(waitingOn(worker("working", { wakes: [finished] }))?.reasons[0]?.detail).toBe(
      "Wakes when thread t-research finishes, else at 13:00: read its findings",
    );
  });

  it("reads a condition kind it has no words for as its chip does", () => {
    // A kind contracts add later: the selector takes `wakeConditionLabel`'s words for it.
    const later = { kind: "someLaterKind", repo: "acme/app" } as unknown as WakeCondition;
    const label = wakeConditionLabel(later) ?? "someLaterKind";
    expect(conditionShort(later)).toBe(label);
    const waiting = waitingOn(
      worker("working", { wakes: [{ ...timed(NOW + 30 * MIN), condition: later }] }),
    );
    expect(waiting).toMatchObject({ kind: "condition", label: `Waiting · ${label}` });
  });

  it("reads a release wait and a version wait in a few words", () => {
    const release = waitingOn(
      worker("working", {
        wakes: [
          {
            ...timed(NOW + 30 * MIN),
            condition: {
              kind: "releasePublished",
              source: "npm",
              name: "@openai/codex",
              after: "0.166.0",
              minAgeDays: 7,
            },
          },
        ],
      }),
    );
    expect(release).toMatchObject({ kind: "condition", label: "Waiting · codex release" });
    const update = waitingOn(
      worker("working", {
        wakes: [
          {
            ...timed(NOW + 30 * MIN),
            condition: { kind: "versionChanged", target: "gram", from: "1.5.0" },
          },
        ],
      }),
    );
    expect(update).toMatchObject({ kind: "condition", label: "Waiting · Gram update" });
  });

  it("keeps every label to four words, the separator aside", () => {
    const labels = [
      waitingOn(worker("inReview", { pr: pr({ checks: "pending" }) })),
      waitingOn(
        worker("readyToMerge", {
          pr: pr({ mergeState: "CLEAN", localCheck: { status: "running" }, mergeWhenReady: {} }),
        }),
      ),
      waitingOn(worker("working", { wakes: [timed(NOW + 26 * 60 * MIN)] })),
      waitingOn(worker("working", { limitWait: limit(NOW + MIN, "backoff") })),
      waitingOn(worker("working", { limitWait: limit(NOW - MIN) })),
      waitingOn(worker("working", { userIntervened: true })),
    ].map((waiting) => waiting!.label);
    for (const label of labels) {
      expect(label.split(/\s+/).filter((word) => word !== "·").length, label).toBeLessThanOrEqual(
        4,
      );
    }
  });

  it("names a watched workflow run", () => {
    const waiting = waitingOn(
      worker("delivered", {
        runWatches: [{ repo: "acme/app", runId: 4242, name: "Release", since: NOW - MIN }],
      }),
    );
    expect(waiting).toMatchObject({ kind: "run", label: "Waiting · Release run" });
    expect(waiting?.reasons[0]?.detail).toBe("Watching the Release run, 4242 in acme/app.");
    expect(
      waitingOn(worker("delivered", { runWatches: [{ repo: "acme/app", runId: 7, since: NOW }] }))
        ?.label,
    ).toBe("Waiting · run 7");
  });

  it("names a timed wake by its time, on a 24-hour clock, the day named when it isn't today", () => {
    const today = waitingOn(worker("working", { wakes: [timed(NOW + 70 * MIN)] }));
    expect(today).toMatchObject({ kind: "timer", label: "Waiting · until 08:10" });
    expect(today?.reasons[0]?.detail).toBe("Wakes at 08:10: check the deploy");
    const late = waitingOn(worker("working", { wakes: [timed(NOW + 14 * 60 * MIN)] }));
    expect(late?.label).toBe("Waiting · until 21:00");
    const tomorrow = waitingOn(worker("working", { wakes: [timed(NOW + 26 * 60 * MIN)] }));
    expect(tomorrow?.label).toBe("Waiting · until Wed 09:00");
  });

  it("pauses on a usage limit until it resumes on its own", () => {
    const entry = worker("working", { limitWait: limit(NOW + 70 * MIN) });
    expect(workerActivity(entry)).toEqual({ activity: "automation", reason: "usage limit" });
    const waiting = waitingOn(entry);
    expect(waiting).toMatchObject({ kind: "limit", label: "Paused · limit until 08:10" });
    expect(waiting?.reasons[0]?.detail).toBe(
      "Waits out a usage limit; resumes on its own at 08:10.",
    );
    expect(
      waitingOn(worker("working", { limitWait: limit(NOW + 5 * MIN, "backoff") }))?.label,
    ).toBe("Paused · retry at 07:05");
    expect(waitingOn(worker("working", { limitWait: limit(NOW - MIN) }))?.label).toBe(
      "Paused · limit, resuming",
    );
  });

  it("says the user holds it", () => {
    expect(waitingOn(worker("working", { userIntervened: true }))).toMatchObject({
      kind: "held",
      label: "Held · by you",
    });
  });

  it("says nothing of a worker at work, one that needs somebody, finished work, or rest", () => {
    const ci = { pr: pr({ checks: "pending" }) };
    expect(waitingOn(worker("inReview", ci, "running"))).toBeUndefined();
    expect(
      waitingOn(
        worker("needsUser", {
          ...ci,
          pendingRequests: [{ requestId: "r-1" as RequestId, kind: "approval", ageMin: 1 }],
        }),
      ),
    ).toBeUndefined();
    expect(waitingOn(worker("error", ci))).toBeUndefined();
    expect(waitingOn(worker("blocked", ci))).toBeUndefined();
    expect(waitingOn(worker("inReview", { pr: pr({ checks: "failing 1/5" }) }))).toBeUndefined();
    expect(waitingOn(worker("merged", { pr: pr({ state: "merged" }) }))).toBeUndefined();
    expect(waitingOn(worker("working"))).toBeUndefined();
  });

  it("waits on the wake that brings back a worker that has to act on its PR", () => {
    // Conflicts are the worker's to fix; its wake brings it back to them.
    const waiting = waitingOn(
      worker("inReview", { pr: pr({ mergeState: "DIRTY" }), wakes: [timed(NOW + 30 * MIN)] }),
    );
    expect(waiting).toMatchObject({ kind: "timer", label: "Waiting · until 07:30" });
  });
});

describe("which wait the label names", () => {
  it("puts what holds everything first and a timed wake last, every kind ranked", () => {
    const reversed = WAIT_KINDS.toReversed().map((kind) => reason(kind));
    expect(waitingOf(reversed)?.reasons.map((r) => r.kind)).toEqual(WAIT_KINDS);
    expect(waitingOf(reversed)?.kind).toBe("limit");
  });

  it("names CI over the dependency and the fallback wake of the same worker", () => {
    const waiting = waitingOn(
      worker("inReview", {
        pr: pr({
          checks: "pending",
          dependsOn: [{ repo: "acme/app", number: 102, state: "open", setBy: "thread" }],
        }),
        wakes: [timed(NOW + 30 * MIN)],
        runWatches: [{ repo: "acme/app", runId: 9, since: NOW }],
      }),
    );
    expect(waiting?.label).toBe("Waiting · checks on #69");
    expect(waiting?.reasons.map((r) => r.kind)).toEqual(["checks", "dependency", "run", "timer"]);
  });

  it("names the soonest of two waits of a kind", () => {
    const waiting = waitingOn(
      worker("working", { wakes: [timed(NOW + 3 * 60 * MIN, "later"), timed(NOW + 20 * MIN)] }),
    );
    expect(waiting?.label).toBe("Waiting · until 07:20");
  });

  it("puts +N in the hover only, then every wait's line", () => {
    const waiting = waitingOn(
      worker("inReview", {
        pr: pr({ checks: "pending", botOnHead: "reviewing" }),
        wakes: [timed(NOW + 70 * MIN)],
      }),
    );
    expect(waiting?.label).toBe("Waiting · checks on #69");
    expect(waiting?.hint.split("\n")).toEqual([
      "Waiting · checks on #69 · +2",
      "CI is running on #69 in acme/app.",
      "The review bot is reviewing the head of #69 in acme/app.",
      "Wakes at 08:10: check the deploy",
    ]);
  });

  it("puts a usage limit over everything else it waits on", () => {
    const waiting = waitingOn(
      worker("inReview", { pr: pr({ checks: "pending" }), limitWait: limit(NOW + 70 * MIN) }),
    );
    expect(waiting?.label).toBe("Paused · limit until 08:10");
    expect(waiting?.reasons).toHaveLength(2);
  });
});

describe("waiting is never needs you", () => {
  const waiting = [
    worker("inReview", { pr: pr({ checks: "pending" }) }),
    worker("inReview", { pr: pr({ botOnHead: "reviewing" }) }),
    worker("readyToMerge", { pr: pr({ mergeState: "CLEAN", mergeWhenReady: {} }) }),
    worker("inReview", {
      pr: pr({ dependsOn: [{ repo: "acme/app", number: 1, state: "open", setBy: "thread" }] }),
    }),
    worker("delivered", { runWatches: [{ repo: "acme/app", runId: 1, since: NOW }] }),
    worker("working", { wakes: [timed(NOW + MIN)] }),
    worker("working", { limitWait: limit(NOW + MIN) }),
    worker("working", { userIntervened: true }),
  ].map((entry, i) => ({ ...entry, threadId: `t-${i}` as ThreadId }));
  const ledger = { features: [{ feature: "waits", state: "working" as const, workers: waiting }] };
  const facts = { byId: {}, statusDetail: {}, now: NOW, clock };

  it("keeps every waiting worker's tone calm, on every surface", () => {
    const { tones } = workerTones(ledger, [], facts);
    const waits = workerWaitings(ledger, facts);
    for (const entry of waiting) {
      expect(waits[entry.threadId], entry.threadId).toBeDefined();
      expect(["needs", "attention", "error", "working"]).not.toContain(tones[entry.threadId]);
      const row = workerRow(entry, facts);
      expect(row.tab).toBe("now");
      expect(row.glyph).not.toBe("needsYou");
      expect(row.now).toBe(waits[entry.threadId]!.label);
    }
  });

  it("gives the Board's chip the same label and hover", () => {
    const card = {
      feature: "waits",
      station: "checks" as const,
      updatedAt: NOW,
      version: 1,
      workers: waiting.map((entry) => ({
        threadId: entry.threadId,
        title: entry.title,
        project: "app",
        now: "checks running",
        station: "checks" as const,
        state: entry.state,
        prs: [],
        overlapsWith: [],
        overlapFiles: [],
      })),
    };
    const rail: RailFacts = {
      asking: new Set(),
      status: () => "idle",
      tones: workerTones(ledger, [], facts).tones,
      waiting: workerWaitings(ledger, facts),
    };
    const [row] = railRows([card as never], rail, "all");
    const chips = Object.values(row!.cells).flat();
    const waits = workerWaitings(ledger, facts);
    for (const chip of chips) {
      expect(chip.now).toBe(waits[chip.threadId]!.label);
      expect(chip.waiting?.hint).toBe(waits[chip.threadId]!.hint);
      expect(row!.needs).toBe(false);
    }
  });

  it("says nothing of a worker with an ask, whatever else it waits on", () => {
    const asking = { ...facts, asking: new Set(["t-0" as ThreadId]) };
    expect(workerWaitings(ledger, asking)["t-0"]).toBeUndefined();
    expect(workerRow(waiting[0]!, asking).now).not.toMatch(/^Waiting/);
  });
});

describe("what an orchestrator waits on", () => {
  it("names its soonest wake while it rests", () => {
    const waiting = orchestratorWaitingOn(
      { status: "idle", wakes: [timed(NOW + 70 * MIN, "check #102"), timed(NOW + 3 * 60 * MIN)] },
      NOW,
      clock,
    );
    expect(waiting?.label).toBe("Waiting · until 08:10");
    expect(waiting?.hint.split("\n")).toEqual([
      "Waiting · until 08:10 · +1",
      "Wakes at 08:10: check #102",
      "Wakes at 10:00: check the deploy",
    ]);
  });

  it("names a condition wake of its own", () => {
    expect(
      orchestratorWaitingOn(
        {
          status: "idle",
          wakes: [
            {
              ...timed(NOW + 30 * MIN, "merge the stack"),
              condition: { kind: "threadFinished", threadId: "t-9" as ThreadId },
            },
          ],
        },
        NOW,
        clock,
        () => "Cut 2.4.0",
      )?.hint.split("\n"),
    ).toEqual([
      "Waiting · thread to finish",
      'Wakes when "Cut 2.4.0" finishes, else at 07:30: merge the stack',
    ]);
  });

  it("pauses on a limit it waits out", () => {
    expect(
      orchestratorWaitingOn(
        { status: "idle", limitWait: { kind: "limit", resumeAt: NOW + 70 * MIN } },
        NOW,
        clock,
      )?.label,
    ).toBe("Paused · limit until 08:10");
  });

  it("says nothing while it works or asks, or with nothing to wait for", () => {
    const wakes = [timed(NOW + MIN)];
    expect(orchestratorWaitingOn({ status: "running", wakes }, NOW, clock)).toBeUndefined();
    expect(orchestratorWaitingOn({ status: "needsApproval", wakes }, NOW, clock)).toBeUndefined();
    expect(orchestratorWaitingOn({ status: "idle" }, NOW, clock)).toBeUndefined();
  });
});
