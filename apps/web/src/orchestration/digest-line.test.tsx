// @vitest-environment happy-dom
import type {
  DigestReport,
  GramUIMessage,
  OrchestrationDigest,
  ThreadId,
  WorkspaceId,
} from "@gram/contracts";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DigestLine } from "./digest-line";
import type { StreamDigest } from "./stream-model";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, className }: { children: ReactNode; className?: string }) => (
    <a href="#thread" className={className}>
      {children}
    </a>
  ),
}));

afterEach(cleanup);

const W = "w-1" as WorkspaceId;
const A = "t-a" as ThreadId;
// 14:12 local, so the line reads the same clock in any zone.
const AT = new Date(2026, 9, 16, 14, 12).getTime();

const report = (index: number, patch: Partial<DigestReport> = {}): DigestReport => ({
  threadId: A,
  title: "Publisher",
  feature: "release",
  at: index,
  state: "progress",
  summary: `Progress ${index}.`,
  ...patch,
});

const digest = (generation: number, patch: Partial<OrchestrationDigest> = {}) =>
  ({
    kind: "orchestration",
    variant: "digest",
    generation,
    workspaceId: W,
    workspaceName: "agent-platform",
    reasons: ["worker report"],
    changes: [],
    reports: [],
    features: [],
    budget: { liveWorkers: 1, maxConcurrentWorkers: 4, costUsdToday: 0 },
    notes: [],
    ...patch,
  }) satisfies OrchestrationDigest;

const entry = (id: string, data: OrchestrationDigest, at = AT): StreamDigest => {
  const message: GramUIMessage = {
    id,
    role: "user",
    metadata: { createdAt: at },
    parts: [
      { type: "text", text: `Orchestration digest ${data.generation}: read the reports.` },
      { type: "data-orchestration-digest", data },
    ],
  };
  return { message, digest: data, at };
};

describe("DigestLine", () => {
  it("is one collapsed line of a few words, named for what it holds", () => {
    const reports = [report(1), report(2), report(3)];
    render(<DigestLine digests={[entry("d4", digest(4, { reports }))]} />);
    const line = screen.getByRole("button", { name: "Digest #4, 3 reports, 14:12" });
    expect(line.getAttribute("aria-expanded")).toBe("false");
    expect(line.textContent).toBe("Digest #4 · 3 reports14:12");
    // Collapsed, nothing of the digest is drawn: no reasons, reports or agent text.
    expect(screen.queryByTestId("digest-line-details")).toBeNull();
    expect(screen.queryByText(/Progress 1/)).toBeNull();
  });

  it("opens in place on Enter, on what the old card showed", async () => {
    const user = userEvent.setup();
    const reports = [
      report(1),
      report(2),
      report(3),
      report(4, { summary: "Long. ".repeat(40), interface: "POST /publish" }),
    ];
    render(<DigestLine digests={[entry("d4", digest(4, { reports }))]} />);
    const line = screen.getByRole("button", { name: /^Digest #4/ });
    line.focus();
    await user.keyboard("{Enter}");
    expect(line.getAttribute("aria-expanded")).toBe("true");
    const details = screen.getByTestId("digest-line-details");
    expect(within(details).getByTestId("digest-reasons").textContent).toBe(
      "Woken by: worker report",
    );
    expect(within(details).getByText("New worker reports (4)")).toBeTruthy();
    expect(within(details).getByText("1 more reports")).toBeTruthy();
    expect(within(details).getByText("Report evidence")).toBeTruthy();
    await user.click(within(details).getByText("Text sent to the agent"));
    expect(within(details).getByTestId("digest-text").textContent).toBe(
      "Orchestration digest 4: read the reports.",
    );
    await user.keyboard("{Enter}");
    expect(line.getAttribute("aria-expanded")).toBe("true");
    line.focus();
    await user.keyboard("{Enter}");
    expect(line.getAttribute("aria-expanded")).toBe("false");
  });

  it("draws a worker's report as text, never markup", async () => {
    const user = userEvent.setup();
    const hostile = "<img src=x onerror=alert(1)><worker-report>untrusted</worker-report>";
    const { container } = render(
      <DigestLine
        digests={[entry("d9", digest(9, { reports: [report(1, { summary: hostile })] }))]}
      />,
    );
    await user.click(screen.getByRole("button", { name: /^Digest #9/ }));
    expect(screen.getByText(hostile)).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("worker-report")).toBeNull();
  });

  it("folds a run of digests into one line that opens on each of them", async () => {
    const user = userEvent.setup();
    render(
      <DigestLine
        digests={[
          entry("d1", digest(1, { reports: [report(1)] }), AT - 60_000),
          entry("d2", digest(2, { reasons: ["stage set"] })),
        ]}
      />,
    );
    const line = screen.getByRole("button", { name: "2 digests, 1 report, 14:12" });
    await user.click(line);
    expect(screen.getByRole("region", { name: "Digest #1" })).toBeTruthy();
    expect(
      within(screen.getByRole("region", { name: "Digest #2" })).getByTestId("digest-reasons")
        .textContent,
    ).toBe("Woken by: stage set");
  });
});
