import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  EVENT_BUDGET,
  FEATURE_STATIONS,
  FeatureCard,
  FeatureCards,
  StreamEventKind,
  cardShown,
  cardStationOf,
  currentSummary,
  featureCardOf,
  featureCardsText,
  mergeFeatureCards,
  nowLineOf,
  reconcileFeatureCards,
  reportGist,
  requestGist,
  sinceYouLeftOf,
  stationFlag,
  stationOf,
  streamLinesOf,
  type FeatureCardFacts,
  type FeatureStation,
} from "./feature-cards.ts";
import type { ThreadId, WorkspaceId } from "./ids.ts";
import type {
  DigestChange,
  FeatureLedgerEntry,
  HeldBrief,
  OrchestrationDigest,
  WorkerLedgerEntry,
  WorkerPr,
} from "./orchestration.ts";
import { WorkerState } from "./orchestration.ts";
import { expectRoundTrip } from "./test-utils.ts";

const W = "w-1" as WorkspaceId;
const A = "t-a" as ThreadId;
const B = "t-b" as ThreadId;

const worker = (patch: Partial<WorkerLedgerEntry> = {}): WorkerLedgerEntry => ({
  feature: "mail-trigger",
  projectId: "p-api" as WorkerLedgerEntry["projectId"],
  project: "api",
  threadId: A,
  title: "Queue worker",
  state: "working",
  status: "idle",
  pendingRequests: [],
  changedFiles: 3,
  overlapsWith: [],
  userIntervened: false,
  messagesFromOrchestrator: 0,
  ...patch,
});

const pr = (patch: Partial<WorkerPr> = {}): WorkerPr => ({
  repo: "acme/api",
  number: 212,
  state: "open",
  checks: "pending",
  url: "https://github.com/acme/api/pull/212",
  ...patch,
});

const feature = (
  workers: ReadonlyArray<WorkerLedgerEntry>,
  patch: Partial<FeatureLedgerEntry> = {},
): FeatureLedgerEntry => ({
  feature: "mail-trigger",
  state: workers[0]?.state ?? "briefed",
  workers,
  ...patch,
});

const facts = (
  features: ReadonlyArray<FeatureLedgerEntry>,
  patch: Partial<FeatureCardFacts> = {},
): FeatureCardFacts => ({
  workspaceId: W,
  features,
  models: new Map([[A, "claude-opus-5-5"]]),
  activity: new Map(),
  spawnedAt: new Map([
    [A, 1_000],
    [B, 2_000],
  ]),
  now: 10_000,
  ...patch,
});

