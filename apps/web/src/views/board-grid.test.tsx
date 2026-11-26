// @vitest-environment happy-dom
import type { FeatureStation, ThreadId } from "@gram/contracts";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Api } from "@/api/types";
import type { RailRow, RailTone, RailWorker } from "@/orchestration/rail-model";
import { renderWithApi } from "@/panels/test-utils";

import { GridLine } from "./board-grid";

// A Board line as the grid draws it (moved down from e2e/board-rail.spec.ts): each worker on the
// station its card gives it, with its tone; the needs mark said once, on the line or its group's
// band; the helper's sentence when there is one; and a worker's click handed to the Board.

/** An api whose ledger for the workspace never comes in, and with no helper's sentence to add. */
const api = {
  orchestratorLedger: () => new Promise<never>(() => {}),
  watchLedger: () => ({
    [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }),
  }),
  featureSummary: async () => null,
} satisfies Partial<Api>;

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
  summary?: string,
): RailRow =>
  ({
    feature,
    title: feature,
    settled: false,
    finished: false,
    needs,
    reach: 1,
    projects: ["api"],
    card: {
      workspaceId: "w",
      feature,
      version: 1,
      workers: [],
      ...(summary === undefined ? {} : { summary: { version: 1, text: summary } }),
    },
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
  renderWithApi(
    <GridLine
      row={line}
      stage={undefined}
      needsMark={needsMark}
      repos={false}
      asking={new Set<ThreadId>()}
      onOpen={onOpen}
    />,
    api,
  );

const workers = () =>
  screen
    .getAllByTestId("rail-worker")
    .map((each) => [each.dataset["threadId"], each.dataset["station"], each.dataset["tone"]]);

afterEach(cleanup);

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
    const cells = { working: [worker("a", "working")] };
    const { unmount } = draw(row("mail", cells));
    expect(screen.queryByTestId("rail-summary")).toBeNull();
    unmount();
    const summary = "Endpoint in review; three branches ready to push.";
    draw(row("mail", cells, false, summary));
    expect(screen.getByTestId("rail-summary").textContent).toBe(summary);
  });

  it("hands a worker's click to the Board with its thread", () => {
    const onOpen = vi.fn();
    draw(row("mail", { working: [worker("a", "working")] }), { onOpen });
    fireEvent.click(screen.getByTestId("rail-worker-open"));
    expect(onOpen).toHaveBeenCalledWith("a", expect.anything());
  });
});
