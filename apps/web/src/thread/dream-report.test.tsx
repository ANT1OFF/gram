// @vitest-environment happy-dom
import type { DreamId, DreamReport, ThreadId } from "@gram/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { DreamReportCard } from "./orchestration-cards";

afterEach(cleanup);
const base: DreamReport = {
  dreamId: "dream-test" as DreamId,
  status: "completed",
  files: [{ path: "MEMORY.md", status: "unchanged" }],
};
it("renders a persisted seeded-only ready card as failed", () => {
  render(<DreamReportCard report={base} threadId={"t-dream" as ThreadId} />);
  expect(screen.getByTestId("dream-report-status").textContent).toBe("Failed");
  expect(screen.queryByText("Ready to review")).toBeNull();
  expect(screen.getByText(/without a review report/)).toBeTruthy();
});
it("renders a real unchanged consolidation as reviewable after remount", () => {
  const report = { ...base, reportExcerpt: "Reviewed sessions and retained all durable facts." };
  const view = render(<DreamReportCard report={report} threadId={"t-dream" as ThreadId} />);
  expect(screen.getByTestId("dream-report-status").textContent).toBe("Ready to review");
  expect(screen.getByText("1 unchanged")).toBeTruthy();
  view.unmount();
  render(
    <DreamReportCard
      report={JSON.parse(JSON.stringify(report))}
      threadId={"t-dream" as ThreadId}
    />,
  );
  expect(screen.getByTestId("dream-report-status").textContent).toBe("Ready to review");
});
it.each(["failed", "canceled"] as const)("keeps %s distinct from ready", (status) => {
  render(
    <DreamReportCard
      report={{ ...base, status, failure: status === "canceled" ? "canceled" : "agent_error" }}
      threadId={"t-dream" as ThreadId}
    />,
  );
  expect(screen.queryByText("Ready to review")).toBeNull();
  expect(screen.getByTestId("dream-report-status").textContent).toBe(
    status === "canceled" ? "Cancelled" : "Failed",
  );
});

it("renders persisted auto success after remount without requesting review", () => {
  const report: DreamReport = {
    ...base,
    mode: "auto",
    adoptedVersion: "0002",
    reportExcerpt: "Validated synthetic output.",
  };
  render(
    <DreamReportCard
      report={JSON.parse(JSON.stringify(report))}
      threadId={"t-dream" as ThreadId}
    />,
  );
  expect(screen.getByTestId("dream-report-status").textContent).toBe("Adopted as 0002");
  expect(screen.queryByText("Ready to review")).toBeNull();
});

it.each(["refused", "persistence_error", "interrupted"] as const)(
  "renders auto %s as stopped, never adopted or ready",
  (adoptionFailure) => {
    render(
      <DreamReportCard
        report={{ ...base, mode: "auto", adoptionFailure }}
        threadId={"t-dream" as ThreadId}
      />,
    );
    expect(screen.getByTestId("dream-report-status").textContent).toBe("Auto adoption stopped");
    expect(screen.queryByText("Ready to review")).toBeNull();
    expect(screen.getByText(/Automatic adoption/)).toBeDefined();
  },
);
