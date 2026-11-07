// @vitest-environment happy-dom
import type { ThreadId } from "@gram/contracts";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockApi, type MockApi } from "@/api/mock";
import { renderWithApi } from "@/panels/test-utils";
import { EMPTY_GRID, useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";
import { useViewStore } from "@/views/view-store";

import { Foldable } from "./foldable";
import { TitlebarOverflow } from "./titlebar-fold";
import {
  nextFold,
  titleRoomNeed,
  unfoldWidths,
  useTitlebarSlot,
  type TitlebarFold,
} from "./titlebar-slot";
import { ThreadGrid } from "./thread-grid";

const route = vi.hoisted(() => ({ threadId: "t-flaky" as string | undefined }));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children?: ReactNode }) => children,
  useNavigate: () => vi.fn(),
  useParams: () => (route.threadId === undefined ? {} : { threadId: route.threadId }),
}));

const FLAKY = "t-flaky" as ThreadId;
let api: MockApi;
let slot: HTMLDivElement;

beforeEach(async () => {
  api = createMockApi({ speed: 0, autoplay: false });
  const abort = new AbortController();
  for await (const event of api.events(abort.signal)) {
    useThreadsStore.getState().applyEvent(event);
    if (event.type === "threads.snapshot") break;
  }
  abort.abort();
  route.threadId = FLAKY;
  useViewStore.setState({ view: "chat" });
  useLayoutStore.setState({ grid: { ...EMPTY_GRID, panes: [FLAKY] } });
  // The shell's title bar offers this place while it carries a thread.
  slot = document.createElement("div");
  slot.dataset["testid"] = "titlebar-thread";
  document.body.append(slot);
  useTitlebarSlot.getState().setSlot(slot);
});

afterEach(() => {
  cleanup();
  useTitlebarSlot.getState().setSlot(null);
  useTitlebarSlot.getState().setFold(0);
  slot.remove();
});

const pane = () => screen.getByTestId("pane");

