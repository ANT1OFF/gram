import type { ThreadId } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { namesText, statusHeaderCounts } from "./status-header-model";
import type { WorkerRow, WorkersByTab } from "./workers-model";

const NOW = new Date(2026, 10, 5, 14, 0).getTime();
const YESTERDAY = new Date(2026, 10, 4, 22, 0).getTime();
const MORNING = new Date(2026, 10, 5, 9, 19).getTime();

const row = (id: string, patch: Partial<WorkerRow>): WorkerRow => ({
  threadId: id as ThreadId,
  title: `Worker ${id}`,
  feature: "f",
  repo: "gram",
  tab: "now",
  state: "working",
  status: "idle",
  glyph: "idle",
  activity: "idle",
  tone: "idle",
  now: "idle",
  held: false,
  ...patch,
});

describe("the status header's counts", () => {
  it("counts from the rows the views it opens list", () => {
    const tabs: WorkersByTab = {
      now: [
        {
          feature: "f",
          rows: [
            row("a", { activity: "working", status: "running", now: "Running tests" }),
            row("b", { activity: "working", status: "running", now: "Editing code" }),
            row("c", { state: "inReview", activity: "automation", now: "checks on #142" }),
            row("d", { state: "needsUser", activity: "attention" }),
          ],
        },
      ],
      done: [
        {
          feature: "f",
          rows: [
            row("e", { tab: "done", glyph: "merged", finishedAt: MORNING }),
            row("f", { tab: "done", glyph: "delivered", finishedAt: MORNING }),
            row("g", { tab: "done", glyph: "merged", finishedAt: YESTERDAY }),
          ],
        },
        // A feature that finished over two days is listed under each; its worker counts once.
        { feature: "f", rows: [row("e", { tab: "done", glyph: "merged", finishedAt: MORNING })] },
      ],
    };
    const counts = statusHeaderCounts(tabs, 2, NOW);
    expect(counts.running.map((w) => [w.title, w.now])).toEqual([
      ["Worker a", "Running tests"],
      ["Worker b", "Editing code"],
    ]);
    expect(counts.waiting).toBe(2);
    expect(counts.inReview.map((w) => w.threadId)).toEqual(["c"]);
    expect(counts.mergedToday.map((w) => w.threadId)).toEqual(["e"]);
  });

  it("names a couple of workers and counts the rest", () => {
    const workers = ["Inline comments", "Faster cold start", "Shortcut sheet"].map((title, i) => ({
      threadId: `t${i}` as ThreadId,
      title,
      now: "",
    }));
    expect(namesText(workers)).toBe("Inline comments, Faster cold start +1");
    expect(namesText(workers.slice(0, 1))).toBe("Inline comments");
    expect(namesText([])).toBe("");
  });
});