describe("stationOf", () => {
  const cases: ReadonlyArray<readonly [string, Partial<WorkerLedgerEntry>, FeatureStation]> = [
    ["briefed", { state: "briefed" }, "briefed"],
    ["working", { state: "working" }, "working"],
    ["question", { state: "question" }, "working"],
    ["needsUser", { state: "needsUser" }, "working"],
    ["blocked", { state: "blocked" }, "working"],
    ["inReview, checks pending", { state: "inReview", pr: pr({ checks: "pending" }) }, "checks"],
    ["inReview, checks failing", { state: "inReview", pr: pr({ checks: "failing" }) }, "checks"],
    [
      "inReview, failing required checks with others passing",
      { state: "inReview", pr: pr({ checks: "failing (not required: passing)" }) },
      "checks",
    ],
    [
      "inReview, checks green awaiting merge",
      { state: "inReview", pr: pr({ checks: "passing" }) },
      "review",
    ],
    ["inReview, no checks", { state: "inReview", pr: pr({ checks: "none" }) }, "review"],
    [
      "inReview, held",
      {
        state: "inReview",
        pr: pr({ checks: "passing", mergeWhenReady: { hold: "after #209" } }),
      },
      "review",
    ],
    ["readyToMerge", { state: "readyToMerge", pr: pr({ checks: "passing" }) }, "review"],
    ["done with an open PR still checking", { state: "done", pr: pr() }, "checks"],
    ["done without a PR", { state: "done" }, "review"],
    ["delivered", { state: "delivered" }, "merged"],
    ["merged", { state: "merged", pr: pr({ state: "merged", checks: "passing" }) }, "merged"],
  ];
  it.each(cases)("%s", (_name, patch, station) => {
    expect(stationOf(worker(patch))).toBe(station);
  });

  it("covers every worker state", () => {
    for (const state of WorkerState.literals) {
      expect(FEATURE_STATIONS).toContain(stationOf(worker({ state })));
    }
  });

  it("keeps an errored worker at its station and flags it", () => {
    const failed = worker({ state: "error", pr: pr({ checks: "passing" }) });
    expect(stationOf(failed, "checks")).toBe("checks");
    expect(stationFlag(failed)).toBe("error");
    // Without a previous card, its PR says where it got to.
    expect(stationOf(failed)).toBe("review");
    expect(stationOf(worker({ state: "error" }))).toBe("working");
    expect(stationFlag(worker({ state: "working" }))).toBeUndefined();
  });

  it("puts a card at its least advanced live worker, parked ones aside", () => {
    expect(
      cardStationOf([
        { station: "review", state: "inReview" },
        { station: "working", state: "working" },
      ]),
    ).toBe("working");
    expect(
      cardStationOf([
        { station: "review", state: "inReview" },
        { station: "briefed", state: "archived" },
      ]),
    ).toBe("review");
    expect(cardStationOf([{ station: "checks", state: "archived" }])).toBe("checks");
    expect(cardStationOf([])).toBe("briefed");
  });
});

