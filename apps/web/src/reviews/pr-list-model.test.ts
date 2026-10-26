import { describe, expect, it } from "vitest";
import {
  changeSize,
  DEFAULT_PR_OPTIONS,
  informationCached,
  selectPrs,
  type PrInformation,
} from "./pr-list-model";

const row = (number: number, extra: Partial<PrInformation> = {}): PrInformation => ({
  repo: "example/tools",
  number,
  title: "Improve cache",
  updatedAt: "2026-10-01T12:00:00Z",
  ...extra,
});
const ids = (rows: PrInformation[]) => rows.map((r) => r.number);

describe("local PR presentation", () => {
  it("searches title, full repo, number, author and every label using all terms", () => {
    const rows = [row(17, { author: "robot[bot]", labels: ["bug", "offline-cache"] }), row(18)];
    for (const search of ["IMPROVE #17", "example/tools robot", "offline-cache bug"])
      expect(ids(selectPrs(rows, { ...DEFAULT_PR_OPTIONS, search }))).toEqual([17]);
    expect(selectPrs(rows, { ...DEFAULT_PR_OPTIONS, search: "missing" })).toEqual([]);
    expect(selectPrs(rows, DEFAULT_PR_OPTIONS)).toHaveLength(2);
  });
  it("keeps zero distinct from unknown and places unknown size last with stable ties", () => {
    const rows = [
      row(1),
      row(2, { additions: 0, deletions: 0 }),
      row(3, { additions: 12, deletions: 3 }),
      row(4, { additions: 12 }),
      row(5),
    ];
    expect(changeSize(rows[0]!)).toBeUndefined();
    expect(changeSize(rows[1]!)).toBe(0);
    expect(ids(selectPrs(rows, { ...DEFAULT_PR_OPTIONS, sort: "size" }))).toEqual([3, 2, 1, 4, 5]);
  });
  it("sorts activity rather than opened time and leaves invalid dates last in either direction", () => {
    const rows = [
      row(1, { updatedAt: "", createdAt: "2026-10-09T12:00:00Z" }),
      row(2),
      row(3, { updatedAt: "2026-10-02T12:00:00Z" }),
      row(4),
    ];
    expect(ids(selectPrs(rows, DEFAULT_PR_OPTIONS))).toEqual([3, 2, 4, 1]);
    expect(ids(selectPrs(rows, { ...DEFAULT_PR_OPTIONS, sort: "oldest" }))).toEqual([2, 4, 3, 1]);
  });
  it("filters displayed checks honestly and does not mutate source membership or unknown draft", () => {
    const rows = [
      row(1, { checks: "passing", isDraft: false }),
      row(2, { checks: "failing", isDraft: true }),
      row(3, { checks: "none" }),
      row(4),
      row(5, { checks: "failing", detailsStale: true }),
    ];
    expect(ids(selectPrs(rows, { ...DEFAULT_PR_OPTIONS, filter: "failing" }))).toEqual([2]);
    expect(ids(selectPrs(rows, { ...DEFAULT_PR_OPTIONS, filter: "unknown" }))).toEqual([4, 5]);
    expect(ids(selectPrs(rows, { ...DEFAULT_PR_OPTIONS, filter: "draft" }))).toEqual([2]);
    expect(ids(selectPrs(rows, { ...DEFAULT_PR_OPTIONS, filter: "ready" }))).toEqual([1]);
    expect(ids(selectPrs(rows, { ...DEFAULT_PR_OPTIONS, filter: "none" }))).toEqual([3]);
    expect(rows).toHaveLength(5);
  });
  it("does not promote cached counts into a fresh size ranking after a badge update", () => {
    const pr = row(1, { additions: 100, deletions: 0, informationAt: "2026-09-30T12:00:00Z" });
    expect(informationCached(pr)).toBe(true);
    expect(changeSize(pr)).toBeUndefined();
    expect(
      changeSize(row(2, { additions: 100, deletions: 0, informationStale: true })),
    ).toBeUndefined();
  });
});
