import { describe, expect, it } from "vitest";

import { labelWords, MENU_CAP } from "@/palette/menu-caps";

import { filterVerbs, gridIndexForKey, orchestratorVerbs, VERB_COLUMNS } from "./verbs";

const labels = (verbs: readonly { label: string }[]) => verbs.map((v) => v.label);

describe("orchestratorVerbs", () => {
  it("lists the design's verbs in order, More… last, a word each and no more than the cap", () => {
    const verbs = orchestratorVerbs(false);
    expect(labels(verbs)).toEqual([
      "Task",
      "Pause",
      "Memory",
      "Board",
      "Files",
      "Repo",
      "Fresh",
      "More…",
    ]);
    expect(verbs.filter((v) => v.id !== "more").length).toBeLessThanOrEqual(MENU_CAP);
    for (const verb of verbs) expect(labelWords(verb.label)).toBe(1);
    expect(verbs.map((v) => v.name)).toEqual([
      "task",
      "pause",
      "memory",
      "board",
      "files",
      "repo",
      "fresh",
      "more",
    ]);
  });

  it("reads Pause as Resume on a paused workspace, and leaves it out while that isn't known", () => {
    expect(labels(orchestratorVerbs(true))).toContain("Resume");
    expect(labels(orchestratorVerbs(true))).not.toContain("Pause");
    expect(labels(orchestratorVerbs(undefined))).toEqual([
      "Task",
      "Memory",
      "Board",
      "Files",
      "Repo",
      "Fresh",
      "More…",
    ]);
  });
});

describe("filterVerbs", () => {
  const verbs = orchestratorVerbs(false);

  it("shows them all on a bare /", () => {
    expect(filterVerbs(verbs, "")).toEqual(verbs);
  });

  it("keeps the verbs a typed name starts, case aside, and More… after them", () => {
    expect(labels(filterVerbs(verbs, "b"))).toEqual(["Board", "More…"]);
    expect(labels(filterVerbs(verbs, "M"))).toEqual(["Memory", "More…"]);
    expect(labels(filterVerbs(verbs, "mo"))).toEqual(["More…"]);
    expect(labels(filterVerbs(verbs, "fresh"))).toEqual(["Fresh", "More…"]);
    expect(labels(filterVerbs(verbs, "f"))).toEqual(["Files", "Fresh", "More…"]);
  });

  it("is empty for a name no verb starts, so the agent's commands answer", () => {
    expect(filterVerbs(verbs, "model")).toEqual([]);
    expect(filterVerbs(verbs, "oard")).toEqual([]);
  });
});

const move = (key: string, active: number, count = 8) =>
  gridIndexForKey(key, active, count, VERB_COLUMNS);

describe("gridIndexForKey", () => {
  it("steps sideways with ← →, wrapping at the ends", () => {
    expect(move("ArrowRight", 0)).toBe(1);
    expect(move("ArrowRight", 7)).toBe(0);
    expect(move("ArrowLeft", 0)).toBe(7);
  });

  it("goes a row with ↑ ↓, back to the same column at the other end", () => {
    expect(move("ArrowDown", 1)).toBe(5);
    expect(move("ArrowDown", 5)).toBe(1);
    expect(move("ArrowUp", 6)).toBe(2);
    expect(move("ArrowUp", 2)).toBe(6);
  });

  it("stays inside a short last row", () => {
    // Seven options: the second row holds 4, 5 and 6.
    expect(move("ArrowUp", 3, 7)).toBe(3);
    expect(move("ArrowUp", 2, 7)).toBe(6);
    expect(move("ArrowDown", 3, 7)).toBe(3);
  });

  it("takes Home and End, and leaves every other key", () => {
    expect(move("Home", 5)).toBe(0);
    expect(move("End", 2)).toBe(7);
    expect(move("Enter", 2)).toBeUndefined();
    expect(gridIndexForKey("ArrowDown", 0, 0, VERB_COLUMNS)).toBeUndefined();
  });
});