describe("now line", () => {
  it("is four words or fewer, deterministic, from reports, requests or the tool call", () => {
    const lines = [
      nowLineOf(worker({ status: "running" }), "Running uv run pytest tests/queue"),
      nowLineOf(worker({ status: "running" }), "Editing src/queue/consumer.py"),
      nowLineOf(
        worker({
          state: "needsUser",
          pendingRequests: [
            { kind: "approval", ageMin: 1, summary: "Bash: git push -u origin feat" },
          ],
        }),
      ),
      nowLineOf(worker({ state: "needsUser", pendingRequests: [{ kind: "question", ageMin: 0 }] })),
      nowLineOf(
        worker({
          lastReport: {
            threadId: A,
            state: "progress",
            summary: "Backoff is in. Running the suite; 38 of 52 so far.",
            at: 1,
          },
        }),
      ),
      nowLineOf(worker({ state: "inReview", pr: pr({ checks: "failing" }) })),
      nowLineOf(worker({ state: "merged", pr: pr({ state: "merged" }) })),
      nowLineOf(worker({ state: "error" })),
      nowLineOf(worker({ quiet: { kind: "turnEnded", at: 1, lastTool: "Bash" } })),
    ];
    expect(lines).toEqual([
      "running tests",
      "editing code",
      "wants to push",
      "asks you",
      "tests 38/52",
      "checks failing",
      "merged as #212",
      "stopped on an error",
      "stopped after Bash",
    ]);
    for (const line of lines) expect(line.split(/\s+/).length).toBeLessThanOrEqual(4);
  });

  it("prefers a reported test count to the tool's kind while tests run", () => {
    const running = worker({
      status: "running",
      lastReport: { threadId: A, state: "progress", summary: "Suite at 38/52", at: 1 },
    });
    expect(nowLineOf(running, "Running uv run pytest")).toBe("tests 38/52");
    expect(nowLineOf(running, "Editing src/a.ts")).toBe("editing code");
  });

  it("scans long punctuation runs in reports without retrying every suffix", () => {
    const punctuation = "!".repeat(100_000);
    const started = performance.now();
    expect(reportGist(`Done${punctuation}x`)).toBe(`done${punctuation}x`);
    expect(reportGist(`Done${punctuation}`)).toBe("done");
    expect(reportGist(punctuation)).toBe("reported");
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("caps a long report to four words", () => {
    expect(reportGist("Rewrote the whole retry policy around the dead letter queue")).toBe(
      "rewrote the whole retry…",
    );
    expect(requestGist({ kind: "approval", summary: "Bash: gh pr merge 212" })).toBe(
      "wants to merge",
    );
    expect(requestGist({ kind: "approval", summary: "Edit: src/a.ts" })).toBe("wants approval");
  });
});

describe("versioning", () => {
  it("makes a feature's first card version 1, placed at its first spawn", () => {
    const { cards, changed } = reconcileFeatureCards([], facts([feature([worker()])]));
    expect(changed).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      workspaceId: W,
      feature: "mail-trigger",
      station: "working",
      version: 1,
      createdAt: 1_000,
      updatedAt: 10_000,
      workers: [
        {
          threadId: A,
          title: "Queue worker",
          project: "api",
          model: "claude-opus-5-5",
          station: "working",
          now: "idle",
          prs: [],
        },
      ],
    });
    expectRoundTrip(FeatureCard, cards[0]!);
  });

  it("keeps the version while nothing it shows changes, and grows it by one when something does", () => {
    const first = reconcileFeatureCards([], facts([feature([worker()])]));
    const same = reconcileFeatureCards(first.cards, facts([feature([worker()])], { now: 20_000 }));
    expect(same.changed).toEqual([]);
    expect(same.cards[0]).toBe(first.cards[0]);

    const moved = reconcileFeatureCards(
      first.cards,
      facts([feature([worker({ state: "inReview", pr: pr() })])], { now: 30_000 }),
    );
    expect(moved.changed).toHaveLength(1);
    expect(moved.cards[0]).toMatchObject({
      version: 2,
      station: "checks",
      createdAt: 1_000,
      updatedAt: 30_000,
    });
    expect(moved.cards[0]!.workers[0]!.prs).toEqual([
      {
        repo: "acme/api",
        number: 212,
        url: "https://github.com/acme/api/pull/212",
        state: "open",
        checks: "pending",
      },
    ]);
  });

  it("has a now line change the card (a new version), not a second card", () => {
    const first = reconcileFeatureCards([], facts([feature([worker({ status: "running" })])]));
    const next = reconcileFeatureCards(
      first.cards,
      facts([feature([worker({ status: "running" })])], {
        activity: new Map([[A, "Running bun run test"]]),
      }),
    );
    expect(next.cards).toHaveLength(1);
    expect(next.cards[0]).toMatchObject({ version: 2, workers: [{ now: "running tests" }] });
  });

  it("keeps a card whose feature left the ledger as it last was", () => {
    const first = reconcileFeatureCards([], facts([feature([worker()])]));
    const gone = reconcileFeatureCards(first.cards, facts([]));
    expect(gone.changed).toEqual([]);
    expect(gone.cards).toEqual(first.cards);
  });

  it("names overlap on both workers' lines from the ledger's advisory overlap", () => {
    const { cards } = reconcileFeatureCards(
      [],
      facts([
        feature([
          worker({ overlapsWith: [B], overlapFiles: ["queue/retry.py"] }),
          worker({
            threadId: B,
            title: "Rate limit",
            overlapsWith: [A],
            overlapFiles: ["queue/retry.py"],
          }),
        ]),
      ]),
    );
    expect(cards[0]!.workers.map((each) => [each.overlapsWith, each.overlapFiles])).toEqual([
      [[B], ["queue/retry.py"]],
      [[A], ["queue/retry.py"]],
    ]);
  });

  it("keeps an errored worker on the station its previous card had", () => {
    const first = reconcileFeatureCards(
      [],
      facts([feature([worker({ state: "inReview", pr: pr({ checks: "failing" }) })])]),
    );
    const failed = reconcileFeatureCards(
      first.cards,
      facts([feature([worker({ state: "error", pr: pr({ checks: "passing" }) })])]),
    );
    expect(failed.cards[0]!.workers[0]).toMatchObject({ station: "checks", flag: "error" });
  });

  it("carries a helper summary forward but shows it only for the version it was written for", () => {
    const [card] = reconcileFeatureCards([], facts([feature([worker()])])).cards;
    const summarized = { ...card!, summary: { text: "Queue worker is starting.", version: 1 } };
    expect(currentSummary(summarized)).toBe("Queue worker is starting.");
    const next = featureCardOf(
      feature([worker({ state: "inReview", pr: pr() })]),
      summarized,
      facts([]),
    );
    expect(next.version).toBe(2);
    expect(next.summary).toEqual(summarized.summary);
    expect(currentSummary(next)).toBeUndefined();
  });

  it("lets a newer card replace an older one, never the other way", () => {
    const v1 = reconcileFeatureCards([], facts([feature([worker()])]));
    const v2 = reconcileFeatureCards(
      v1.cards,
      facts([feature([worker({ state: "inReview", pr: pr() })])]),
    );
    const newer = { workspaceId: W, cards: v2.cards };
    const older = { workspaceId: W, cards: v1.cards };
    expect(mergeFeatureCards(older, newer).cards[0]!.version).toBe(2);
    expect(mergeFeatureCards(newer, older)).toBe(newer);
    expectRoundTrip(FeatureCards, newer);
  });

  it("compares cards by what they say, not by key order", () => {
    const [card] = reconcileFeatureCards([], facts([feature([worker()])])).cards;
    const reordered = Schema.decodeUnknownSync(FeatureCard)(
      JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(card!).toReversed()))),
    );
    expect(featureCardsText([reordered])).toBe(featureCardsText([card!]));
    expect(reconcileFeatureCards([reordered], facts([feature([worker()])])).changed).toEqual([]);
  });
});

