// The orchestration ledger, git facts, the signal queue and joining a workspace.
import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_CHARTER,
  type ModelRef,
  type OrchestratorLedger,
  type ThreadId,
  type ThreadPlan,
  type WorkspaceId,
  WorkerState,
  liveWorkerState,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { AppToolRegistry } from "../app-tools/registry.ts";
import { makeCoalescingQueue } from "../events/backlog.ts";
import { hasGit, makeRepo, run } from "../git/test-repo.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentControl } from "../runtime/fake-agent.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import {
  changedPaths,
  driftBetween,
  extraCheckoutFacts,
  markRoot,
  noChangedPaths,
} from "./git-facts.ts";
import {
  accrueCost,
  canOpenPr,
  compactWorkerRow,
  featuresOf,
  groupsOf,
  isLiveWorker,
  prRow,
  visibleFeatures,
  type WorkerFacts,
} from "./ledger.ts";
import { decodeOutbox, emptyOutbox, encodeOutbox, OUTBOX_VERSION, readOutbox } from "./outbox.ts";
import { Orchestration, SIGNAL_COALESCING, type Signal } from "./service.ts";
import {
  GIT_HEAVY,
  atAutonomy,
  completeTurn,
  makeWorld,
  openOrchestrator,
  outboxOf,
  prBadge,
  publishGit,
  settle,
  spawn,
  waitReal,
  waitSent,
  type World,
} from "./test-harness.ts";
import { ProcLive } from "@gram/git";
import { inServer, sessionsOf } from "./service-kit.ts";

const spender = (id: string, createdAt: number, costUsd: number | undefined) => ({
  id: id as ThreadId,
  createdAt,
  costUsd,
});

const at = (iso: string) => Date.parse(iso);

const featureIn = (name: string, state: OrchestratorLedger["features"][number]["state"]) => ({
  feature: name,
  state,
  workers: [],
});

const shopBadge = (number: number, state: "OPEN" | "MERGED") =>
  ({
    number,
    state,
    url: `https://github.com/acme/shop/pull/${number}`,
    checks: "passing",
    isDraft: false,
  }) as NonNullable<WorkerFacts["badge"]>;
const shopWorker = (over: Partial<WorkerFacts>, thread: object = {}): WorkerFacts => ({
  thread: {
    id: "w",
    projectId: "p1",
    title: "w",
    parked: false,
    createdAt: 1,
    checkout: { path: "/tmp/w" },
    spawnedBy: { threadId: "orch", feature: "resume" },
    boundPr: { repo: "acme/shop", number: 204, monitor: false },
    ...thread,
  } as unknown as WorkerFacts["thread"],
  project: undefined,
  status: "idle",
  usage: undefined,
  pendingRequests: [],
  completedReason: "prMerged",
  git: { repo: true, changedFiles: 0, origin: "acme/shop" } as NonNullable<WorkerFacts["git"]>,
  badge: shopBadge(204, "MERGED"),
  files: [],
  lastReport: undefined,
  memo: { started: true } as WorkerFacts["memo"],
  extras: [],
  extraBadges: [],
  ...over,
});
const workerOf = (worker: WorkerFacts) => featuresOf([worker])[0]!.workers[0]!;

describe("worker state on the ledger row", () => {
  it("shows a parked worker's request and running turn, and carries the base the board overlays", () => {
    const request = { kind: "approval", ageMin: 0 };
    const asking = workerOf(shopWorker({ pendingRequests: [request] }, { parked: true }));
    expect(asking.state).toBe("needsUser");
    expect(asking.stateBase).toEqual({ state: "merged", parked: true });
    // The board, laying the same row's status over it, lands where the ledger did.
    expect(liveWorkerState(asking)).toBe("needsUser");
    expect(liveWorkerState(asking, { status: "idle", pendingRequestCount: 0 })).toBe("archived");
    expect(workerOf(shopWorker({}, { parked: true })).state).toBe("archived");
    const open = { badge: shopBadge(204, "OPEN"), status: "running" as const };
    expect(workerOf(shopWorker(open, { parked: true })).state).toBe("inReview");
    expect(workerOf(shopWorker({ ...open, status: "idle" }, { parked: true })).state).toBe(
      "archived",
    );
  });
});

describe("quiet worker ledger evidence", () => {
  it("keeps PR state while flagging an unreported stop, and excludes intentional waits", () => {
    const quiet = { kind: "turnEnded", at: 10, lastTool: "Bash" } as const;
    const facts = shopWorker({
      completedReason: undefined,
      badge: shopBadge(204, "OPEN"),
      memo: { started: true, quiet } as WorkerFacts["memo"],
    });
    expect(workerOf(facts)).toMatchObject({ state: "inReview", quiet });
    for (const over of [
      { status: "running" as const },
      { wakes: [{ id: "w", at: 20, note: "continue" }] },
      { memo: { started: true, quiet, reportInTurn: true } as WorkerFacts["memo"] },
      { memo: { started: true, quiet, userIntervened: true } as WorkerFacts["memo"] },
      {
        memo: {
          ...facts.memo!,
          quiet,
          background: [{ kind: "subagent" as const, description: "background" }],
        },
      },
    ])
      expect(workerOf({ ...facts, ...over }).quiet).toBeUndefined();
    for (const monitor of [
      { boundPr: { repo: "acme/shop", number: 204, monitor: false, reviewMonitor: true } },
      { extraPrs: [{ repo: "acme/other", number: 2, monitor: true }] },
      { runWatches: [{ repo: "acme/shop", runId: 12 }] },
    ]) {
      const waiting = { ...facts, thread: { ...facts.thread, ...monitor } } as WorkerFacts;
      expect(workerOf(waiting).quiet).toBeUndefined();
      // An armed monitor doesn't excuse a foreground tool that is actually stalled.
      expect(
        workerOf({ ...waiting, status: "running", quiet: { kind: "toolStalled", at: 11 } }).quiet
          ?.kind,
      ).toBe("toolStalled");
    }
    const stalled = { kind: "toolStalled", at: 11, lastTool: "Bash" } as const;
    expect(workerOf({ ...facts, status: "running", quiet: stalled }).quiet).toEqual(stalled);
    expect(
      workerOf({
        ...facts,
        status: "running",
        quiet: stalled,
        memo: { ...facts.memo!, background: [{ kind: "subagent", description: "background" }] },
      }).quiet,
    ).toEqual(stalled);
    // Compacting streams nothing for a while, and is no stall.
    const compacting = workerOf({ ...facts, status: "running", quiet: stalled, compacting: true });
    expect(compacting).toMatchObject({ compacting: true });
    expect(compacting.quiet).toBeUndefined();
    expect(compactWorkerRow(compacting)).toMatchObject({ status: "running", compacting: true });
    expect(workerOf(facts)).not.toHaveProperty("compacting");
  });
});

