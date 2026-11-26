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
  groupChoices,
  groupNames,
  hiddenWorkerCount,
  edgeBesidePrs,
  nowBesidePrs,
  overlapHint,
  lineStage,
  pickIn,
  railRows,
  railTone,
  rowsInGroup,
  stageBehind,
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

describe("the Board's groups", () => {
  it("draws a line's own stage, else its group's, with what moving it sets", () => {
    const own = plan("merge", ["build", "merge"]);
    const whole = plan("ship", ["merge", "ship"]);
    const groups: Record<string, FeatureGroup> = { release: { features: ["api"], stage: whole } };
    expect(lineStage({ feature: "api", group: "release" }, { api: own }, groups)).toEqual({
      stage: own,
      target: { feature: "api" },
    });
    expect(lineStage({ feature: "api", group: "release" }, {}, groups)).toEqual({
      stage: whole,
      target: { group: "release" },
    });
    expect(lineStage({ feature: "api", group: undefined }, {}, groups)).toBeUndefined();
    expect(lineStage({ feature: "api", group: "spike" }, undefined, groups)).toBeUndefined();
  });

  it("calls a stage behind once the line has reported since it was set", () => {
    expect(stageBehind({ setAt: 100 }, 200)).toBe(true);
    expect(stageBehind({ setAt: 200 }, 100)).toBe(false);
    expect(stageBehind({ setAt: 100 }, undefined)).toBe(false);
  });

  it("offers a choice per group with a line, in the lines' order, and none without a group", () => {
    const rows = railRows(
      [
        grouped("solo", undefined),
        grouped("notes", "release"),
        grouped("lint", "cleanup"),
        grouped("api", "release"),
      ],
      facts(),
    );
    const choices = groupChoices(rows);
    expect(choices).toEqual({
      groups: [
        { group: "release", count: 2 },
        { group: "cleanup", count: 1 },
      ],
      ungrouped: 1,
    });
    expect(rowsInGroup(rows, { group: "release" }).map((row) => row.feature)).toEqual([
      "notes",
      "api",
    ]);
    expect(rowsInGroup(rows, "ungrouped").map((row) => row.feature)).toEqual(["solo"]);
    expect(rowsInGroup(rows, undefined)).toBe(rows);
    // No line in a group: no filter to draw.
    expect(groupChoices(railRows([grouped("solo", undefined)], facts()))).toEqual({
      groups: [],
      ungrouped: 0,
    });
  });

  it("gives every line back when the picked group's last line leaves", () => {
    const choices = { groups: [{ group: "release", count: 1 }], ungrouped: 0 };
    expect(pickIn(choices, { group: "release" })).toEqual({ group: "release" });
    expect(pickIn(choices, { group: "cleanup" })).toBeUndefined();
    expect(pickIn(choices, "ungrouped")).toBeUndefined();
  });

  it("lists every group a feature can move to, the workspace's first", () => {
    expect(
      groupNames({ release: { features: [] } }, [{ group: "spike" }, {}, { group: "release" }]),
    ).toEqual(["release", "spike"]);
    expect(groupNames(undefined, [])).toEqual([]);
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

  it("keeps a line while its worker runs, but drops a missing worker despite a stale ask", () => {
    const going = worker("c", { title: "Release notes", state: "inReview", station: "review" });
    const cards = [card("closed", [going])];
    const over = new Map<ThreadId, boolean>();
    expect(railRows(cards, facts())[0]?.settled).toBe(false);
    expect(railRows(cards, { ...facts(), over })[0]?.settled).toBe(true);
    expect(railRows(cards, { ...facts([], { c: "running" }), over })[0]?.settled).toBe(false);
    expect(railRows(cards, { ...facts(["c"]), over })[0]?.settled).toBe(true);
    expect(boardRows(railRows(cards, { ...facts(["c"]), over }), false)).toEqual([]);
    expect(
      railRows(cards, { ...facts(["c"]), over: new Map([["c" as ThreadId, true]]) })[0]?.settled,
    ).toBe(false);
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
    expect(nowBesidePrs("merge of #142", own)).toBe("merge");
    expect(nowBesidePrs("local check #142", own)).toBe("local check");
    expect(nowBesidePrs("merge of #1420", own)).toBe("merge of #1420");
    expect(nowBesidePrs("Waiting · #88 to merge", own)).toBe("Waiting · #88 to merge");
    expect(nowBesidePrs("checks on #1420", own)).toBe("checks on #1420");
    expect(nowBesidePrs("running tests", [])).toBe("running tests");
  });
});

describe("edgeBesidePrs", () => {
  it("drops an edge whose token is a PR the chip beside it shows, and keeps any other", () => {
    const own = [{ number: 142 }];
    expect(edgeBesidePrs({ glyph: "ci", token: "#142" }, own)).toBeUndefined();
    expect(edgeBesidePrs({ glyph: "dependency", token: "#88" }, own)).toEqual({
      glyph: "dependency",
      token: "#88",
    });
    expect(edgeBesidePrs({ glyph: "ci", token: "#1420" }, own)?.token).toBe("#1420");
    expect(edgeBesidePrs({ glyph: "timer", token: "08:10" }, own)?.token).toBe("08:10");
    expect(edgeBesidePrs({ glyph: "ci", token: "#142" }, [])?.token).toBe("#142");
  });
});
