import type {
  FeatureCard,
  FeatureCardWorker,
  FeatureGroup,
  FeatureStage,
  ThreadId,
  ThreadStatus,
  WorkspaceId,
} from "@gram/contracts";
import { describe, expect, it } from "vitest";

import {
  boardRows,
  groupFolded,
  groupFoldKey,
  groupNames,
  hiddenWorkerCount,
  nowBesidePrs,
  overlapHint,
  railEntries,
  railRows,
  railTone,
  type RailFacts,
} from "./rail-model";

const ws = "ws-1" as WorkspaceId;

const worker = (id: string, over: Partial<FeatureCardWorker> = {}): FeatureCardWorker => ({
  threadId: id as ThreadId,
  title: id,
  project: "api",
  state: "working",
  station: "working",
  now: "editing code",
  prs: [],
  overlapsWith: [],
  overlapFiles: [],
  ...over,
});

const card = (feature: string, workers: FeatureCardWorker[], createdAt = 1): FeatureCard => ({
  workspaceId: ws,
  feature,
  station: "briefed",
  version: 1,
  workers,
  createdAt,
  updatedAt: createdAt,
});

const facts = (asking: string[] = [], status: Record<string, ThreadStatus> = {}): RailFacts => ({
  asking: new Set(asking as ThreadId[]),
  status: (id) => status[id],
});

describe("railRows", () => {
  it("keeps a feature with only a held brief on the board, unfinished, with the brief to draw", () => {
    const held = {
      id: "held-1",
      title: "Refresh docs",
      project: "docs",
      agent: "codex",
      window: "fiveHour" as const,
      usedPct: 85,
      until: 5_000,
    };
    const rows = railRows(
      [
        { ...card("docs-refresh", []), held: [held] },
        card("gone", [worker("a", { state: "archived" })]),
        { ...card("done", [worker("b", { state: "merged", station: "merged" })]), held: [held] },
      ],
      facts(),
    );
    expect(rows.map((row) => row.feature)).toEqual(["docs-refresh", "done"]);
    expect(rows[0]).toMatchObject({ held: [held], finished: false, reach: 0, projects: ["docs"] });
    // A merged line with a brief still held isn't done.
    expect(rows[1]?.finished).toBe(false);
  });

  it("puts each worker on the station its card gives it, and draws the line to the furthest", () => {
    const cards = [
      card("mail-trigger", [
        worker("queue"),
        worker("endpoint", { station: "review", state: "inReview", project: "web" }),
        worker("schema", { station: "merged", state: "merged" }),
      ]),
    ];
    // With finished work shown, the merged one too.
    const [row] = railRows(cards, facts(), "all");
    expect(row?.cells.working.map((w) => w.threadId)).toEqual(["queue"]);
    expect(row?.cells.review.map((w) => w.threadId)).toEqual(["endpoint"]);
    expect(row?.cells.merged.map((w) => w.threadId)).toEqual(["schema"]);
    expect(row?.cells.briefed).toEqual([]);
    expect(row?.reach).toBe(4);
    expect(row?.projects).toEqual(["api", "web"]);
    expect(row?.finished).toBe(false);
    // Hidden, the merged one is in Done, as the sidebar has it, and the line reaches Review.
    const [going] = railRows(cards, facts());
    expect(going?.cells.merged).toEqual([]);
    expect(going?.reach).toBe(3);
    expect(going?.settled).toBe(false);
  });

  it("leaves archived workers off the line, and a feature with only those off the board", () => {
    const rows = railRows(
      [
        card("gone", [worker("a", { state: "archived" })]),
        card("kept", [worker("b"), worker("c", { state: "archived", station: "review" })]),
      ],
      facts(),
    );
    expect(rows.map((row) => row.feature)).toEqual(["kept"]);
    expect(rows[0]?.reach).toBe(1);
  });

  it("keeps the cards' order with finished lines last", () => {
    const rows = railRows(
      [
        card("done", [worker("a", { state: "merged", station: "merged" })], 1),
        card("first", [worker("b")], 2),
        card("second", [worker("c", { station: "briefed", state: "briefed" })], 3),
      ],
      facts(),
    );
    expect(rows.map((row) => row.feature)).toEqual(["first", "second", "done"]);
    expect(rows.at(-1)?.finished).toBe(true);
  });

  it("marks a worker with an open ask, and its feature, as needing you", () => {
    const [row] = railRows([card("f", [worker("a"), worker("b")])], facts(["b"]));
    expect(row?.cells.working.map((w) => w.tone)).toEqual(["idle", "needs"]);
    expect(row?.needs).toBe(true);
  });

  it("names the workers an advisory overlap is with", () => {
    const [row] = railRows(
      [
        card("f", [
          worker("a", { title: "Queue", overlapsWith: ["b" as ThreadId], overlapFiles: ["q.ts"] }),
        ]),
        card("g", [worker("b", { title: "Retry" })]),
      ],
      facts(),
    );
    const [a] = row?.cells.working ?? [];
    expect(a?.overlaps).toEqual(["Retry"]);
    expect(overlapHint(a!)).toBe("Shares files with Retry: q.ts");
    expect(overlapHint({ overlaps: [], overlapFiles: [] })).toBeUndefined();
  });

  it("tells a live turn and a wait on automation from attention and idle", () => {
    const rows = railRows(
      [
        card("f", [
          worker("a"),
          worker("b", { state: "merged", station: "merged" }),
          worker("c"),
          worker("d"),
          worker("e"),
        ]),
      ],
      { ...facts([], { a: "running" }), activity: { c: "automation", d: "attention", e: "idle" } },
    );
    expect(rows[0]?.cells.working.map((each) => each.tone)).toEqual([
      "working",
      "waiting",
      "attention",
      "idle",
    ]);
  });
});

