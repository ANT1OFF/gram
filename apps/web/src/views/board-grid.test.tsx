// @vitest-environment happy-dom
import type { FeatureStation, ThreadId } from "@gram/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RailRow, RailTone, RailWorker } from "@/orchestration/rail-model";

import { GridLine } from "./board-grid";

// A Board line as the grid draws it (moved down from e2e/board-rail.spec.ts): each worker on the
// station its card gives it, with its tone; the needs mark said once, on the line or its group's
// band; the helper's sentence when there is one; and a worker's click handed to the Board.

const summary = vi.hoisted(() => ({ text: undefined as string | undefined }));
vi.mock("@/orchestration/use-feature-cards", () => ({ useFeatureSummary: () => summary.text }));
vi.mock("@/orchestration/use-orchestration", () => ({
  useOrchestratorLedger: () => ({ data: undefined }),
}));
vi.mock("@/orchestration/overview-pr-chips", () => ({
  useWorkerPrChips: () => [],
  shownPrNumbers: () => [],
  WorkerPrChips: () => null,
}));
vi.mock("@/orchestration/feature-sheet", () => ({
  FeatureMenu: () => null,
  PausedBadge: () => null,
}));
vi.mock("@/orchestration/held-brief", () => ({ HeldBriefChip: () => null }));
vi.mock("@/thread/machine-marker", () => ({
  MachineMarker: () => null,
  ThreadMachineMarker: () => null,
  useThreadHost: () => undefined,
  useThreadSent: () => undefined,
}));

const worker = (id: string, tone: RailTone): RailWorker =>
  ({
    threadId: id,
    title: `Task ${id}`,
    now: "editing",
    tone,
    prs: [],
    overlaps: [],
  }) as unknown as RailWorker;

const row = (
  feature: string,
  cells: Partial<Record<FeatureStation, RailWorker[]>>,
  needs = false,
): RailRow =>
  ({
    feature,
    title: feature,
    settled: false,
    finished: false,
    needs,
    reach: 1,
    projects: ["api"],
    card: { workspaceId: "w", workers: [] },
    cells: {
      briefed: cells.briefed ?? [],
      working: cells.working ?? [],
      checks: cells.checks ?? [],
      review: cells.review ?? [],
      merged: cells.merged ?? [],
    },
    held: [],
  }) as unknown as RailRow;

const draw = (
  line: RailRow,
  { needsMark = true, onOpen = () => {} }: { needsMark?: boolean; onOpen?: () => void } = {},
) =>
  render(
    <GridLine
      row={line}
      stage={undefined}
      needsMark={needsMark}
      repos={false}
      asking={new Set<ThreadId>()}
      onOpen={onOpen}
    />,
  );

const workers = () =>
  screen
    .getAllByTestId("rail-worker")
    .map((each) => [each.dataset["threadId"], each.dataset["station"], each.dataset["tone"]]);

afterEach(() => {
  cleanup();
  summary.text = undefined;
});

describe("a Board grid line", () => {
  it("puts each worker on its card's station, in the stations' order, with its tone", () => {
    draw(
      row("mail", {
        review: [worker("c", "waiting")],
        working: [worker("a", "working"), worker("b", "needs")],
      }),
    );
    expect(workers()).toEqual([
      ["a", "working", "working"],
      ["b", "working", "needs"],
      ["c", "review", "waiting"],
    ]);
    // Several workers: the feature heads their rows, and says how many need you.
    expect(screen.getByTestId("grid-workers").textContent).toMatch(/^3 workers · 1 needs you$/);
  });

  it("is one row for one worker", () => {
    draw(row("docs", { checks: [worker("d", "working")] }));
    expect(workers()).toEqual([["d", "checks", "working"]]);
    expect(screen.queryByTestId("grid-workers")).toBeNull();
  });

  it("marks a line that needs you only where its group's band doesn't say so", () => {
    const needing = row("docs", { working: [worker("d", "needs")] }, true);
    const { unmount } = draw(needing);
    expect(screen.getByTestId("rail-needs")).toBeTruthy();
    unmount();
    draw(needing, { needsMark: false });
    expect(screen.queryByTestId("rail-needs")).toBeNull();
  });

  it("carries the helper's sentence when it has one, and is complete without", () => {
    const line = row("mail", { working: [worker("a", "working")] });
    const { unmount } = draw(line);
    expect(screen.queryByTestId("rail-summary")).toBeNull();
    unmount();
    summary.text = "Endpoint in review; three branches ready to push.";
    draw(line);
    expect(screen.getByTestId("rail-summary").textContent).toBe(summary.text);
  });

  it("hands a worker's click to the Board with its thread", () => {
    const onOpen = vi.fn();
    draw(row("mail", { working: [worker("a", "working")] }), { onOpen });
    fireEvent.click(screen.getByTestId("rail-worker-open"));
    expect(onOpen).toHaveBeenCalledWith("a", expect.anything());
  });
});
