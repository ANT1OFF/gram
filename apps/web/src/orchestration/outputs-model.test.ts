import type { ThreadId, WorkspaceOutput } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { labelWords } from "@/palette/menu-caps";

import {
  dayLabel,
  featureOf,
  groupOutputs,
  OUTPUT_FILTER_LABELS,
  OUTPUT_GROUPING_LABELS,
  outputName,
  outputOpenable,
  outputTime,
  outputViewer,
} from "./outputs-model";

const ZONE = "Europe/Oslo";
// 2026-10-16 14:05 in Oslo (UTC+02:00).
const NOW = Date.UTC(2026, 9, 16, 12, 5);
const HOUR = 3_600_000;

const output = (patch: Partial<WorkspaceOutput> = {}): WorkspaceOutput => ({
  id: "1",
  threadId: "t-1" as ThreadId,
  threadTitle: "Queue worker",
  orchestrator: false,
  feature: "mail-trigger",
  path: "/work/api/docs/verification/mail-trigger/after.png",
  kind: "screenshot",
  source: "evidence",
  mediaType: "image/png",
  size: 10,
  at: NOW,
  ...patch,
});

/** `output` with no feature, as the orchestrator's or a plain thread's are. */
const withoutFeature = (entry: WorkspaceOutput): WorkspaceOutput => {
  const rest = { ...entry };
  delete rest.feature;
  return rest;
};

const ids = (groups: ReturnType<typeof groupOutputs>) =>
  groups.map((group) => [group.label, group.outputs.map((each) => each.id)]);

describe("outputs model", () => {
  it("names a file by its last segment and its time on a 24-hour clock", () => {
    expect(outputName("/a/b/after.png")).toBe("after.png");
    expect(outputName("C:\\x\\shot.gif")).toBe("shot.gif");
    expect(outputTime(output({ at: Date.UTC(2026, 9, 16, 20, 7) }), ZONE)).toBe("22:07");
    expect(outputTime(output({ at: Date.UTC(2026, 9, 15, 22, 0) }), ZONE)).toBe("00:00");
  });

  it("says Today and Yesterday by the viewer's day, then the date", () => {
    expect(dayLabel(NOW - HOUR, NOW, ZONE)).toBe("Today");
    // 23:30 the day before in Oslo, though it is the same UTC date.
    expect(dayLabel(Date.UTC(2026, 9, 15, 21, 30), NOW, ZONE)).toBe("Yesterday");
    expect(dayLabel(Date.UTC(2026, 9, 13, 9, 0), NOW, ZONE)).toBe("Tue 13 Oct");
  });

  // Yesterday is the previous calendar date in the zone, not 24 hours back: near midnight a 23-hour
  // or 25-hour day puts 24 hours back on the wrong date.
  it("says Yesterday across the 23-hour day that starts the London spring change", () => {
    // 30 March 00:30 BST. 24 hours back is 28 March 23:30 GMT, so 29 March was Yesterday.
    const now = Date.parse("2026-03-29T23:30:00Z");
    expect(dayLabel(Date.parse("2026-03-29T12:00:00Z"), now, "Europe/London")).toBe("Yesterday");
    expect(dayLabel(Date.parse("2026-03-28T12:00:00Z"), now, "Europe/London")).toBe("Sat 28 Mar");
    expect(dayLabel(Date.parse("2026-03-30T00:10:00Z"), now, "Europe/London")).toBe("Today");
  });

  it("says Yesterday across the 25-hour day that ends the London autumn change", () => {
    // 25 October 23:30 GMT. 24 hours back is 25 October 00:30 BST, still the 25th, so the 24th
    // would not have been Yesterday.
    const now = Date.parse("2026-10-25T23:30:00Z");
    expect(dayLabel(Date.parse("2026-10-24T11:00:00Z"), now, "Europe/London")).toBe("Yesterday");
    expect(dayLabel(Date.parse("2026-10-25T00:30:00Z"), now, "Europe/London")).toBe("Today");
    expect(dayLabel(Date.parse("2026-10-23T11:00:00Z"), now, "Europe/London")).toBe("Fri 23 Oct");
  });

  it("groups by day or by feature in the order their newest came, newest first inside", () => {
    const outputs = [
      output({ id: "a", at: NOW - HOUR }),
      output({ id: "b", at: NOW - 30 * HOUR, feature: "rate-headers" }),
      { ...withoutFeature(output({ id: "c", at: NOW - 2 * HOUR })), orchestrator: true },
      output({ id: "d", at: NOW - 31 * HOUR }),
    ];
    expect(ids(groupOutputs(outputs, "day", NOW, ZONE))).toEqual([
      ["Today", ["a", "c"]],
      ["Yesterday", ["b", "d"]],
    ]);
    expect(ids(groupOutputs(outputs, "feature", NOW, ZONE))).toEqual([
      ["mail-trigger", ["a", "d"]],
      ["rate-headers", ["b"]],
      ["Orchestrator", ["c"]],
    ]);
    expect(featureOf(withoutFeature(output({ threadTitle: "Plain" })))).toBe("Plain");
  });

  it("opens a stored or sent picture as an attachment, a checkout picture by fs.image, else the panel", () => {
    expect(outputViewer(output())).toBe("checkout");
    expect(outputViewer(output({ source: "toolImage" }))).toBe("attachment");
    expect(outputViewer(output({ source: "sent", mediaType: "image/gif" }))).toBe("attachment");
    expect(outputViewer(output({ source: "written", mediaType: "text/markdown" }))).toBe("panel");
    expect(outputViewer(output({ source: "sent", mediaType: "video/mp4" }))).toBe("panel");
  });

  it("opens a non-picture only where the thread's Files panel can read it", () => {
    const roots = ["/work/api", "/work/web/"];
    const doc = output({
      path: "/work/api/docs/notes.md",
      source: "sent",
      mediaType: "text/markdown",
    });
    expect(outputOpenable(doc, roots)).toBe(true);
    const away = { ...doc, path: "/Users/dev/Downloads/notes.md" };
    expect(outputOpenable(away, roots)).toBe(false);
    expect(outputOpenable({ ...away, source: "written" }, roots)).toBe(true);
    expect(outputOpenable({ ...doc, path: "/work/apiary/notes.md" }, roots)).toBe(false);
    expect(outputOpenable({ ...doc, path: "/work/web/notes.md" }, roots)).toBe(true);
    // A picture opens through its own reader, wherever it is.
    expect(outputOpenable(output({ path: "/elsewhere/a.png", source: "sent" }), roots)).toBe(true);
  });

  it("keeps every label to one word", () => {
    for (const label of [
      ...Object.values(OUTPUT_FILTER_LABELS),
      ...Object.values(OUTPUT_GROUPING_LABELS),
    ]) {
      expect(labelWords(label), label).toBe(1);
    }
  });
});