describe("railTone", () => {
  it("says an ask or a failure before whether it runs", () => {
    expect(railTone(worker("a", { state: "question" }), facts())).toBe("needs");
    expect(railTone(worker("a", { flag: "error", state: "error" }), facts())).toBe("error");
    expect(railTone(worker("a", { state: "delivered" }), facts())).toBe("merged");
    expect(railTone(worker("a"), facts([], { a: "running" }))).toBe("working");
    expect(railTone(worker("a"), facts([], { a: "needsApproval" }))).toBe("needs");
    expect(railTone(worker("a"), facts([], { a: "idle" }))).toBe("idle");
  });

  it("says a worker answered here is on its way back to work while the server still has it waiting", () => {
    const answered = { ...facts([], { a: "needsInput" }), answered: new Set(["a" as ThreadId]) };
    expect(railTone(worker("a", { state: "needsUser" }), answered)).toBe("working");
    expect(railTone(worker("a", { state: "question" }), answered)).toBe("working");
    // An ask of its still in the stack (a second one) still needs you.
    expect(railTone(worker("a"), { ...answered, asking: new Set(["a" as ThreadId]) })).toBe(
      "needs",
    );
    // Another worker isn't answered by it.
    expect(railTone(worker("b", { state: "needsUser" }), answered)).toBe("needs");
  });
});

describe("archived work", () => {
  const cards = [
    card("gone", [worker("a", { state: "archived", station: "merged" })]),
    card("kept", [worker("b"), worker("c", { state: "archived", station: "review" })]),
  ];

  it("counts the archived workers the lines leave out", () => {
    expect(hiddenWorkerCount(cards, boardRows(railRows(cards, facts()), false))).toBe(2);
  });

  it("puts them back as finished when shown", () => {
    const rows = railRows(cards, facts(), "all");
    expect(rows.map((row) => row.feature)).toEqual(["kept", "gone"]);
    expect(rows[1]).toMatchObject({ finished: true, state: "archived" });
    expect(rows[0]?.cells.review.map((w) => [w.threadId, w.tone])).toEqual([["c", "merged"]]);
    // Still going, as its least advanced worker is.
    expect(rows[0]).toMatchObject({ finished: false, state: "working" });
  });
});

const plan = (stage: string, steps: string[]): FeatureStage => ({
  plan: steps,
  stage,
  setBy: "orchestrator",
  setAt: 1,
});

const grouped = (
  feature: string,
  group: string | undefined,
  over: Partial<FeatureCardWorker> = {},
) => ({
  ...card(feature, [worker(`${feature}-w`, over)]),
  ...(group === undefined ? {} : { group }),
});

const staged = (current: string) => ({
  ...card("f", [worker("a", { state: "merged", station: "merged" })]),
  stage: { plan: ["merge", "verify", "publish"], current },
});