const extraIn = (repo: string | undefined) =>
  ({ repo }) as Parameters<typeof canOpenPr>[0]["extras"][number];

/** A PR row's merge intent where a merge was refused on `head`, the badge's head being `abc`. */
const refusedOn = (head: string) =>
  prRow("acme/shop", prBadge({ headRefOid: "abc" }), {
    method: "squash",
    allowedBy: "user",
    setAt: 1,
    failedOn: head,
  }).mergeWhenReady;

describe("a ledger row", () => {
  it("says a worker's worktree is missing only while its git state does", () => {
    const git = { repo: true, changedFiles: 0, origin: "acme/shop" } as NonNullable<
      WorkerFacts["git"]
    >;
    expect(workerOf(shopWorker({ git })).worktreeMissing).toBeUndefined();
    expect(workerOf(shopWorker({ git: { ...git, missing: true } })).worktreeMissing).toBe(true);
  });
});

describe("a ledger PR row", () => {
  it("projects CI and review monitoring onto the exact bound PR", () => {
    for (const binding of [
      { repo: "acme/shop", number: 204, monitor: true },
      { repo: "acme/shop", number: 204, monitor: false, reviewMonitor: true },
    ]) {
      const projected = workerOf(
        shopWorker(
          { completedReason: undefined, badge: shopBadge(204, "OPEN") },
          { boundPr: binding },
        ),
      );
      expect(projected.pr).toMatchObject({ repo: "acme/shop", number: 204, monitored: true });
    }
    expect(
      workerOf(shopWorker({}, { boundPr: { repo: "acme/shop", number: 204, monitor: false } })).pr
        ?.monitored,
    ).toBeUndefined();
  });

  const threads = { unresolved: 0, blockers: 0, suggestions: 0, outdatedUnresolved: 0 };

  it("says who a review waits on, where the bot is, and whether Gram merges it", () => {
    const row = prRow(
      "acme/shop",
      prBadge({
        reviewDecision: "CHANGES_REQUESTED",
        reviewRequests: [{ kind: "team", name: "platform", codeOwner: true }],
        review: {
          bots: ["example-code-review"],
          reviewedHead: false,
          roundInFlight: true,
          threads,
          humanReviews: [
            {
              id: "r1",
              author: "octo",
              verdict: "changesRequested",
              commitOid: "a",
              submittedAt: "",
              body: "",
            },
            {
              id: "r2",
              author: "mona",
              verdict: "approved",
              commitOid: "a",
              submittedAt: "",
              body: "",
            },
          ],
        },
      }),
      { method: "squash", allowedBy: "autonomy", setAt: 1, hold: "after the release" },
    );
    expect(row).toMatchObject({
      reviewDecision: "CHANGES_REQUESTED",
      reviewRequests: [{ kind: "team", name: "platform", codeOwner: true }],
      changesRequestedBy: ["octo"],
      botOnHead: "reviewing",
      mergeWhenReady: { hold: "after the release" },
    });
    const bare = prRow("acme/shop", prBadge({ reviewUnread: true }));
    expect(bare).toMatchObject({ reviewUnread: true });
    for (const key of ["reviewRequests", "changesRequestedBy", "botOnHead", "mergeWhenReady"]) {
      expect(bare).not.toHaveProperty(key);
    }
    const commented = prRow(
      "acme/shop",
      prBadge({ review: { bots: ["b"], reviewedHead: true, roundInFlight: false, threads } }),
      { method: "squash", allowedBy: "user", setAt: 1 },
    );
    expect(commented).toMatchObject({ botOnHead: "reviewed", mergeWhenReady: {} });
    // A merge GitHub refused on this head waits for the next one; on an older head it is history.
    expect(refusedOn("abc")).toEqual({ refused: true });
    expect(refusedOn("old")).toEqual({});
  });

  it("keeps a blocked report standing beside an open PR until the worker is sent something", () => {
    const blocked = {
      threadId: "w" as ThreadId,
      state: "blocked",
      summary: "Sign in.",
      at: 5,
    } as const;
    const open = { completedReason: undefined, badge: shopBadge(204, "OPEN"), lastReport: blocked };
    const row = workerOf(shopWorker(open));
    expect(row.state).toBe("inReview");
    expect(row.reportStands).toBe(true);
    const answered = { started: true, lastInputAt: 6 } as WorkerFacts["memo"];
    expect(workerOf(shopWorker({ ...open, memo: answered }))).not.toHaveProperty("reportStands");
    const progress = { ...blocked, state: "progress" } as const;
    expect(workerOf(shopWorker({ ...open, lastReport: progress }))).not.toHaveProperty(
      "reportStands",
    );
  });
});

