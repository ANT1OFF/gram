import type { ThreadSummary } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { startedByOf, threadListings } from "./threads-model";

const summary = (
  id: string,
  lastActivityAt: number,
  extra: Record<string, unknown> = {},
  status = "idle",
): ThreadSummary =>
  ({
    status,
    pendingRequests: [],
    thread: { id, title: `Thread ${id}`, lastActivityAt, parked: false, ...extra },
  }) as unknown as ThreadSummary;

const sources = (summaries: ThreadSummary[], needing: readonly string[] = []) => ({
  summaries,
  workspaceNames: new Map([["w1", "api"]]),
  needsYou: (s: ThreadSummary) => needing.includes(s.thread.id),
});

describe("threadListings", () => {
  it("lists those that need you first, then the latest, leaving archived ones out", () => {
    const listed = threadListings(
      sources(
        [summary("a", 1), summary("b", 3), summary("c", 2), summary("gone", 9, { parked: true })],
        ["a"],
      ),
    );
    expect(listed.map((listing) => listing.summary.thread.id)).toEqual(["a", "b", "c"]);
    expect(listed[0]?.needsYou).toBe(true);
  });

  it("names each one's place and what started it", () => {
    const listed = threadListings(
      sources([
        summary("o", 3, { role: "orchestrator", workspaceId: "w1", title: "api" }),
        summary("w", 2, { workspaceId: "w1", spawnedBy: { threadId: "o", feature: "x" } }),
        summary("r", 1, {
          workspaceId: "w9",
          spawnedBy: { threadId: "o", feature: "y", routine: { id: "1", name: "Nightly" } },
        }),
        summary("s", 0),
      ]),
    );
    expect(listed.map((listing) => [listing.place, listing.startedBy])).toEqual([
      ["api", "Orchestrator"],
      ["api", `Worker of ${listed[0]?.title}`],
      ["Workspace", "Routine: Nightly"],
      ["Solo", undefined],
    ]);
  });

  it("finds by title, place or starter, any case", () => {
    const all = [
      summary("a", 1, { title: "Fix the login" }),
      summary("b", 2, { workspaceId: "w1" }),
    ];
    expect(threadListings(sources(all), "LOGIN").map((l) => l.summary.thread.id)).toEqual(["a"]);
    expect(threadListings(sources(all), "api").map((l) => l.summary.thread.id)).toEqual(["b"]);
    expect(threadListings(sources(all), "nothing")).toEqual([]);
  });
});

describe("startedByOf", () => {
  it('says only "Worker" for a worker whose orchestrator is gone', () => {
    expect(
      startedByOf(summary("w", 1, { spawnedBy: { threadId: "x", feature: "f" } }), new Map()),
    ).toBe("Worker");
  });
});