describe("railEntries", () => {
  it("deals lines into bands in the workspace's order, ungrouped lines after, finished bands last", () => {
    const groups: Record<string, FeatureGroup> = {
      release: { features: ["notes", "api"], stage: plan("merge", ["build", "merge", "ship"]) },
      cleanup: { features: ["lint"] },
    };
    const rows = railRows(
      [
        grouped("api", "release"),
        grouped("solo", undefined),
        grouped("lint", "cleanup", { state: "merged", station: "merged" }),
        grouped("notes", "release", { state: "inReview", station: "review" }),
        grouped("adhoc", "spike"),
      ],
      facts(),
    );
    const entries = railEntries(rows, groups);
    expect(
      entries.map((entry) =>
        entry.kind === "line" ? entry.row.feature : `[${entry.group.group}]`,
      ),
    ).toEqual(["[release]", "[spike]", "solo", "[cleanup]"]);
    // The ungrouped line carries a heading of its own, not reading as the band's above it.
    expect(entries[2]).toMatchObject({ kind: "line", headed: true });
    const [release] = entries;
    expect(release?.kind === "group" && release.group).toMatchObject({
      // Its features in the order they joined; its state its least advanced line's.
      rows: [{ feature: "notes" }, { feature: "api" }],
      state: "working",
      stage: { stage: "merge" },
      finished: false,
    });
    expect(entries.at(-1)).toMatchObject({ kind: "group", group: { finished: true } });
  });

  it("gives ungrouped lines no heading with no band above them", () => {
    const rows = railRows([grouped("solo", undefined), grouped("adhoc", undefined)], facts());
    expect(railEntries(rows, {})).toEqual(rows.map((row) => ({ kind: "line", row })));
    // A finished band below them doesn't need one either: its own band heads it.
    const done = railRows(
      [grouped("solo", undefined), grouped("lint", "cleanup", { state: "merged" })],
      facts(),
    );
    expect(railEntries(done, {})[0]).toEqual({ kind: "line", row: done[0] });
  });

  it("heads only the first ungrouped line under a band", () => {
    const rows = railRows(
      [grouped("api", "release"), grouped("solo", undefined), grouped("adhoc", undefined)],
      facts(),
    );
    const entries = railEntries(rows, {});
    expect(entries[1]).toMatchObject({ row: { feature: "solo" }, headed: true });
    expect(entries[2]).toEqual({ kind: "line", row: rows[2] });
  });

  it("puts a band's finished lines after those still going", () => {
    const rows = railRows(
      [
        grouped("shipped", "release", { state: "merged", station: "merged" }),
        grouped("going", "release"),
      ],
      facts(),
    );
    const [band] = railEntries(rows, { release: { features: ["shipped", "going"] } });
    expect(band?.kind === "group" && band.group.rows.map((row) => row.feature)).toEqual([
      "going",
      "shipped",
    ]);
  });

  it("keeps a band with no line only while its plan has steps to come", () => {
    const groups: Record<string, FeatureGroup> = {
      planned: { features: ["gone"], stage: plan("fix", ["review", "fix", "release"]) },
      over: { features: ["old"], stage: plan("release", ["review", "release"]) },
      bare: { features: ["older"] },
    };
    const entries = railEntries([], groups);
    expect(entries).toEqual([
      {
        kind: "group",
        group: {
          group: "planned",
          state: undefined,
          stage: groups["planned"]!.stage,
          rows: [],
          finished: false,
        },
      },
    ]);
  });

  it("lists every group a feature can move to, the workspace's first", () => {
    expect(
      groupNames({ release: { features: [] } }, [{ group: "spike" }, {}, { group: "release" }]),
    ).toEqual(["release", "spike"]);
    expect(groupNames(undefined, [])).toEqual([]);
  });

  it("folds a band: listed folds one going, opens one finished", () => {
    expect(groupFoldKey("w-1", { group: "release", finished: false })).toBe(
      "board:w-1/group:release",
    );
    expect(groupFoldKey("w-1", { group: "release", finished: true })).toBe(
      "board:w-1/finished:release",
    );
    expect(groupFolded({ finished: false }, false)).toBe(false);
    expect(groupFolded({ finished: false }, true)).toBe(true);
    expect(groupFolded({ finished: true }, false)).toBe(true);
    expect(groupFolded({ finished: true }, true)).toBe(false);
  });
});

describe("a line still going", () => {
  const merged = worker("a", { state: "merged", station: "merged" });

  it("isn't finished while the ledger sees its merged worker at work", () => {
    const ongoing = { ...facts(), ongoing: new Set(["a" as ThreadId]) };
    expect(railRows([card("f", [merged])], ongoing)[0]?.finished).toBe(false);
    expect(railRows([card("f", [merged])], facts())[0]?.finished).toBe(true);
  });

  it("isn't finished while its plan has steps to come", () => {
    expect(railRows([staged("verify")], facts())[0]?.finished).toBe(false);
    expect(railRows([staged("publish")], facts())[0]?.finished).toBe(true);
  });
});