describe("the ledger's cost today", () => {
  const DAY = 86_400_000;

  it("adds what each counter grew by, and a new thread's whole cost only when it began today", () => {
    const noon = 10 * DAY + DAY / 2;
    const started = accrueCost(
      emptyOutbox.cost,
      [
        spender("orch", 2 * DAY, 4),
        spender("w1", 10 * DAY + 5, 1.5),
        spender("silent", noon, undefined),
      ],
      noon,
      "UTC",
    );
    expect(started).toEqual({
      day: 10 * DAY,
      date: "1970-01-11",
      usd: 1.5,
      seen: { orch: 4, w1: 1.5 },
    });
    const later = accrueCost(
      started,
      [spender("orch", 2 * DAY, 4.75), spender("w1", 0, 1.5)],
      noon,
      "UTC",
    );
    expect(later.usd).toBeCloseTo(2.25);
    // A counter that went down (a thread forked or reset) adds nothing and becomes the baseline.
    expect(accrueCost(later, [spender("orch", 0, 1)], noon, "UTC")).toMatchObject({
      usd: later.usd,
      seen: { orch: 1 },
    });
  });

  it("starts over at local midnight, keeping the baselines", () => {
    const bucket = { day: 10 * DAY, usd: 9, seen: { orch: 9 } };
    expect(accrueCost(bucket, [spender("orch", 0, 9.5)], 11 * DAY + 1, "UTC")).toEqual({
      day: 11 * DAY,
      date: "1970-01-12",
      usd: 0.5,
      seen: { orch: 9.5 },
    });
  });

  // Today's spend is kept for the calendar day, so a daylight-saving change partway through the day
  // must not discard what has already been accrued. Each bucket is accrued by the code under test,
  // in the zone it names, from a thread created that day.
  describe("across a daylight-saving change or a change of zone", () => {
    it("keeps a non-zero bucket across the spring change in London", () => {
      const before = accrueCost(
        emptyOutbox.cost,
        [spender("orch", at("2026-03-29T00:30:00Z"), 4)],
        at("2026-03-29T00:59:00Z"),
        "Europe/London",
      );
      expect(before.usd).toBe(4);
      const after = accrueCost(
        before,
        [spender("orch", 0, 4.5)],
        at("2026-03-29T01:01:00Z"),
        "Europe/London",
      );
      expect(after).toEqual({
        day: at("2026-03-29T00:00:00Z"),
        date: "2026-03-29",
        usd: 4.5,
        seen: { orch: 4.5 },
      });
    });

    it("keeps a non-zero bucket across the autumn change in London", () => {
      const before = accrueCost(
        emptyOutbox.cost,
        [spender("orch", at("2026-10-24T23:30:00Z"), 4)],
        at("2026-10-25T00:30:00Z"),
        "Europe/London",
      );
      const after = accrueCost(
        before,
        [spender("orch", 0, 4.5)],
        at("2026-10-25T01:30:00Z"),
        "Europe/London",
      );
      expect(after).toEqual({
        day: at("2026-10-24T23:00:00Z"),
        date: "2026-10-25",
        usd: 4.5,
        seen: { orch: 4.5 },
      });
    });

    it("keeps a non-zero bucket when the zone changes within the same calendar day", () => {
      // 12:00 in Oslo is 10:00 in New York, both on 24 September.
      const before = accrueCost(
        emptyOutbox.cost,
        [spender("orch", at("2026-09-24T00:30:00Z"), 4)],
        at("2026-09-24T12:00:00Z"),
        "Europe/Oslo",
      );
      const after = accrueCost(
        before,
        [spender("orch", 0, 4.5)],
        at("2026-09-24T14:00:00Z"),
        "America/New_York",
      );
      expect(after).toEqual({
        day: at("2026-09-24T04:00:00Z"),
        date: "2026-09-24",
        usd: 4.5,
        seen: { orch: 4.5 },
      });
    });

    it("starts over when the zone puts the clock on another calendar day", () => {
      const before = accrueCost(
        emptyOutbox.cost,
        [spender("orch", at("2026-09-24T00:30:00Z"), 4)],
        at("2026-09-24T12:00:00Z"),
        "Europe/Oslo",
      );
      // 02:00 on 25 September in New York.
      const after = accrueCost(
        before,
        [spender("orch", 0, 4.5)],
        at("2026-09-25T06:00:00Z"),
        "America/New_York",
      );
      expect(after).toMatchObject({ date: "2026-09-25", usd: 0.5, seen: { orch: 4.5 } });
    });
  });

  it("rolls a group up to its least advanced feature, listing the ones with no worker yet", () => {
    const stage = { stage: "rc", setBy: "user", setAt: 1 } as const;
    expect(
      groupsOf(
        [
          featureIn("board", "readyToMerge"),
          featureIn("inbox", "blocked"),
          featureIn("x", "error"),
        ],
        {
          release: { features: ["board", "inbox", "not-started"], stage },
          later: { features: ["not-started-either"] },
        },
      ),
    ).toEqual([
      { group: "release", features: ["board", "inbox", "not-started"], state: "blocked", stage },
      { group: "later", features: ["not-started-either"], state: "archived" },
    ]);
    expect(groupsOf([featureIn("board", "working")], undefined)).toEqual([]);
  });

  it("knows a pull request can't be opened only once a git state names no GitHub remote", () => {
    const git = { repo: true } as NonNullable<Parameters<typeof canOpenPr>[0]["git"]>;
    expect(canOpenPr({ git: undefined, extras: [] })).toBe(true);
    expect(canOpenPr({ git: { ...git, origin: "acme/shop" }, extras: [] })).toBe(true);
    expect(canOpenPr({ git, extras: [] })).toBe(false);
    expect(canOpenPr({ git: { ...git, repo: false }, extras: [] })).toBe(false);
    // A worker across repos can open one from any of them.
    expect(canOpenPr({ git, extras: [extraIn(undefined), extraIn("acme/warehouse")] })).toBe(true);
    expect(canOpenPr({ git, extras: [extraIn(undefined)] })).toBe(false);
  });

  it("counts a delivered worker as finished: off the cap, out of overlap, and out of `since`", () => {
    expect(
      WorkerState.literals.filter((state) => !isLiveWorker({ state, status: "idle" })).toSorted(),
    ).toEqual(["archived", "delivered", "merged"]);
    expect(isLiveWorker({ state: "working", status: "ended" })).toBe(false);

    const git = { repo: true, changedFiles: 1 } as NonNullable<WorkerFacts["git"]>;
    const facts = (id: string, over: Partial<WorkerFacts> = {}): WorkerFacts => ({
      thread: {
        id,
        projectId: "p1",
        title: id,
        parked: false,
        createdAt: 1,
        checkout: { path: `/tmp/${id}` },
        spawnedBy: { threadId: "orch", feature: "local" },
      } as unknown as WorkerFacts["thread"],
      project: undefined,
      status: "idle",
      usage: undefined,
      pendingRequests: [],
      completedReason: undefined,
      git,
      badge: undefined,
      files: ["src/cart.ts"],
      lastReport: undefined,
      memo: { started: true } as WorkerFacts["memo"],
      extras: [],
      extraBadges: [],
      ...over,
    });
    const done = { threadId: "a" as ThreadId, state: "done", summary: "Finished.", at: 5 } as const;
    const [feature] = featuresOf([facts("a", { lastReport: done }), facts("b"), facts("c")]);
    expect(feature?.workers.map((w) => [w.threadId, w.state, w.overlapsWith])).toEqual([
      ["a", "delivered", []],
      ["b", "working", ["c"]],
      ["c", "working", ["b"]],
    ]);
    expect(feature?.state).toBe("working");

    const seen = (since: number | undefined) =>
      visibleFeatures([feature!], (id) => (id === "a" ? 10 : 0), {
        includeArchived: false,
        since,
      }).flatMap((f) => f.workers.map((w) => w.threadId));
    expect(seen(undefined)).toEqual(["a", "b", "c"]);
    expect(seen(10)).toEqual(["a", "b", "c"]);
    expect(seen(11)).toEqual(["b", "c"]);
  });

  it("keeps a worker whose first PR merged in review while a second PR in its repo is open", () => {
    expect(workerOf(shopWorker({})).state).toBe("merged");
    // Opened from its branch while still bound to the first.
    const branch = workerOf(
      shopWorker({
        git: { ...shopWorker({}).git!, pr: shopBadge(225, "OPEN") } as WorkerFacts["git"],
      }),
    );
    expect(branch.state).toBe("inReview");
    expect(branch.pr).toMatchObject({ number: 204, state: "merged" });
    expect(branch.morePrs).toEqual([
      expect.objectContaining({ repo: "acme/shop", number: 225, state: "open" }),
    ]);
    // `list_workers` without `detail` keeps them too: they are what it still has to act on.
    expect(compactWorkerRow(branch).morePrs).toEqual(branch.morePrs);
    // Followed beside it in the same repo, before and after its badge lands.
    const followed = { extraPrs: [{ repo: "acme/shop", number: 225, monitor: false }] };
    const unknown = workerOf(shopWorker({}, followed));
    expect(unknown.state).toBe("inReview");
    expect(unknown.morePrs).toEqual([{ repo: "acme/shop", number: 225 }]);
    const both = workerOf(shopWorker({ extraBadges: [shopBadge(225, "MERGED")] }, followed));
    expect(both.state).toBe("merged");
    expect(both.morePrs?.map((pr) => pr.state)).toEqual(["merged"]);
    // Work resumed after both merged: the badges stay, and they're old news.
    const merged = [
      { number: 204, url: "https://github.com/acme/shop/pull/204" },
      { number: 225, url: "https://github.com/acme/shop/pull/225" },
    ];
    const resumed = workerOf(
      shopWorker(
        { completedReason: undefined, extraBadges: [shopBadge(225, "MERGED")] },
        { ...followed, settledMerge: { merged } },
      ),
    );
    expect(resumed.state).toBe("working");
    // The bound PR not looked up yet (after a restart) proves nothing: a merged extra doesn't
    // make it merged.
    const unbadged = workerOf(
      shopWorker(
        { badge: undefined, completedReason: undefined, extraBadges: [shopBadge(225, "MERGED")] },
        followed,
      ),
    );
    expect(unbadged.state).toBe("inReview");
    // A followed PR GitHub says doesn't exist holds nothing open: completed on the merge, it's merged.
    const gone = workerOf(
      shopWorker({ missingPrs: [{ repo: "acme/shop", number: 225 }] }, followed),
    );
    expect(gone.state).toBe("merged");
    // Rebound to another repo's #204 while the old binding's merged badge lingers: unknown too.
    const rebound = workerOf(
      shopWorker(
        { completedReason: undefined },
        { boundPr: { repo: "acme/other", number: 204, monitor: false } },
      ),
    );
    expect(rebound.state).not.toBe("merged");
  });

  it("carries a worker's last error into its row: kind, status and text, not the agent's code", () => {
    const thread = {
      id: "e",
      projectId: "p1",
      title: "e",
      parked: false,
      createdAt: 1,
      checkout: { path: "/tmp/e" },
      spawnedBy: { threadId: "orch", feature: "local" },
      lastError: {
        kind: "gatewayRefused",
        httpStatus: 429,
        code: "responseTooManyFailedAttempts",
        retryable: false,
        text: "Gateway refused the request",
        at: 3,
      },
    } as unknown as WorkerFacts["thread"];
    const [feature] = featuresOf([
      {
        thread,
        project: undefined,
        status: "error",
        usage: undefined,
        pendingRequests: [],
        completedReason: undefined,
        git: undefined,
        badge: undefined,
        files: [],
        lastReport: undefined,
        memo: { started: true } as WorkerFacts["memo"],
        extras: [],
        extraBadges: [],
      },
    ]);
    expect(feature?.workers[0]?.lastError).toEqual({
      kind: "gatewayRefused",
      httpStatus: 429,
      text: "Gateway refused the request",
    });
  });

  it("shows a worker's plan progress with the headline its facts give", () => {
    expect(workerOf(shopWorker({})).plan).toBeUndefined();
    const plan = {
      goal: "Resume upload",
      steps: [
        { id: "a", text: "Store chunks", status: "done", source: "agent" },
        { id: "b", text: "Resume from the last chunk", status: "done", source: "agent" },
        { id: "c", text: "Merge #225", status: "todo", source: "agent" },
      ],
      basis: "",
      updatedAt: 1,
      updatedBy: "agent",
    } as unknown as ThreadPlan;
    const worker = workerOf(
      shopWorker(
        {
          completedReason: undefined,
          git: { ...shopWorker({}).git!, pr: shopBadge(225, "OPEN") } as WorkerFacts["git"],
          badge: shopBadge(225, "OPEN"),
          plan: { plan, turnPlan: undefined },
          now: 2,
        },
        { boundPr: { repo: "acme/shop", number: 225, monitor: false } },
      ),
    );
    expect(worker.plan).toEqual({ done: 2, total: 3, headline: "Waiting on review · #225" });
  });

  it("tells a missing outbox from one it can't read, and reads its own version", () => {
    expect(readOutbox(undefined)).toEqual({ _tag: "absent", state: emptyOutbox });
    expect(readOutbox("{not json")).toMatchObject({ _tag: "unreadable", paths: [[]] });
    expect(
      readOutbox(JSON.stringify({ version: OUTBOX_VERSION, generation: "three" })),
    ).toMatchObject({
      _tag: "unreadable",
      version: OUTBOX_VERSION,
      paths: [["generation"]],
    });
    expect(readOutbox(JSON.stringify({ ...emptyOutbox, version: OUTBOX_VERSION + 1 }))).toEqual({
      _tag: "unreadable",
      state: emptyOutbox,
      version: OUTBOX_VERSION + 1,
      paths: [["version"]],
    });
    const written = encodeOutbox({ ...emptyOutbox, generation: 7 });
    expect(JSON.parse(written)).toMatchObject({ version: OUTBOX_VERSION, generation: 7 });
    expect(decodeOutbox(written).generation).toBe(7);
    expect(readOutbox(JSON.stringify({ ...emptyOutbox, generation: 3 }))).toMatchObject({
      _tag: "unreadable",
      version: undefined,
      paths: [["version"]],
    });
  });
});

