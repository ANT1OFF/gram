// @vitest-environment happy-dom
import type { BabysitReport } from "@gram/contracts";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { BabysitReportCard } from "./babysit-report-card";

const report = (overrides: Partial<BabysitReport> = {}): BabysitReport => ({
  number: 412,
  url: "https://github.com/example/api/pull/412",
  headRefOid: "9a1e77c0d2f4b6a8c0e2d4f6a8b0c2d4e6f8a0b2",
  verdict: "approved",
  checks: "passing",
  mergeState: "CLEAN",
  rounds: 3,
  handled: 1,
  declined: [
    {
      reviewThreadId: "PRRT_backoff_name",
      path: "src/retry.ts",
      line: 8,
      body: "`delayMs` would read better as `baseDelayMs`.",
    },
  ],
  merged: false,
  ...overrides,
});

afterEach(cleanup);

describe("BabysitReportCard", () => {
  it("summarises the PR ready to merge and says it was not merged", () => {
    render(<BabysitReportCard report={report()} />);
    const card = screen.getByRole("article", { name: "#412 ready to merge" });
    expect(
      within(card)
        .getByRole("link", { name: /#412 ready to merge/ })
        .getAttribute("href"),
    ).toBe("https://github.com/example/api/pull/412");
    expect(within(card).getByText("9a1e77c")).toBeTruthy();
    expect(within(card).getByTestId("notice-verdict").textContent).toBe("Approved");
    expect(within(card).getByText("Checks passing")).toBeTruthy();
    expect(card.textContent).toContain("Merge state CLEAN");
    expect(within(card).getByText("3 rounds · 1 finding handled")).toBeTruthy();
    expect(within(card).getByTestId("babysit-not-merged").textContent).toMatch(/^Not merged/);
  });

  it("lists declined findings for the human to judge", () => {
    render(<BabysitReportCard report={report()} />);
    const declined = screen.getByRole("region", { name: "Declined" });
    expect(within(declined).getByText("Declined (1)")).toBeTruthy();
    expect(within(declined).getByText("src/retry.ts:8")).toBeTruthy();
    expect(within(declined).getByText(/baseDelayMs/)).toBeTruthy();
    cleanup();
    render(<BabysitReportCard report={report({ declined: [], handled: 4 })} />);
    expect(screen.queryByRole("region", { name: "Declined" })).toBeNull();
    expect(screen.getByText("3 rounds · 4 findings handled")).toBeTruthy();
  });
});
