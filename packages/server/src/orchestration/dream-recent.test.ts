import { describe, expect, it } from "vitest";
import type { ThreadId } from "@gram/contracts";
import { DREAM_CURSOR_START } from "../persistence/dream-cursor.ts";
import { recentRead, type RecentItem } from "./dream-recent.ts";

const report = (seq: number, at: number, summary: string): RecentItem => ({
  kind: "report",
  seq,
  at,
  title: "Worker",
  report: { threadId: "t-w" as ThreadId, state: "done", summary, at },
});

describe("recentRead", () => {
  it("reads the oldest first up to its cap, and the next read takes up exactly where it stopped", () => {
    const items: Array<RecentItem> = [
      report(1, 10, "a".repeat(400)),
      report(2, 20, "b".repeat(400)),
      { kind: "thread", at: 15, title: "Conversation", threadId: "t-c", reason: "user" },
      report(3, 30, "c".repeat(400)),
    ];
    const first = recentRead(items, DREAM_CURSOR_START, 100, 1_400);
    expect(first.read).toMatchObject({ reports: 2, threads: 1, throughReportSeq: 2, more: true });
    expect(first.text).not.toContain("ccc");
    // What wasn't read is newer than where the cursor stops.
    expect(first.read.throughAt).toBe(29);

    const cursor = {
      reportSeq: first.read.throughReportSeq,
      eventSeq: first.read.throughEventSeq,
      at: first.read.throughAt,
    };
    const left = items.filter((item) =>
      item.kind === "report" ? item.seq > cursor.reportSeq : item.at > cursor.at,
    );
    const second = recentRead(left, cursor, 100, 1_400);
    expect(second.read).toMatchObject({ reports: 1, threads: 0, throughReportSeq: 3 });
    expect(second.read.more).toBeUndefined();
    expect(second.read.throughAt).toBe(100);
  });

  it("keeps a report's seq order even when its time runs backwards, so none is skipped", () => {
    const items = [report(1, 50, "late clock"), report(2, 40, "early clock")];
    const read = recentRead(items, DREAM_CURSOR_START, 100, 100_000);
    expect(read.text.indexOf("late clock")).toBeLessThan(read.text.indexOf("early clock"));
    expect(read.read.throughReportSeq).toBe(2);
  });
});