describe.skipIf(!hasGit)("git facts", () => {
  it.effect(
    "samples the current branch of an extra worktree, and leaves detached HEAD unowned",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        run(world.repo, "switch", "-q", "-c", "feat/extra-stack");
        expect((yield* extraCheckoutFacts(world.repo)).branch).toBe("feat/extra-stack");
        run(world.repo, "switch", "--detach");
        expect((yield* extraCheckoutFacts(world.repo)).branch).toBeUndefined();
      }).pipe(Effect.provide(ProcLive)),
  );

  it.effect("lists a checkout's changed paths, committed since the base and not", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      run(world.repo, "switch", "-q", "-c", "feat/x");
      fs.writeFileSync(nodePath.join(world.repo, "committed.txt"), "a\n");
      run(world.repo, "add", "-A");
      run(world.repo, "commit", "-qm", "work");
      fs.writeFileSync(nodePath.join(world.repo, "dirty file.txt"), "b\n");
      run(world.repo, "add", "dirty file.txt");
      // Neither a file only deleted from the worktree nor an untracked one can collide.
      fs.rmSync(nodePath.join(world.repo, "tracked.txt"));
      fs.writeFileSync(nodePath.join(world.repo, "scratch.log"), "c\n");
      const changed = yield* changedPaths(world.repo, "main");
      expect(changed.files).toEqual(["committed.txt", "dirty file.txt"]);
      // Each path with what it holds, so two worktrees making the same change can be told apart.
      expect(changed.signatures["committed.txt"]).toMatch(
        new RegExp(` ${createHash("sha1").update("a\n").digest("base64url")}$`),
      );
      // A staged edit whose file was then deleted commits what is staged: two different ones of
      // those are told apart, not both read as the same deletion.
      const stagedThenGone = function* (text: string) {
        fs.writeFileSync(nodePath.join(world.repo, "gone.txt"), text);
        run(world.repo, "add", "gone.txt");
        fs.rmSync(nodePath.join(world.repo, "gone.txt"));
        return (yield* changedPaths(world.repo, "main")).signatures["gone.txt"];
      };
      const first = yield* stagedThenGone("x\n");
      expect(first).toMatch(/ -$/);
      expect(yield* stagedThenGone("y\n")).not.toBe(first);
      run(world.repo, "rm", "-q", "--cached", "gone.txt");
      expect((yield* changedPaths(world.repo, undefined)).files).toEqual(["dirty file.txt"]);
      // A committed link to a device is signed by where it points, never read.
      if (process.platform !== "win32") {
        fs.symlinkSync("/dev/zero", nodePath.join(world.repo, "zero"));
        run(world.repo, "add", "zero");
        const linked = yield* changedPaths(world.repo, "main");
        expect(linked.signatures["zero"]).toMatch(
          new RegExp(` link:${createHash("sha1").update("/dev/zero").digest("base64url")}$`),
        );
      }
      expect(yield* changedPaths(nodePath.join(world.dir, "nowhere"), "main")).toEqual(
        noChangedPaths,
      );
    }).pipe(Effect.provide(ProcLive)),
  );

  it.effect("measures drift as new entries, a moved HEAD, or a dirty file edited again", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const clean = (yield* markRoot(world.repo))!;
      expect(driftBetween(clean, (yield* markRoot(world.repo))!)).toBeUndefined();

      fs.writeFileSync(nodePath.join(world.repo, "tracked.txt"), "one\n");
      fs.writeFileSync(nodePath.join(world.repo, "new.txt"), "n\n");
      const dirty = (yield* markRoot(world.repo))!;
      expect(driftBetween(clean, dirty)).toEqual({ files: 2, headMoved: false });

      fs.writeFileSync(nodePath.join(world.repo, "tracked.txt"), "one, and then some more\n");
      expect(driftBetween(dirty, (yield* markRoot(world.repo))!)).toEqual({
        files: 1,
        headMoved: false,
      });

      run(world.repo, "add", "-A");
      run(world.repo, "commit", "-qm", "own work");
      expect(driftBetween(dirty, (yield* markRoot(world.repo))!)).toEqual({
        files: 2,
        headMoved: true,
      });
      expect(yield* markRoot(nodePath.join(world.dir, "nowhere"))).toBeUndefined();
    }).pipe(Effect.provide(ProcLive)),
  );
});

