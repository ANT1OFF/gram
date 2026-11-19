import type { ThreadId } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { boardClashes, boardPeople, ownersText, rowsFor, sharedBoard } from "./board-people";
import type { RailRow, RailWorker } from "./rail-model";

// Whose work the Board shows: a line is for each person its workers work for, the Board says so
// only when that is more than one person, and a clash is two people's workers on the same files.

const id = (name: string) => name as ThreadId;

const row = (
  feature: string,
  workers: ReadonlyArray<{
    id: string;
    person?: string;
    tone?: RailWorker["tone"];
    overlaps?: string[];
  }>,
): RailRow =>
  ({
    feature,
    title: feature,
    card: {
      workers: workers.map((worker) => ({
        threadId: id(worker.id),
        title: worker.id,
        overlapsWith: (worker.overlaps ?? []).map(id),
        overlapFiles: worker.overlaps === undefined ? [] : ["host/ownership.ts"],
        ...(worker.person === undefined ? {} : { startedBy: worker.person }),
      })),
    },
    cells: {
      briefed: [],
      working: workers.map((worker) => ({
        threadId: id(worker.id),
        title: worker.id,
        now: "running",
        tone: worker.tone ?? "working",
      })),
      checks: [],
      review: [],
      merged: [],
    },
  }) as unknown as RailRow;

const resume = row("resume", [{ id: "w-resume", person: "ada", overlaps: ["w-owners"] }]);
const owners = row("owners", [{ id: "w-owners", person: "grace", overlaps: ["w-resume"] }]);
const phone = row("phone", [
  { id: "w-list", person: "grace" },
  { id: "w-sheet", person: "ada", tone: "needs" },
]);
const names = {
  you: "ada",
  people: [
    { id: "ada", name: "Ada" },
    { id: "grace", name: "Grace" },
  ],
};

describe("the Board's people", () => {
  it("says whose work only when more than one person's is on it", () => {
    expect(sharedBoard([resume])).toBe(false);
    expect(sharedBoard([row("solo", [{ id: "w1" }, { id: "w2" }])])).toBe(false);
    expect(sharedBoard([resume, owners])).toBe(true);
    // Nobody's work beside somebody's is two people's.
    expect(sharedBoard([resume, row("local", [{ id: "w3" }])])).toBe(true);
  });

  it("shows a picked person's lines, a shared one included, and everyone's with none picked", () => {
    const rows = [resume, owners, phone];
    expect(rowsFor(rows, "grace").map((each) => each.feature)).toEqual(["owners", "phone"]);
    expect(rowsFor(rows, undefined)).toHaveLength(3);
    expect(ownersText(["grace", "ada"], names)).toBe("Grace, you");
  });

  it("puts you first, with what needs you, and counts each person's features", () => {
    const people = boardPeople([resume, owners, phone], "ada");
    expect(people.map((person) => [person.key, person.features, person.needs])).toEqual([
      ["ada", 2, 1],
      ["grace", 2, 0],
    ]);
    expect(people[0]!.workers[0]!.threadId).toBe("w-sheet");
  });

  it("finds two people's work on the same files once, yours first, and not one person's own", () => {
    expect(boardClashes([resume, owners], "grace")).toEqual([
      {
        a: { person: "grace", worker: "w-owners", title: "w-owners" },
        b: { person: "ada", worker: "w-resume", title: "w-resume" },
        files: ["host/ownership.ts"],
      },
    ]);
    const own = row("own", [
      { id: "x1", person: "ada", overlaps: ["x2"] },
      { id: "x2", person: "ada", overlaps: ["x1"] },
    ]);
    expect(boardClashes([own], "ada")).toEqual([]);
  });
});