describe("a thread's header in the title bar", () => {
  it("moves into the title bar, leaving the pane no bar of its own", async () => {
    renderWithApi(<ThreadGrid />, api);
    const header = await within(slot).findByTestId("pane-header");
    expect(header.dataset["inTitlebar"]).toBe("true");
    expect(within(pane()).queryByTestId("pane-header")).toBeNull();
    expect(screen.getAllByTestId("pane-header")).toHaveLength(1);

    // Every control the second bar had is still there, in the one bar.
    expect(within(header).getByRole("heading", { level: 1 }).textContent).toContain(
      "Fix flaky retry test",
    );
    expect(within(header).getByTestId("pane-status")).toBeTruthy();
    // The thread's menu, Contents and scripts are the bar's one "…", not buttons of the header.
    expect(within(header).queryByRole("button", { name: "Thread menu" })).toBeNull();
    expect(within(header).queryByRole("button", { name: "Contents" })).toBeNull();
    // The composer and the transcript stay in the pane.
    expect(within(pane()).getByLabelText("Message", { exact: true })).toBeTruthy();
    // The title and the empty room drag the window; the chips and the buttons after it don't.
    expect(header.className).toContain("[&>*:not(:first-child)]:[-webkit-app-region:no-drag]");
    expect(within(header).getByTestId("pane-header-chips").className).toContain(
      "[-webkit-app-region:no-drag]",
    );
  });

  it('keeps the branch out of the bar and its "…"', async () => {
    renderWithApi(
      <>
        <ThreadGrid />
        <TitlebarOverflow orchestration={false} />
      </>,
      api,
    );
    const header = await within(slot).findByTestId("pane-header");
    expect(within(header).queryByTestId("branch-chip")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(await screen.findByTestId("menu-thread"));
    const menu = await screen.findByTestId("titlebar-menu-thread");
    await within(menu).findByRole("menuitem", { name: "More…" });
    // The agents' working detail: More… has it, to copy and push.
    expect(within(menu).queryByTestId("branch-chip")).toBeNull();
    expect(menu.textContent).not.toContain("fix/flaky-retry");
  });

  it("holds the thread's menu and the window's controls in one \"…\", each in words", async () => {
    act(() => useTitlebarSlot.getState().setFold(2));
    renderWithApi(
      <>
        <ThreadGrid />
        <TitlebarOverflow orchestration={false} />
      </>,
      api,
    );
    await within(slot).findByTestId("pane-header");
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    const folded = await screen.findByTestId("titlebar-folded");
    // Like every menu, at most seven items: the thread's and the window's are submenus. A solo
    // thread's bar has no workspace's Workers, Tidy up or Pause.
    expect(
      within(folded)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Thread", "View"]);
    expect(within(folded).queryByTestId("folded-workers")).toBeNull();
    expect(within(folded).queryByTestId("menu-workspace")).toBeNull();
    // The carried thread's verbs, as its header's menu had them.
    fireEvent.click(within(folded).getByTestId("menu-thread"));
    const thread = await screen.findByTestId("titlebar-menu-thread");
    expect(within(thread).getByRole("menuitem", { name: "Fork thread" })).toBeTruthy();
    expect(within(thread).getByRole("menuitem", { name: /^Rename/ })).toBeTruthy();
    expect(within(thread).getByRole("menuitem", { name: "More…" })).toBeTruthy();
    // The window's.
    fireEvent.click(within(folded).getByTestId("menu-view"));
    const view = await screen.findByTestId("titlebar-menu-view");
    expect(within(view).getByRole("menuitem", { name: /^Quiet/ })).toBeTruthy();
    expect(within(view).getByRole("menuitem", { name: /^Focus mode/ })).toBeTruthy();
    expect(within(view).getByRole("menuitem", { name: /^History/ })).toBeTruthy();
    expect(within(view).getAllByRole("menuitemradio")).toHaveLength(6);
  });

  it("carries an orchestrator's and a worker's header too", async () => {
    const view = renderWithApi(<ThreadGrid />, api);
    await within(slot).findByTestId("pane-header");
    const { thread } = useThreadsStore.getState().byId[FLAKY]!;

    act(() =>
      useThreadsStore.getState().applyEvent({
        type: "thread.upsert",
        thread: { ...thread, role: "orchestrator" },
      }),
    );
    expect(within(slot).getByTestId("pane-header")).toBeTruthy();
    expect(within(pane()).queryByTestId("pane-header")).toBeNull();

    act(() =>
      useThreadsStore.getState().applyEvent({
        type: "thread.upsert",
        thread: {
          ...thread,
          spawnedBy: { threadId: "t-deps" as ThreadId, feature: "retry" },
        },
      }),
    );
    const header = within(slot).getByTestId("pane-header");
    expect(within(header).getByTestId("worker-crumbs")).toBeTruthy();
    // Narrow, the crumbs above the worker drop whole rather than cut to a letter.
    expect(within(header).getByTestId("worker-crumb-feature").className).toContain(
      "@max-md:hidden",
    );
    expect(within(pane()).queryByTestId("pane-header")).toBeNull();
    view.unmount();
  });

  it("stays in the pane for a second pane, Board, or no title bar to go to", async () => {
    const view = renderWithApi(<ThreadGrid />, api);
    await within(slot).findByTestId("pane-header");

    act(() => useViewStore.setState({ view: "board" }));
    expect(within(slot).queryByTestId("pane-header")).toBeNull();
    expect(within(pane()).getByTestId("pane-header")).toBeTruthy();
    act(() => useViewStore.setState({ view: "chat" }));
    expect(within(slot).getByTestId("pane-header")).toBeTruthy();

    act(() =>
      useLayoutStore.setState({
        grid: { ...EMPTY_GRID, preset: "2c", panes: [FLAKY, "t-deps" as ThreadId], focused: 0 },
      }),
    );
    expect(within(slot).queryByTestId("pane-header")).toBeNull();
    expect(screen.getAllByTestId("pane-header")).toHaveLength(2);
    act(() => useLayoutStore.setState({ grid: { ...EMPTY_GRID, panes: [FLAKY] } }));
    expect(within(slot).getByTestId("pane-header")).toBeTruthy();

    act(() => useTitlebarSlot.getState().setSlot(null));
    expect(within(slot).queryByTestId("pane-header")).toBeNull();
    expect(within(pane()).getByTestId("pane-header")).toBeTruthy();
    view.unmount();
  });
});

describe("a folded part of the bar", () => {
  it("stays laid out to be measured, out of reach of role queries, focus and clicks", () => {
    const view = render(
      <Foldable level={2} gap={4}>
        <button type="button">Workers</button>
      </Foldable>,
    );
    act(() => useTitlebarSlot.getState().setFold(1));
    // Only the lesser buttons folded: Workers stays.
    expect(screen.getByRole("button", { name: "Workers" })).toBeTruthy();

    act(() => useTitlebarSlot.getState().setFold(2));
    // The measuring copy is in the DOM, but no role query, and so no reader, finds it.
    expect(screen.queryByRole("button", { name: "Workers" })).toBeNull();
    const part = screen.getByRole("button", { name: "Workers", hidden: true }).parentElement!;
    expect(part.getAttribute("aria-hidden")).toBe("true");
    expect(part.hasAttribute("inert")).toBe(true);
    view.unmount();
  });
});

/** The title's room in that worker's bar at each fold: folded, the actions' and the switcher's. */
const roomAt1140 = (fold: TitlebarFold) => (fold === 0 ? 430 : 430 + 114 + 35);

describe("when the title bar folds", () => {
  // The lesser buttons are 120 wide with their gaps, Workers 48.
  const wide = { fold: 0, barWidth: 900, spare: 40, overflow: false, widths: [120, 48] } as const;

  it("folds when narrow, when the title is short of its least room, or when its place spills", () => {
    expect(nextFold(wide)).toBe(0);
    expect(nextFold({ ...wide, barWidth: 500 })).toBe(2);
    expect(nextFold({ ...wide, overflow: true })).toBe(1);
    expect(nextFold({ ...wide, fold: 1, overflow: true })).toBe(2);
    expect(nextFold({ ...wide, fold: 2, overflow: true })).toBe(2);
    // With no header to ask, the width alone decides.
    expect(nextFold({ ...wide, spare: Infinity })).toBe(0);
  });

  it("folds the lesser buttons first, and Workers only when they aren't room enough", () => {
    expect(nextFold({ ...wide, spare: -1 })).toBe(1);
    expect(nextFold({ ...wide, spare: -120 })).toBe(1);
    expect(nextFold({ ...wide, spare: -121 })).toBe(2);
    expect(nextFold({ ...wide, fold: 1, spare: -1 })).toBe(2);
  });

  it("unfolds a step only once its buttons fit back, so it never folds again at once", () => {
    // Folding gave the title the buttons' room: giving it back would leave it short again.
    const workers = { ...wide, fold: 2 } as const;
    expect(nextFold({ ...workers, spare: 48 })).toBe(2);
    expect(nextFold({ ...workers, spare: 63 })).toBe(2);
    expect(nextFold({ ...workers, spare: 64 })).toBe(1);
    expect(nextFold({ ...workers, spare: 64, barWidth: 500 })).toBe(2);
    const lesser = { ...wide, fold: 1 } as const;
    expect(nextFold({ ...lesser, spare: 120 })).toBe(1);
    expect(nextFold({ ...lesser, spare: 136 })).toBe(0);
    // With room for both steps, both come back at once.
    expect(nextFold({ ...workers, spare: 200 })).toBe(0);
  });

  it("remembers the width each step folded at, measured unfolded, and the slack it needs back", () => {
    // 12 px short at 1140: back unfolded it needs 1140 + 12 + the slack.
    const short = {
      fold: 0,
      barWidth: 1140,
      spare: -12,
      overflow: false,
      widths: [0, 114],
    } as const;
    expect(nextFold(short)).toBe(2);
    // Each step it folded, with the room the ones before it gave: none from the empty first.
    expect(unfoldWidths(short, 2)).toEqual([1168, 1168]);
    // Folding for what spilled has no room to go by: wider than now by the slack.
    expect(unfoldWidths({ ...short, spare: 40, overflow: true }, 1)).toEqual([1156]);
    // Unfolding forgets the steps it gave back, and keeps the rest.
    const held = { ...short, fold: 2, spare: 400, unfoldAt: [1200, 1168] } as const;
    expect(nextFold({ ...held, barWidth: 1168 })).toBe(1);
    expect(unfoldWidths({ ...held, barWidth: 1168 }, 1)).toEqual([1200]);
    expect(nextFold({ ...held, barWidth: 1200 })).toBe(0);
    // Narrow, the width alone folds and unfolds it.
    expect(unfoldWidths({ ...short, barWidth: 500 }, 2)).toEqual([]);
  });

  it("stays folded while the room it measures folded is only the room folding made", () => {
    // A worker's bar at 1140, as a 1200 px window lays it out: folded, the workspace's switcher
    // narrows (`max-w-20`) and the room grows by the actions' 114 px and the 35 px it gave.
    const least = 442;
    const measure = (fold: TitlebarFold, unfoldAt: readonly number[] | undefined) => ({
      fold,
      barWidth: 1140,
      spare: roomAt1140(fold) - least,
      overflow: false,
      widths: [0, 114],
      unfoldAt,
    });
    let fold: TitlebarFold = 0;
    let unfoldAt: readonly number[] | undefined;
    const seen: TitlebarFold[] = [];
    for (let frame = 0; frame < 8; frame++) {
      const at = measure(fold, unfoldAt);
      const next = nextFold(at);
      unfoldAt = unfoldWidths(at, next);
      fold = next;
      seen.push(fold);
    }
    expect(seen).toEqual([2, 2, 2, 2, 2, 2, 2, 2]);
    // What the bar did before, by its folded room alone: back and forth every frame.
    expect(nextFold(measure(2, undefined))).toBe(0);
    // Wider by what it was short and the slack, the actions come back.
    expect(nextFold({ ...measure(2, unfoldAt), barWidth: 1168 })).toBe(0);
    expect(nextFold({ ...measure(2, unfoldAt), barWidth: 1167 })).toBe(2);
  });
});

describe("the room a title in the bar needs", () => {
  // "Search in Settings" beside a worker's actions, as the review shot lays it out: a 190 px room
  // filled with the role glyph and gaps, the chips given way, and 133 of the title's 134 px showing.
  const cramped = { content: 190, whole: 134, shown: 133, gives: 0 } as const;

  it("is what else the room holds and the title whole, up to a cap, or its least", () => {
    // No title to ask: the least alone.
    expect(titleRoomNeed(96, undefined)).toBe(96);
    // The glyph and gaps (57 px) and the whole title.
    expect(titleRoomNeed(96, cramped)).toBe(57 + 134);
    // The chips give way first: they hold no share of it.
    expect(titleRoomNeed(96, { ...cramped, content: 250, gives: 60 })).toBe(57 + 134);
    // A long title is held to the cap and truncates past it.
    expect(titleRoomNeed(96, { content: 300, whole: 900, shown: 243, gives: 0 })).toBe(57 + 240);
    // A short one needs no more than the least.
    expect(titleRoomNeed(96, { content: 60, whole: 20, shown: 20, gives: 0 })).toBe(96);
  });

  it("folds a worker's actions for a title the bar would cut, and gives them back with room", () => {
    const at = { fold: 0, barWidth: 800, overflow: false, widths: [0, 122] } as const;
    expect(nextFold({ ...at, spare: 190 - titleRoomNeed(96, cramped) })).toBe(2);
    // Folded, the room grows by the actions' width and the title shows whole, the rest free:
    // giving the actions back would cut the title again, so they stay.
    const folded = { content: 191, whole: 134, shown: 134, gives: 0 } as const;
    expect(nextFold({ ...at, fold: 2, spare: 312 - titleRoomNeed(96, folded) })).toBe(2);
    // With the room to spare (a wider window), they come back.
    expect(nextFold({ ...at, fold: 2, spare: 400 - titleRoomNeed(96, folded) })).toBe(0);
  });
});
