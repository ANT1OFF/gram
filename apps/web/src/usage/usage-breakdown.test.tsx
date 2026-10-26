// @vitest-environment happy-dom
import type { UsageBreakdown, UsageTotals } from "@gram/contracts";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { UsageBreakdownSection } from "./usage-breakdown";

const totals = (totalTokens: number): UsageTotals => ({
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  uncachedInputTokens: totalTokens,
  unclassifiedInputTokens: 0,
  totalTokens,
});
const group = (totalTokens: number) => ({
  totals: totals(totalTokens),
  models: [{ provider: "claude" as const, model: "invented-large", totalTokens }],
});

afterEach(cleanup);

describe("By workspace", () => {
  it("names each live workspace, keeps each removed one apart, and ends with Solo threads", () => {
    const breakdown: UsageBreakdown = {
      workspaces: [
        { workspaceId: "ws-alpha", name: "Invented alpha", threads: 68, ...group(9_000) },
        { workspaceId: "ws-gone-1", name: null, threads: 3, ...group(4_000) },
        { workspaceId: "ws-beta", name: "Invented beta", threads: 1, ...group(2_000) },
        { workspaceId: "ws-gone-2", name: null, threads: 2, ...group(1_000) },
      ],
      solo: { threads: 1, ...group(500) },
      threads: [],
      outside: [],
    };
    render(<UsageBreakdownSection breakdown={breakdown} />);
    const rows = within(screen.getByTestId("usage-by-workspace")).getAllByTestId(
      "usage-breakdown-row",
    );
    expect(
      rows.map((row) => [
        row.dataset["key"],
        row.querySelector(".truncate")?.textContent,
        row.textContent?.match(/\d+ threads?/)?.[0],
      ]),
    ).toEqual([
      ["ws-alpha", "Invented alpha", "68 threads"],
      ["ws-gone-1", "Removed workspace", "3 threads"],
      ["ws-beta", "Invented beta", "1 thread"],
      ["ws-gone-2", "Removed workspace", "2 threads"],
      ["solo", "Solo threads", "1 thread"],
    ]);
  });
});