const brief = (patch: Partial<HeldBrief> = {}): HeldBrief => ({
  id: "h-1",
  feature: "docs-refresh",
  title: "Refresh the docs",
  project: "api",
  agent: "codex",
  window: "fiveHour",
  usedPct: 85,
  until: 50_000,
  heldAt: 5_000,
  ...patch,
});

describe("held briefs", () => {
  it("gives a feature with only held briefs a card at briefed, with no workers", () => {
    const { cards, changed } = reconcileFeatureCards(
      [],
      facts([feature([worker()])], { held: [brief()] }),
    );
    expect(changed).toHaveLength(2);
    const held = cards.find((card) => card.feature === "docs-refresh");
    expect(held).toMatchObject({
      station: "briefed",
      workers: [],
      version: 1,
      createdAt: 5_000,
      held: [
        {
          id: "h-1",
          title: "Refresh the docs",
          project: "api",
          agent: "codex",
          window: "fiveHour",
          usedPct: 85,
          until: 50_000,
        },
      ],
    });
    expectRoundTrip(FeatureCard, held!);
  });

  it("puts a held brief on the card of a feature that has workers, soonest release first", () => {
    const { cards } = reconcileFeatureCards(
      [],
      facts([feature([worker()])], {
        held: [
          brief({ id: "late", feature: "mail-trigger", until: 90_000 }),
          brief({ id: "soon", feature: "mail-trigger", until: 40_000 }),
        ],
      }),
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]!.workers).toHaveLength(1);
    expect(cards[0]!.held?.map((each) => each.id)).toEqual(["soon", "late"]);
  });

  it("drops the held line, in a new version, once the brief is released", () => {
    const first = reconcileFeatureCards([], facts([], { held: [brief()] }));
    const released = reconcileFeatureCards(
      first.cards,
      facts([
        feature([worker({ feature: "docs-refresh", state: "briefed" })], {
          feature: "docs-refresh",
        }),
      ]),
    );
    expect(released.cards[0]).toMatchObject({ version: 2, station: "briefed" });
    expect(released.cards[0]!.held).toBeUndefined();
    expect(released.cards[0]!.workers).toHaveLength(1);

    // Released and gone before it spawned (refused at the reset, say): the card says so too.
    const lapsed = reconcileFeatureCards(first.cards, facts([], { now: 60_000 }));
    expect(lapsed.changed).toHaveLength(1);
    expect(lapsed.cards[0]).toMatchObject({ version: 2, updatedAt: 60_000, workers: [] });
    expect(lapsed.cards[0]!.held).toBeUndefined();
    // And stays put after that.
    expect(reconcileFeatureCards(lapsed.cards, facts([])).changed).toEqual([]);
    // With no worker and no held brief left, it is drawn nowhere; the others are.
    expect(lapsed.cards.map(cardShown)).toEqual([false]);
    expect(first.cards.map(cardShown)).toEqual([true]);
    expect(released.cards.map(cardShown)).toEqual([true]);
  });
});