const upsertSignal = (id: ThreadId, v: number): Signal => ({
  type: "hub",
  event: { type: "thread.upsert", thread: { id, title: String(v) } as never },
});

/** A signal as one line, with the version a test stamped it with. */
const signalLabel = (signal: Signal): string => {
  if (signal.type === "gitState") return `git ${signal.thread.id} ${signal.state.behindBase}`;
  if (signal.type === "contextLow") return `contextLow ${signal.workspaceId}`;
  if (signal.type !== "hub") return signal.type;
  const { event } = signal;
  if (event.type === "thread.upsert") return `upsert ${event.thread.id} ${event.thread.title}`;
  if (event.type === "thread.background")
    return `background ${event.threadId} ${event.tasks[0]?.kind}`;
  return "threadId" in event ? `${event.type} ${event.threadId}` : event.type;
};

describe("orchestration signal queue", () => {
  const [A, B, C] = ["a", "b", "c"] as [ThreadId, ThreadId, ThreadId];
  const W = "w" as WorkspaceId;
  const parked = (on: boolean, v: number): Signal => ({
    type: "hub",
    event: { type: "thread.upsert", thread: { id: A, title: String(v), parked: on } as never },
  });
  const checks = (state: "pending" | "passing", v: number): Signal => ({
    type: "gitState",
    thread: { id: A } as never,
    state: { head: "h", behindBase: v, pr: prBadge({ checks: state }) } as never,
  });

  it.effect("holds one upsert per thread behind a busy consumer, and every removal in order", () =>
    Effect.gen(function* () {
      const signals = yield* makeCoalescingQueue("signals", SIGNAL_COALESCING);
      const burst = (from: number) =>
        Effect.gen(function* () {
          for (let v = from; v < from + 500; v++) {
            for (const id of [A, B, C]) yield* signals.offer(upsertSignal(id, v));
            yield* signals.offer({
              type: "gitState",
              thread: { id: A } as never,
              state: { head: "h", behindBase: v } as never,
            });
            yield* signals.offer({
              type: "hub",
              event: {
                type: "thread.background",
                threadId: B,
                tasks: [{ kind: String(v) }] as never,
              },
            });
            yield* signals.offer({ type: "contextLow", workspaceId: W });
          }
        });
      yield* burst(0);
      yield* signals.offer({
        type: "hub",
        event: { type: "thread.request", threadId: B, request: { id: "r" } as never },
      });
      yield* burst(500);
      for (const threadId of [A, B, C]) {
        yield* signals.offer({ type: "hub", event: { type: "thread.removed", threadId } });
      }
      expect(signals.depth()).toBe(12);

      const taken: Array<string> = [];
      while (signals.depth() > 0) taken.push(signalLabel(yield* signals.take));
      // B's request closed its run: what B sent after it waits behind it, not ahead.
      expect(taken).toEqual([
        "upsert a 999",
        "upsert b 499",
        "upsert c 999",
        "git a 999",
        "background b 499",
        "contextLow w",
        "thread.request b",
        "upsert b 999",
        "background b 999",
        "thread.removed a",
        "thread.removed b",
        "thread.removed c",
      ]);
    }),
  );

  it.effect("queues a change its handler acts on behind the state before it", () =>
    Effect.gen(function* () {
      const signals = yield* makeCoalescingQueue("signals", SIGNAL_COALESCING);
      for (const signal of [
        parked(true, 1),
        parked(true, 2),
        parked(false, 3),
        parked(false, 4),
        checks("pending", 1),
        checks("pending", 2),
        checks("passing", 3),
      ]) {
        yield* signals.offer(signal);
      }
      const taken: Array<string> = [];
      while (signals.depth() > 0) taken.push(signalLabel(yield* signals.take));
      expect(taken).toEqual(["upsert a 2", "upsert a 4", "git a 2", "git a 3"]);
    }),
  );
});

