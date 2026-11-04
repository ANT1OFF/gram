import type { FeatureStation } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { laneCounts, lanesMinWidth, laneTemplate } from "./board-lanes";
import type { RailRow, RailWorker } from "./rail-model";

const worker = (id: string): RailWorker =>
  ({ threadId: id, title: id, now: "editing", tone: "working" }) as unknown as RailWorker;

const row = (
  feature: string,
  cells: Partial<Record<FeatureStation, string[]>>,
  held: string[] = [],
): RailRow =>
  ({
    feature,
    title: feature,
    cells: {
      briefed: (cells.briefed ?? []).map(worker),
      working: (cells.working ?? []).map(worker),
      checks: (cells.checks ?? []).map(worker),
      review: (cells.review ?? []).map(worker),
      merged: (cells.merged ?? []).map(worker),
    },
    held: held.map((id) => ({ id, title: id })),
  }) as unknown as RailRow;

const rows = [
  row("mail", { working: ["a", "b", "c", "d"], review: ["e"] }),
  row("registry", { working: ["f"] }, ["held-1"]),
];

describe("board lanes", () => {
  it("counts each station's cards, held briefs on Briefed", () => {
    expect(laneCounts(rows)).toEqual({ briefed: 1, working: 5, checks: 0, review: 1, merged: 0 });
  });

  it("gives an empty station a slim lane and the rest a share by their cards, capped", () => {
    expect(laneTemplate(laneCounts(rows))).toBe(
      "minmax(10rem,14rem) minmax(11rem,1fr) minmax(11rem,3fr) 4.5rem minmax(11rem,1fr) 4.5rem",
    );
  });

  it("needs more width the more stations hold cards, and never less than the floor", () => {
    const few = lanesMinWidth(laneCounts([row("one", { working: ["a"] })]));
    const many = lanesMinWidth(
      laneCounts([row("all", { briefed: ["a"], working: ["b"], checks: ["c"], review: ["d"] })]),
    );
    expect(few).toBe(900);
    expect(many).toBeGreaterThan(few);
  });
});
