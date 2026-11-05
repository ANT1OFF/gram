import type { FeatureCard, FeatureCardWorker, ThreadId, WorkspaceId } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { railRows, type RailFacts } from "@/orchestration/rail-model";

import { donePr, doneRows } from "./board-done";

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

const card = (feature: string, workers: FeatureCardWorker[]): FeatureCard => ({
  workspaceId: "ws-1" as WorkspaceId,
  feature,
  station: "briefed",
  version: 1,
  workers,
  createdAt: 1,
  updatedAt: 1,
});

const facts: RailFacts = {
  asking: new Set(),
  status: () => undefined,
  over: new Map([["g" as ThreadId, false]]),
};

describe("the Board's Done band", () => {
  const shipped = worker("m", {
    state: "merged",
    station: "merged",
    prs: [
      { repo: "o/api", number: 7, state: "closed" },
      { repo: "o/api", number: 9, state: "merged" },
    ],
  });
  const closed = worker("c", { title: "Release notes", state: "done", station: "review" });
  const cards = [
    card("shipped", [shipped]),
    card("closed", [closed]),
    card("going", [worker("g")]),
  ];

  it("lists the lines that have left the Board for Done, as the sidebar's rule has it", () => {
    const rows = railRows(cards, facts, "all");
    expect(doneRows(rows).map((row) => row.feature)).toEqual(["closed", "shipped"]);
  });

  it("names the PR a line ended with: a merged one first, else its first", () => {
    const rows = railRows(cards, facts, "all");
    expect(donePr(rows.find((row) => row.feature === "shipped")!)).toEqual({
      number: 9,
      state: "merged",
    });
    expect(donePr(rows.find((row) => row.feature === "closed")!)).toBeUndefined();
  });
});
