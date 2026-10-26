import { describe, expect, it } from "vitest";
import { parseWordFilters, timeBounds, matchesWordFilters } from "./word-filters";
import type { ThreadSummary } from "@gram/contracts";
const workspaces = [
  { id: "w-api", name: "agent-platform" },
  { id: "w-bill", name: "Billing App" },
  { id: "w-open", name: "Open" },
];
describe("go to in words grammar", () => {
  it.each([
    [
      "failing PRs in agent-platform this week",
      [
        { field: "workspace", value: "w-api" },
        { field: "kind", value: "pr" },
        { field: "state", value: "failing" },
        { field: "time", value: "thisWeek" },
      ],
      "",
    ],
    [
      "workers waiting on me",
      [
        { field: "kind", value: "worker" },
        { field: "state", value: "waiting" },
      ],
      "",
    ],
    [
      "show threads in BILLING APP today",
      [
        { field: "workspace", value: "w-bill" },
        { field: "kind", value: "thread" },
        { field: "time", value: "today" },
      ],
      "",
    ],
    [
      "asks last 24 hours",
      [
        { field: "kind", value: "ask" },
        { field: "time", value: "last24h" },
      ],
      "",
    ],
    [
      "running workers yesterday",
      [
        { field: "kind", value: "worker" },
        { field: "state", value: "working" },
        { field: "time", value: "yesterday" },
      ],
      "",
    ],
    [
      "merged pull requests last 7 days",
      [
        { field: "kind", value: "pr" },
        { field: "state", value: "merged" },
        { field: "time", value: "last7d" },
      ],
      "",
    ],
    [
      "idle threads ack retry",
      [
        { field: "kind", value: "thread" },
        { field: "state", value: "idle" },
      ],
      "ack retry",
    ],
    ["opening yesterdayish", [], "opening yesterdayish"],
    ["in Open", [{ field: "workspace", value: "w-open" }], ""],
    ["> workers waiting on me", [], "> workers waiting on me"],
    ["ack retry", [], "ack retry"],
    [
      "failing PRs in unknown",
      [
        { field: "kind", value: "pr" },
        { field: "state", value: "failing" },
      ],
      "unknown",
    ],
  ])("parses %s", (query, filters, text) =>
    expect(parseWordFilters(query as string, workspaces)).toEqual({ filters, text }),
  );

  it("uses local midnight, Monday and exclusive yesterday end", () => {
    const now = new Date(2026, 9, 15, 14, 30).getTime();
    expect(timeBounds("thisWeek", now)[0]).toBe(new Date(2026, 9, 12).getTime());
    expect(timeBounds("yesterday", now)).toEqual([
      new Date(2026, 9, 14).getTime(),
      new Date(2026, 9, 15).getTime(),
    ]);
  });

  it("dates asks by their own update rather than unrelated thread activity", () => {
    const now = new Date(2026, 9, 15, 14, 30).getTime();
    const summary = { thread: { lastActivityAt: now } } as ThreadSummary;
    expect(
      matchesWordFilters(
        summary,
        "ask",
        [{ field: "time", value: "today" }],
        now,
        now - 7 * 86_400_000,
      ),
    ).toBe(false);
    expect(
      matchesWordFilters(summary, "ask", [{ field: "time", value: "today" }], now, now - 1_000),
    ).toBe(true);
  });
  it("matches live facts, ignores suggested asks and requires known PR recency", () => {
    const summary = {
      thread: { workspaceId: "w-api", lastActivityAt: Date.now() },
      status: "idle",
      pendingRequests: [],
      waits: [{ suggested: true }],
      git: { pr: { checks: "failing", state: "OPEN" } },
    } as unknown as ThreadSummary;
    expect(
      matchesWordFilters(summary, "worker", [{ field: "state", value: "waiting" }], Date.now()),
    ).toBe(false);
    expect(
      matchesWordFilters(summary, "pr", [{ field: "state", value: "failing" }], Date.now()),
    ).toBe(true);
    expect(matchesWordFilters(summary, "pr", [{ field: "time", value: "today" }], Date.now())).toBe(
      false,
    );
    expect(
      matchesWordFilters(summary, "worker", [{ field: "workspace", value: "other" }], Date.now()),
    ).toBe(false);
  });
  it("reads working and idle as the thread's glyph does: work under a resting thread is working", () => {
    const resting = {
      thread: { id: "t", lastActivityAt: Date.now() },
      status: "idle",
      pendingRequests: [],
      background: [{ id: "b-1", kind: "shell", command: "bun run check", description: "" }],
    } as unknown as ThreadSummary;
    const state = (value: string) =>
      matchesWordFilters(resting, "thread", [{ field: "state", value }] as never, Date.now());
    expect(state("working")).toBe(true);
    expect(state("idle")).toBe(false);
  });
});
