// @vitest-environment happy-dom
import type { FeatureStation } from "@gram/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RailRow, RailTone, RailWorker } from "@/orchestration/rail-model";

import { useThreadsStore } from "@/stores/threads";

import { doneCardLine, PhoneBoard, phoneCardLine, phoneCards, phoneSegmentOf } from "./board-phone";

vi.mock("@/orchestration/overview-pr-chips", () => ({ WorkerPrChips: () => null }));
vi.mock("@/orchestration/held-brief", () => ({
  HeldBriefChip: ({ held }: { held: { title: string } }) => (
    <li data-testid="rail-held">{held.title}</li>
  ),
}));

const worker = (id: string, tone: RailTone): RailWorker =>
  ({ threadId: id, title: `Task ${id}`, now: "editing", tone, prs: [] }) as unknown as RailWorker;

const row = (
  feature: string,
  cells: Partial<Record<FeatureStation, RailWorker[]>>,
  extra: Partial<RailRow> = {},
): RailRow =>
  ({
    feature,
    title: feature,
    settled: false,
    finished: false,
    card: { workspaceId: "w", workers: [] },
    cells: {
      briefed: cells.briefed ?? [],
      working: cells.working ?? [],
      checks: cells.checks ?? [],
      review: cells.review ?? [],
      merged: cells.merged ?? [],
    },
    held: [],
    ...extra,
  }) as unknown as RailRow;

const rows = [
  row("mail", {
    working: [worker("a", "working"), worker("b", "needs")],
    checks: [worker("c", "waiting")],
  }),
  row("registry", { working: [worker("d", "idle")] }, {
    held: [{ id: "h", title: "Held one" }],
  } as unknown as Partial<RailRow>),
];
const done = [row("old", { merged: [worker("e", "merged")] }, { settled: true })];

afterEach(() => {
  cleanup();
  useThreadsStore.setState({ byId: {} });
});

const segment = (id: string) =>
  screen.getAllByRole("radio").find((each) => each.dataset["segment"] === id)!;

/** Which agent each thread runs on. */
const agents = (pairs: Record<string, string>) =>
  useThreadsStore.setState({
    byId: Object.fromEntries(
      Object.entries(pairs).map(([id, agent]) => [id, { thread: { model: { agent } } }]),
    ) as never,
  });

/** The first card's line under its stage bar. */
const firstLine = () =>
  screen.getAllByTestId("phone-board-card")[0]!.querySelector("[data-testid=phone-board-line]")
    ?.textContent;

describe("phone board", () => {
  it("makes a card per worker, in the stations' order, with its station", () => {
    expect(phoneCards(rows).map((card) => [card.worker.threadId, card.station])).toEqual([
      ["a", "working"],
      ["b", "working"],
      ["c", "checks"],
      ["d", "working"],
    ]);
  });

  it("puts busy work in Now, calm work in Waiting and finished work in Done", () => {
    const segments = phoneCards([...rows, ...done]).map((card) => phoneSegmentOf(card));
    expect(segments).toEqual(["now", "now", "waiting", "waiting", "done"]);
  });

  it("counts each segment, shows Now first and switches on a tap", () => {
    render(<PhoneBoard rows={rows} done={done} asking={new Set()} onOpen={() => {}} />);
    expect(segment("now").textContent).toBe("Now2");
    expect(segment("waiting").textContent).toBe("Waiting3");
    expect(segment("done").textContent).toBe("Done1");
    expect(segment("now").getAttribute("aria-checked")).toBe("true");
    expect(screen.getAllByTestId("phone-board-card")).toHaveLength(2);
    fireEvent.click(segment("waiting"));
    expect(screen.getAllByTestId("phone-board-card")).toHaveLength(2);
    expect(screen.getByTestId("rail-held").textContent).toBe("Held one");
  });

  it("opens the worker's thread on a tap, as the desktop row does", () => {
    const onOpen = vi.fn();
    render(<PhoneBoard rows={rows} done={done} asking={new Set()} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: /^Task b,/ }));
    expect(onOpen).toHaveBeenCalledWith("b", expect.anything());
  });

  it("says why a card that needs you is stuck, in place of its stage bar", () => {
    render(<PhoneBoard rows={rows} done={done} asking={new Set()} onOpen={() => {}} />);
    const [busy, stuck] = screen.getAllByTestId("phone-board-card");
    expect(busy!.querySelector("[data-testid=phone-board-stage]")).not.toBeNull();
    expect(stuck!.dataset["tone"]).toBe("needs");
    expect(stuck!.querySelector("[data-testid=phone-board-stage]")).toBeNull();
    expect(stuck!.querySelector("[data-testid=phone-board-line]")?.textContent).toBe("editing");
  });

  it("says what a worker does or waits on under its bar, and its station when it says no more", () => {
    expect(phoneCardLine({ now: "tests 31/48" }, "working")).toBe("tests 31/48");
    expect(phoneCardLine({ now: "Waiting · checks on #142" }, "checks")).toBe("checks on #142");
    // "working" is what the card's corner already says ("Running"): the station, said once.
    expect(phoneCardLine({ now: "working" }, "working")).toBe("Working");
    expect(phoneCardLine({ now: "" }, "review")).toBe("Review");
  });

  it("says how a finished card ended, without the number its PR's chip has", () => {
    const pr = [{ number: 136 }] as unknown as RailWorker["prs"];
    expect(doneCardLine({ now: "Merged as #136", prs: pr })).toBe("Merged");
    expect(doneCardLine({ now: "Merged as #136", prs: [] })).toBe("Merged as #136");
    expect(doneCardLine({ now: "Closed without merging", prs: pr })).toBe("Closed without merging");
    expect(doneCardLine({ now: "", prs: [] })).toBe("Done");
  });

  it("names a card's agent only where the Board's workers run different ones", () => {
    agents({ a: "claude", b: "claude" });
    const { unmount } = render(
      <PhoneBoard rows={rows} done={done} asking={new Set()} onOpen={() => {}} />,
    );
    expect(firstLine()).toBe("editing");
    unmount();
    agents({ a: "claude", b: "codex" });
    render(<PhoneBoard rows={rows} done={done} asking={new Set()} onOpen={() => {}} />);
    expect(firstLine()).toBe("editing · Claude Code");
  });

  it("opens on the first segment with anything in it", () => {
    render(<PhoneBoard rows={[]} done={done} asking={new Set()} onOpen={() => {}} />);
    const checked = screen
      .getAllByRole("radio")
      .find((each) => each.getAttribute("aria-checked") === "true");
    expect(checked?.dataset["segment"]).toBe("done");
  });
});