/** A plain thread the user started in a new worktree of `root` on `branch`, idle after one turn. */
const plainInWorktree = (world: World, branch: string, root: string = world.repo) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    const path = nodePath.join(world.dir, `wt-${branch.replaceAll("/", "-")}`);
    run(root, "worktree", "add", "-b", branch, path);
    const thread = yield* runtimes.create({
      projectRoot: root,
      checkout: { kind: "worktree", path, branch, repoRoot: root },
      title: "Fix reopen",
      input: { text: "hello" },
    });
    const session = yield* waitSent(thread.id, 1);
    yield* completeTurn(session);
    return { thread, session, path };
  });

/** A second workspace over `world.repo` with its orchestrator open, booted and idle, at `publish`. */
const openSecondWorkspace = (name: string) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const orchestration = yield* Orchestration;
    const [project] = yield* store.listProjects;
    const state = yield* orchestration.saveWorkspace({
      name,
      projectIds: [project!.id],
      homeProjectId: project!.id,
      charter: { ...DEFAULT_CHARTER, autonomy: "publish" },
    });
    const thread = yield* orchestration.open({ workspaceId: state.workspace.id });
    const session = yield* waitSent(thread.id, 1);
    yield* completeTurn(session);
    return { thread, session, workspaceId: state.workspace.id };
  });