const digest = (
  generation: number,
  patch: Partial<OrchestrationDigest> = {},
): OrchestrationDigest => ({
  kind: "orchestration",
  variant: "digest",
  generation,
  workspaceId: W,
  workspaceName: "agent-platform",
  reasons: [],
  changes: [],
  reports: [],
  features: [],
  budget: { liveWorkers: 1, maxConcurrentWorkers: 4, costUsdToday: 0 },
  notes: [],
  ...patch,
});

const change = (to: WorkerState, from?: WorkerState, threadId: ThreadId = A): DigestChange => ({
  threadId,
  feature: "mail-trigger",
  title: threadId === A ? "Queue worker" : "Rate limit",
  ...(from === undefined ? {} : { from }),
  to,
});

describe("event budget", () => {
  it("sorts every event kind into card, line or silent", () => {
    for (const kind of StreamEventKind.literals) {
      expect(["card", "line", "silent"]).toContain(EVENT_BUDGET[kind]);
    }
  });

  it("lets merges, failures and asks speak; wakes and stage moves never reach the stream", () => {
    expect(EVENT_BUDGET.merged).toBe("line");
    expect(EVENT_BUDGET.error).toBe("line");
    expect(EVENT_BUDGET.checksFailing).toBe("line");
    expect(EVENT_BUDGET.needsUser).toBe("line");
    expect(EVENT_BUDGET.question).toBe("line");
    expect(EVENT_BUDGET.wake).toBe("silent");
    expect(EVENT_BUDGET.stage).not.toBe("line");
    expect(EVENT_BUDGET.working).not.toBe("line");
    expect(EVENT_BUDGET.inReview).not.toBe("line");
  });

  it("turns a digest into one line per speaking event and nothing for the rest", () => {
    const merged = worker({ state: "merged", pr: pr({ state: "merged", number: 431 }) });
    const lines = streamLinesOf(
      digest(2, {
        reasons: ["wake: check on the suite", "stage set"],
        changes: [
          change("merged", "readyToMerge"),
          change("working", "briefed", B),
          change("needsUser", "working", "t-c" as ThreadId),
        ],
        features: [feature([merged])],
      }),
      undefined,
    );
    expect(lines.map((line) => [line.kind, line.threadId, line.words, line.pr?.number])).toEqual([
      ["merged", A, "merged", 431],
      ["ask", "t-c", "waits on you", undefined],
    ]);
  });

  it("says checks failing once, on the digest where they turned", () => {
    const passing = digest(1, {
      features: [feature([worker({ state: "inReview", pr: pr({ checks: "pending" }) })])],
    });
    const failing = digest(2, {
      features: [feature([worker({ state: "inReview", pr: pr({ checks: "failing" }) })])],
    });
    const still = digest(3, { features: failing.features });
    expect(streamLinesOf(failing, passing).map((line) => line.words)).toEqual(["checks fail"]);
    expect(streamLinesOf(still, failing)).toEqual([]);
  });

  it("keeps owned CI quiet while away, and speaks when the worker stops without reporting", () => {
    const monitored = worker({ state: "inReview", pr: pr({ checks: "failing", monitored: true }) });
    const pending = digest(1, {
      features: [feature([{ ...monitored, pr: { ...monitored.pr!, checks: "pending" } }])],
    });
    const owned = digest(2, { features: [feature([monitored])] });
    const stopped = digest(3, {
      features: [feature([{ ...monitored, quiet: { kind: "turnEnded", at: 3 } }])],
    });
    expect(streamLinesOf(owned, pending)).toEqual([]);
    expect(streamLinesOf(stopped, owned).map((line) => line.words)).toEqual(["checks fail"]);
    expect(
      sinceYouLeftOf(
        [
          { digest: pending, at: 1 },
          { digest: owned, at: 2 },
        ],
        0,
      ),
    ).toBeUndefined();
  });

  it("keeps a shared PR quiet while any live worker owns its failing CI", () => {
    const twin = worker({ threadId: B, state: "inReview", pr: pr({ checks: "pending" }) });
    const owner = worker({ state: "inReview", pr: pr({ checks: "pending", monitored: true }) });
    const pending = digest(1, { features: [feature([twin, owner])] });
    const failed = digest(2, {
      features: [
        feature([
          { ...twin, pr: { ...twin.pr!, checks: "failing" } },
          { ...owner, pr: { ...owner.pr!, checks: "failing" } },
        ]),
      ],
    });
    expect(streamLinesOf(failed, pending)).toEqual([]);
  });

  it("stays silent for a wake that moved nothing", () => {
    expect(streamLinesOf(digest(4, { reasons: ["wake: 30 min"] }), digest(3))).toEqual([]);
  });
});