describe("lines that leave the Board", () => {
  const merged = worker("m", { state: "merged", station: "merged" });
  const closed = worker("c", { title: "Release notes", state: "done", station: "review" });

  it("drops a finished line, and one whose workers the ledger no longer has, unless shown", () => {
    const cards = [
      card("shipped", [merged]),
      card("closed", [closed]),
      card("going", [worker("g")]),
    ];
    const live = { ...facts(), over: new Map([["g" as ThreadId, false]]) };
    const rows = railRows(cards, live);
    expect(rows.map((row) => [row.feature, row.settled])).toEqual([
      ["closed", true],
      ["going", false],
      ["shipped", true],
    ]);
    expect(boardRows(rows, false).map((row) => row.feature)).toEqual(["going"]);
    expect(boardRows(rows, true).map((row) => row.feature)).toEqual(["closed", "going", "shipped"]);
    expect(hiddenWorkerCount(cards, boardRows(rows, false))).toBe(2);
  });

  it("keeps a line the ledger no longer has while its worker runs or asks, or by its card before it is read", () => {
    const going = worker("c", { title: "Release notes", state: "inReview", station: "review" });
    const cards = [card("closed", [going])];
    const over = new Map<ThreadId, boolean>();
    expect(railRows(cards, facts())[0]?.settled).toBe(false);
    expect(railRows(cards, { ...facts(), over })[0]?.settled).toBe(true);
    expect(railRows(cards, { ...facts([], { c: "running" }), over })[0]?.settled).toBe(false);
    expect(railRows(cards, { ...facts(["c"]), over })[0]?.settled).toBe(false);
    expect(
      railRows(cards, { ...facts(), running: new Set(["c" as ThreadId]), over })[0]?.settled,
    ).toBe(false);
    // Before the ledger is read, a card that says its work is over has it leave too.
    expect(railRows([card("closed", [closed])], facts())[0]?.settled).toBe(true);
  });

  it("keeps a worker that reported done while it has a PR open or something pending, as the sidebar does", () => {
    const cards = [card("reported", [closed])];
    expect(
      railRows(cards, { ...facts(), over: new Map([["c" as ThreadId, false]]) })[0],
    ).toMatchObject({
      settled: false,
      title: "Release notes",
    });
    expect(
      railRows(cards, { ...facts(), over: new Map([["c" as ThreadId, true]]) })[0]?.settled,
    ).toBe(true);
  });

  it("drops a closed worker's line even with its plan unfinished, as the overview does", () => {
    const stalled = {
      ...card("release", [closed]),
      stage: { plan: ["build", "rc", "ship"], current: "rc" },
    };
    const [row] = railRows([stalled], { ...facts(), over: new Map<ThreadId, boolean>() });
    expect(row).toMatchObject({ finished: false, settled: true });
  });

  it("names a line by its worker's title, by its feature with several or none", () => {
    expect(railRows([card("closed", [closed])], facts())[0]?.title).toBe("Release notes");
    const pair = card("mail-trigger", [worker("queue", { title: "Queue" }), worker("form")]);
    expect(railRows([pair], facts())[0]?.title).toBe("mail-trigger");
    // One of them in Done: the line draws one, named by it.
    const one = card("mail-trigger", [worker("queue", { title: "Queue" }), { ...closed }]);
    expect(railRows([one], facts())[0]?.title).toBe("Queue");
    const held = {
      id: "held-1",
      title: "Refresh docs",
      project: "docs",
      agent: "codex",
      window: "fiveHour" as const,
      usedPct: 85,
      until: 5_000,
    };
    const onlyHeld = { ...card("docs", []), held: [held] };
    expect(railRows([onlyHeld], facts())[0]?.title).toBe("Refresh docs");
  });
});

describe("nowBesidePrs", () => {
  it("leaves out a PR the cell beside it names, and keeps any other", () => {
    const own = [{ number: 142 }];
    expect(nowBesidePrs("Waiting · checks on #142", own)).toBe("Waiting · checks");
    expect(nowBesidePrs("Waiting · #142 to merge", own)).toBe("Waiting · to merge");
    expect(nowBesidePrs("#142 to merge", own)).toBe("to merge");
    expect(nowBesidePrs("Waiting · #88 to merge", own)).toBe("Waiting · #88 to merge");
    expect(nowBesidePrs("checks on #1420", own)).toBe("checks on #1420");
    expect(nowBesidePrs("running tests", [])).toBe("running tests");
  });
});