describe.skipIf(!hasGit)("joining a workspace", () => {
  it.effect(
    "adds a plain thread as a worker: named from its branch, its PR followed, told and delegated",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration;
          const { thread: orchestrator, workspaceId } = yield* openOrchestrator(world);
          const plain = yield* plainInWorktree(world, "fix/reopen-tabs");
          // Its PR as the publisher already knows it, before it is anybody's worker.
          yield* publishGit(world, plain.thread, { branch: "fix/reopen-tabs", pr: prBadge() });

          const joined = yield* orchestration.joinWorkspace(plain.thread.id, workspaceId, {});
          expect(joined.spawnedBy).toEqual({ threadId: orchestrator.id, feature: "reopen-tabs" });
          expect(joined.workspaceId).toBe(workspaceId);
          expect(joined.ownedBranches).toEqual([{ path: plain.path, branch: "fix/reopen-tabs" }]);
          expect(yield* orchestration.isDelegated(orchestrator.id, plain.thread.id)).toBe(true);
          yield* settle;
          const [feature] = (yield* orchestration.ledger(workspaceId)).features;
          expect(feature?.feature).toBe("reopen-tabs");
          expect(feature?.workers[0]).toMatchObject({
            threadId: plain.thread.id,
            pr: { number: 12 },
          });

          // Its session reopens as a worker's, with the worker's prompt.
          const reopened = yield* waitReal(
            "the worker's session",
            sessionsOf(plain.thread.id).pipe(Effect.map((sessions) => sessions[1])),
          );
          expect(reopened.options).toMatchObject({ audience: "worker" });
          expect(reopened.options.instructions).toContain("reopen-tabs");

          // The orchestrator is told who joined and that it never briefed it.
          yield* TestClock.adjust("60 seconds");
          const told = yield* waitSent(orchestrator.id, 2);
          expect(told.sent[1]!.text).toContain(
            `The user added "Fix reopen" [thread ${plain.thread.id}] in shop`,
          );
          expect(told.sent[1]!.text).toContain("You didn't brief it");

          const again = yield* orchestration
            .joinWorkspace(plain.thread.id, workspaceId, {})
            .pipe(Effect.flip);
          expect(again).toMatchObject({ _tag: "InvalidState" });
          expect(again.message).toContain("already a worker of this workspace");
        }),
      ),
  );

  it.effect(
    "restarts a joining Codex thread onto a fresh app-server, as a connector change does",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const fake = yield* FakeAgentControl;
          const orchestration = yield* Orchestration;
          const { thread: orchestrator, workspaceId } = yield* openOrchestrator(world);
          // Below `full`, a Codex worker off a gateway profile couldn't hold the gate: refused.
          yield* atAutonomy(orchestrator, "full");
          const plain = yield* plainInWorktree(world, "fix/codex");
          yield* store.updateThread(plain.thread.id, (t) => ({
            ...t,
            model: { agent: "codex", model: "gpt-5.5" } as ModelRef,
          }));
          const before = fake.configReloads.filter((reload) => reload === "codex:*").length;
          yield* orchestration.joinWorkspace(plain.thread.id, workspaceId, {});
          // A loaded Codex thread ignores new instructions on `thread/resume`; a reload alone would
          // leave it on the plain thread's prompt and connectors.
          expect(fake.configReloads.filter((reload) => reload === "codex:*").length).toBe(
            before + 1,
          );
        }),
      ),
  );

  it.effect(
    "names the repos joining adds, an extra worktree's in a project opened through a symlink too",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const orchestration = yield* Orchestration;
          const { thread: orchestrator, workspaceId } = yield* openOrchestrator(world);
          const root = makeRepo(nodePath.join(world.dir, "other"));
          const link = nodePath.join(world.dir, "warehouse-link");
          // A junction on Windows, which needs no privilege; ignored elsewhere.
          fs.symlinkSync(root, link, "junction");
          yield* store.ensureProject({ root: link, name: "warehouse" });
          const extra = nodePath.join(world.dir, "wt-extra");
          run(root, "worktree", "add", "-b", "fix/stock", extra);
          const plain = yield* plainInWorktree(world, "fix/both");
          // As git records it: the main checkout's resolved path, not the spelling it was opened by.
          yield* store.updateThread(plain.thread.id, (t) => ({
            ...t,
            extraCheckouts: [
              {
                kind: "worktree",
                path: extra,
                branch: "fix/stock",
                repoRoot: fs.realpathSync(root),
              },
            ],
          }));

          expect(yield* orchestration.joinTargets(plain.thread.id)).toEqual([
            { workspaceId, name: "shop", adds: ["warehouse"] },
          ]);
          const refused = yield* orchestration
            .joinWorkspace(plain.thread.id, workspaceId, {})
            .pipe(Effect.flip);
          expect(refused.message).toContain(`warehouse isn't one of the "shop" workspace's repos`);
          yield* orchestration.joinWorkspace(plain.thread.id, workspaceId, { addRepos: true });
          // A worker's own workspace is no target; an orchestrator has none.
          expect(yield* orchestration.joinTargets(plain.thread.id)).toEqual([]);
          expect(yield* orchestration.joinTargets(orchestrator.id)).toEqual([]);
        }),
      ),
    GIT_HEAVY,
  );

  it.effect(
    "refuses an orchestrator, a main checkout, a workspace without one, and a repo outside unless asked",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const orchestration = yield* Orchestration;
          const runtimes = yield* ThreadRuntimes;
          const { project, thread: orchestrator, workspaceId } = yield* openOrchestrator(world);
          const message = (threadId: ThreadId, target: WorkspaceId, addRepos?: boolean) =>
            orchestration
              .joinWorkspace(threadId, target, addRepos === undefined ? {} : { addRepos })
              .pipe(
                Effect.flip,
                Effect.map((e) => e.message),
              );

          expect(yield* message(orchestrator.id, workspaceId)).toContain(
            "An orchestrator can't be added to a workspace",
          );
          const main = yield* runtimes.create({
            projectRoot: world.repo,
            checkout: { kind: "main", path: world.repo },
          });
          expect(yield* message(main.id, workspaceId)).toContain("main checkout");
          const spare = yield* orchestration.saveWorkspace({
            name: "spare",
            projectIds: [project.id],
            homeProjectId: project.id,
          });
          const plain = yield* plainInWorktree(world, "fix/one");
          expect(yield* message(plain.thread.id, spare.workspace.id)).toContain(
            'The "spare" workspace has no orchestrator open',
          );

          // A thread in a repo outside the workspace joins it only with the user's yes to the repo.
          const root = makeRepo(nodePath.join(world.dir, "other"));
          const other = yield* store.ensureProject({ root, name: "warehouse" });
          const outside = yield* plainInWorktree(world, "fix/stock", root);
          expect(yield* message(outside.thread.id, workspaceId)).toContain(
            `warehouse isn't one of the "shop" workspace's repos`,
          );
          const joined = yield* orchestration.joinWorkspace(outside.thread.id, workspaceId, {
            addRepos: true,
          });
          expect(joined.projectId).toBe(other.id);
          expect((yield* store.getWorkspace(workspaceId)).workspace.projectIds).toContain(other.id);
          expect((yield* store.getThread(orchestrator.id)).additionalDirectories).toEqual([root]);
        }),
      ),
    GIT_HEAVY,
  );

  it.effect(
    "moves a worker between workspaces with its PR binding, its hold and its pending wake",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const orchestration = yield* Orchestration;
          const a = yield* openOrchestrator(world);
          const b = yield* openSecondWorkspace("second");
          const worker = yield* spawn(a.session, { feature: "mail" });
          yield* completeTurn(worker.session);
          yield* worker.session.callTool("schedule_wake", { inMinutes: 30, note: "check CI" });
          yield* store.updateThread(worker.thread.id, (t) => ({
            ...t,
            boundPr: { repo: "acme/shop", number: 12, monitor: false, reviewMonitor: true },
          }));
          // The user wrote to it, so it is theirs, in whichever workspace it is.
          yield* (yield* ThreadRuntimes).send(worker.thread.id, { text: "Use the v2 endpoint." });
          yield* completeTurn(worker.session);
          const held = (yield* outboxOf(a.workspaceId)).workers[worker.thread.id];
          expect(held?.userIntervened).toBe(true);
          expect((yield* outboxOf(a.workspaceId)).wakes).toHaveLength(1);

          const moved = yield* orchestration.joinWorkspace(worker.thread.id, b.workspaceId, {});
          expect(moved.spawnedBy).toEqual({ threadId: b.thread.id, feature: "mail" });
          expect(moved.workspaceId).toBe(b.workspaceId);
          expect(moved.boundPr).toMatchObject({ number: 12, reviewMonitor: true });
          expect(yield* orchestration.isDelegated(a.thread.id, worker.thread.id)).toBe(false);
          expect(yield* orchestration.isDelegated(b.thread.id, worker.thread.id)).toBe(true);
          yield* settle;
          expect((yield* orchestration.ledger(a.workspaceId)).features).toEqual([]);
          expect(
            (yield* orchestration.ledger(b.workspaceId)).features.map((f) => f.feature),
          ).toEqual(["mail"]);

          // The wake went with it, and what it remembered there, but not A's messages to it.
          const left = yield* outboxOf(a.workspaceId);
          const joined = yield* outboxOf(b.workspaceId);
          expect(left.wakes ?? []).toEqual([]);
          expect(left.workers[worker.thread.id]).toBeUndefined();
          expect(left.liveRemovals).toMatchObject([
            { threadId: worker.thread.id, action: "moved" },
          ]);
          expect(joined.wakes).toMatchObject([{ threadId: worker.thread.id, note: "check CI" }]);
          expect(joined.workers[worker.thread.id]).toEqual({ ...held, messages: 0 });

          // Each orchestrator hears its side.
          yield* TestClock.adjust("60 seconds");
          const toA = yield* waitSent(a.thread.id, 2);
          expect(toA.sent[1]!.text).toContain(
            `Worker [thread ${worker.thread.id}] was moved to another workspace while live`,
          );
          const toB = yield* waitSent(b.thread.id, 2);
          expect(toB.sent[1]!.text).toContain(
            `The user moved "Build mail" [thread ${worker.thread.id}] in shop from the "shop" workspace`,
          );
          yield* completeTurn(toA);
          yield* completeTurn(toB);

          // Armed again in B, the wake reaches the worker there.
          yield* TestClock.adjust("30 minutes");
          yield* waitReal(
            "the wake in the new workspace",
            sessionsOf(worker.thread.id).pipe(
              Effect.map((sessions) =>
                sessions.some((s) => s.sent.some((input) => input.text.includes("check CI"))),
              ),
            ),
          );
        }),
      ),
    GIT_HEAVY,
  );

  it.effect(
    "adopt_thread always asks, says what it crosses, and moves a thread into the worktree it made",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const runtimes = yield* ThreadRuntimes;
          const registry = yield* AppToolRegistry;
          const orchestration = yield* Orchestration;
          const { session, thread: orchestrator, workspaceId } = yield* openOrchestrator(world);
          const tool = registry
            .forThread(orchestrator.id, "orchestrator")
            .find((t) => t.descriptor.name === "adopt_thread")!;

          // The real case: a thread in the main checkout made a worktree with its shell.
          const main = yield* runtimes.create({
            projectRoot: world.repo,
            checkout: { kind: "main", path: world.repo },
            title: "Reopen fix",
          });
          const path = nodePath.join(world.dir, "wt-shell");
          run(world.repo, "worktree", "add", "-b", "fix/reopen", path);
          const input = { threadId: main.id, worktree: path };
          expect(yield* tool.needsApproval!(input)).toBe(true);
          expect(yield* tool.describe!(input)).toBe(
            `Take “Reopen fix” on as a worker of the "shop" workspace, for reopen, moving it into ${path}`,
          );
          const refused = yield* session
            .callTool("adopt_thread", { threadId: main.id })
            .pipe(Effect.flip);
          expect(refused.message).toContain("not_joinable: It works in the repo's main checkout");

          // What runs is what the card named: a worktree swapped meanwhile for another repo's, or
          // another branch, is refused rather than taken on.
          const pinned = yield* orchestration.pinAdopt(orchestrator.id, input);
          expect(pinned).toMatchObject({ branch: "fix/reopen", worktree: path, outside: {} });
          const swapped = yield* orchestration
            .adoptThread(orchestrator.id, { ...input, pinned: { ...pinned, branch: "feat/x" } })
            .pipe(Effect.flip);
          expect(swapped.message).toContain("changed after the user was asked");
          // Another folder put at the same path, as a shell could, is not the one asked about.
          const elsewhere = yield* orchestration
            .adoptThread(orchestrator.id, { ...input, pinned: { ...pinned, folder: "0:0" } })
            .pipe(Effect.flip);
          expect(elsewhere.message).toContain("changed after the user was asked");
          // So is a branch the shell switched to while the card waited, which git sees at once.
          run(path, "checkout", "-q", "-b", "fix/other");
          const switched = yield* orchestration
            .adoptThread(orchestrator.id, { ...input, pinned })
            .pipe(Effect.flip);
          expect(switched.message).toContain("changed after the user was asked");
          // And a detached HEAD, which is no branch at all, whatever the record still says.
          run(path, "checkout", "-q", "--detach");
          const detached = yield* orchestration
            .adoptThread(orchestrator.id, { ...input, pinned })
            .pipe(Effect.flip);
          expect(detached.message).toContain("changed after the user was asked");
          run(path, "checkout", "-q", "fix/reopen");
          const unpinned = yield* orchestration
            .adoptThread(orchestrator.id, input)
            .pipe(Effect.flip);
          expect(unpinned.message).toContain("changed after the user was asked");
          expect((yield* store.getThread(main.id)).spawnedBy).toBeUndefined();

          const adopted = yield* session.callTool("adopt_thread", input);
          expect(adopted).toMatchObject({ threadId: main.id, feature: "reopen", worktree: path });
          const now = yield* store.getThread(main.id);
          expect(now.checkout).toMatchObject({ kind: "worktree", path, branch: "fix/reopen" });
          expect(now.spawnedBy).toEqual({ threadId: orchestrator.id, feature: "reopen" });

          // Paused, nothing is taken on; and an orchestrator is never taken on.
          const other = yield* plainInWorktree(world, "fix/two");
          yield* orchestration.setPaused(workspaceId, true);
          const paused = yield* session
            .callTool("adopt_thread", { threadId: other.thread.id })
            .pipe(Effect.flip);
          expect(paused.message).toContain("paused:");
          yield* orchestration.setPaused(workspaceId, false);
          const self = yield* session
            .callTool("adopt_thread", { threadId: orchestrator.id })
            .pipe(Effect.flip);
          expect(self.message).toContain("An orchestrator can't be added");
        }),
      ),
    GIT_HEAVY,
  );
});

