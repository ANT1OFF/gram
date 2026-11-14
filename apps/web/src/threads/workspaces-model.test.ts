import type { ThreadSummary } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import {
  emptyWords,
  lastWorkByWorkspace,
  outsideLine,
  prsByWorkspace,
  repositoriesLine,
  workspaceFactWords,
} from "./workspaces-model";

const NOW = Date.UTC(2026, 10, 13, 12);
const DAY = 24 * 60 * 60 * 1000;
const PROJECT = { noun: "Project", plural: "Projects" };

const thread = (id: string, workspaceId: string | undefined, lastActivityAt = NOW) =>
  ({ thread: { id, workspaceId, lastActivityAt } }) as unknown as ThreadSummary;

const words = (facts: Parameters<typeof workspaceFactWords>[0]) =>
  workspaceFactWords(facts, NOW).map((fact) => fact.words);

describe("workspaceFactWords", () => {
  it("says what waits, what runs and what is open", () => {
    expect(words({ asks: 1, working: 1, prs: 1 })).toEqual([
      "1 waits on you",
      "1 worker running",
      "1 pull request open",
    ]);
    expect(words({ asks: 2, working: 4, prs: 3 })).toEqual([
      "2 wait on you",
      "4 workers running",
      "3 pull requests open",
    ]);
  });

  it("says nothing runs, and when it last worked", () => {
    expect(words({ asks: 0, working: 0, prs: 0, lastWorkAt: NOW - 2 * DAY })).toEqual([
      "Nothing running",
      "Last work 2 days ago",
    ]);
    expect(words({ asks: 0, working: 0, prs: 0 })).toEqual(["Nothing running"]);
  });

  it("says since when a paused one is paused, in place of Nothing running", () => {
    expect(words({ asks: 0, working: 0, prs: 0, pausedAt: NOW - 3 * DAY })).toEqual([
      "Paused 3 days ago",
    ]);
    // A worker finishing its step under a pause is still counted.
    expect(words({ asks: 0, working: 1, prs: 0, pausedAt: NOW - 3 * DAY })).toEqual([
      "Paused 3 days ago",
      "1 worker running",
    ]);
  });

  it("marks only what waits on you", () => {
    expect(
      workspaceFactWords({ asks: 1, working: 1, prs: 0 }, NOW).map((fact) => fact.tone),
    ).toEqual(["asks", undefined]);
  });
});

describe("prsByWorkspace", () => {
  it("counts each workspace's threads' pull requests, and none without an owner in one", () => {
    const byId = {
      a: thread("a", "w1"),
      b: thread("b", "w1"),
      c: thread("c", "w2"),
      s: thread("s", undefined),
    };
    const rows = [
      { owner: "a" },
      { owner: "b" },
      { owner: "c" },
      { owner: "s" },
      {},
      { owner: "gone" },
    ];
    expect([...prsByWorkspace(rows as never, byId)]).toEqual([
      ["w1", 2],
      ["w2", 1],
    ]);
  });
});

describe("lastWorkByWorkspace", () => {
  it("keeps each workspace's latest activity", () => {
    const latest = lastWorkByWorkspace([
      thread("a", "w1", 5),
      thread("b", "w1", 9),
      thread("c", "w2", 3),
      thread("s", undefined, 99),
    ]);
    expect([...latest]).toEqual([
      ["w1", 9],
      ["w2", 3],
    ]);
  });
});

describe("repositoriesLine", () => {
  it("names every repository it knows, in the workspace's order", () => {
    const names = new Map([
      ["p1", "gram"],
      ["p2", "docs"],
    ]);
    expect(repositoriesLine(["p2", "p1", "p9"], names)).toBe("docs, gram");
    expect(repositoriesLine([], names)).toBe("");
  });
});

describe("outsideLine", () => {
  it("counts the threads in no workspace, in the app's word for one", () => {
    expect(outsideLine({ total: 9, running: 2 }, PROJECT)).toBe(
      "9 threads outside a project, 2 running.",
    );
    expect(outsideLine({ total: 1, running: 0 }, { noun: "Area", plural: "Areas" })).toBe(
      "1 thread outside an area.",
    );
  });

  it("says nothing with none", () => {
    expect(outsideLine({ total: 0, running: 0 }, PROJECT)).toBeUndefined();
  });
});

describe("emptyWords", () => {
  it("says what one is, in the app's word", () => {
    const empty = emptyWords(PROJECT);
    expect(empty.title).toBe("No project yet");
    expect(empty.line).toMatch(/^A project is an orchestrator and its workers/);
    expect(emptyWords({ noun: "Area", plural: "Areas" }).line).toMatch(/^An area is/);
  });
});