const at = (minutes: number) => minutes * 60_000;

describe("since you left", () => {
  it("folds the digests delivered while away into merges, failures, asks and a quiet count", () => {
    const before = digest(1, {
      features: [feature([worker({ state: "inReview", pr: pr({ checks: "pending" }) })])],
    });
    const away = digest(2, {
      variant: "away",
      reasons: ["while you were away"],
      changes: [change("merged", "inReview"), change("error", "working", B)],
      features: [
        feature([
          worker({ state: "merged", pr: pr({ state: "merged" }) }),
          worker({ threadId: B, title: "Rate limit", state: "error" }),
        ]),
      ],
    });
    const later = digest(3, {
      reasons: ["wake"],
      changes: [change("working", "error", B)],
      features: [
        feature([
          worker({ state: "merged", pr: pr({ state: "merged" }) }),
          worker({
            threadId: B,
            title: "Rate limit",
            state: "needsUser",
            pendingRequests: [{ kind: "approval", ageMin: 2 }],
          }),
        ]),
      ],
      waiting: { open: 2, kinds: [{ kind: "decision", count: 2 }] },
    });
    const result = sinceYouLeftOf(
      [
        { digest: before, at: at(10) },
        { digest: away, at: at(30) },
        { digest: later, at: at(40) },
        // A redelivery of the same generation is folded once.
        { digest: later, at: at(41) },
      ],
      at(20),
    );
    expect(result).toMatchObject({
      from: at(30),
      to: at(40),
      merged: [{ threadId: A, pr: { number: 212 } }],
      failed: [{ threadId: B, words: "stopped on an error" }],
      recovered: [B],
      asksWaiting: 3,
    });
    expect(result!.quiet).toBeGreaterThan(0);
  });

  it("is absent before a first look, and when nothing spoke while away", () => {
    const quiet = digest(2, { reasons: ["wake"], changes: [change("working", "briefed")] });
    expect(sinceYouLeftOf([{ digest: quiet, at: 5 }], undefined)).toBeUndefined();
    expect(sinceYouLeftOf([{ digest: quiet, at: 5 }], 1)).toBeUndefined();
    expect(sinceYouLeftOf([{ digest: quiet, at: 5 }], 10)).toBeUndefined();
  });
});