describe("merged publisher ledger", () => {
  it("keeps execution, report and pending release-run evidence independent of PR merge", () => {
    const runWatches = [{ repo: "acme/shop", runId: 41, name: "artifact verification", since: 1 }];
    const facts = shopWorker(
      {
        lastReport: {
          threadId: "w" as ThreadId,
          state: "done",
          summary: "Version PR merged; verification pending",
          at: 1,
        },
      },
      { runWatches },
    );
    const worker = workerOf(facts);
    expect(worker).toMatchObject({ state: "merged", status: "idle", runWatches });
    expect(isLiveWorker(worker)).toBe(true);
    expect(compactWorkerRow(worker).runWatches).toEqual(runWatches);
    expect(isLiveWorker(workerOf(shopWorker({})))).toBe(false);
    expect(isLiveWorker({ ...worker, state: "archived" })).toBe(false);
  });
});

it("applies workspace overlap exclusions to ledger rows without changing file counts", () => {
  const a = shopWorker({
    completedReason: undefined,
    badge: undefined,
    files: ["package.json", "bun.lock"],
  });
  const b = { ...a, thread: { ...a.thread, id: "w2" as ThreadId } };
  expect(featuresOf([a, b])[0]?.workers[0]).toMatchObject({
    overlapsWith: ["w2"],
    overlapFiles: ["package.json"],
    changedFiles: 2,
  });
  expect(
    featuresOf([a, b], {
      charter: { ...DEFAULT_CHARTER, overlapIgnorePaths: ["package.json", "bun.lock"] },
    })[0]?.workers[0],
  ).toMatchObject({ overlapsWith: [], changedFiles: 2 });
});

describe("local gate visibility in the ledger", () => {
  it("shows an unconfigured project as OFF, never passed", () => {
    const project = { id: "p-1" as never, root: "/invented", name: "shop", bookmarked: false };
    expect(workerOf(shopWorker({ project })).localGate).toBe(
      "no local check configured for shop; local gate OFF — CI and GitHub rules apply",
    );
    expect(
      workerOf(shopWorker({ project: { ...project, localCheck: { command: "make test" } } }))
        .localGate,
    ).toBeUndefined();
  });
});
