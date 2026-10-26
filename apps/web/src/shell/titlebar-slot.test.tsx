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

import { Foldable } from "./titlebar-fold";
import { nextFold, useTitlebarSlot } from "./titlebar-slot";
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
    expect(within(header).getByRole("button", { name: "Thread menu" })).toBeTruthy();
    // The composer and the transcript stay in the pane.
    expect(within(pane()).getByLabelText("Message", { exact: true })).toBeTruthy();
    // The title and the empty room drag the window; the chips and the buttons after it don't.
    expect(header.className).toContain("[&>*:not(:first-child)]:[-webkit-app-region:no-drag]");
    expect(within(header).getByTestId("pane-header-chips").className).toContain(
      "[-webkit-app-region:no-drag]",
    );
  });

  it("keeps the branch out of the bar and the thread menu", async () => {
    renderWithApi(<ThreadGrid />, api);
    const header = await within(slot).findByTestId("pane-header");
    expect(within(header).queryByTestId("branch-chip")).toBeNull();

    fireEvent.click(within(header).getByRole("button", { name: "Thread menu" }));
    const menu = await screen.findByTestId("thread-menu");
    await within(menu).findByRole("menuitem", { name: "More…" });
    // The agents' working detail: More… has it, to copy and push.
    expect(within(menu).queryByTestId("branch-chip")).toBeNull();
    expect(menu.textContent).not.toContain("fix/flaky-retry");
    // Not folded, the window's buttons are the bar's, not the menu's.
    expect(screen.queryByTestId("titlebar-folded")).toBeNull();
  });

  it("takes the narrow bar's folded buttons into the thread menu", async () => {
    act(() => useTitlebarSlot.getState().setFold(2));
    renderWithApi(<ThreadGrid />, api);
    const header = await within(slot).findByTestId("pane-header");
    fireEvent.click(within(header).getByRole("button", { name: "Thread menu" }));
    // One item in the menu, so it keeps to its cap: the Title bar submenu holds them.
    fireEvent.click(await screen.findByRole("menuitem", { name: /^Title bar/ }));
    const folded = await screen.findByTestId("titlebar-folded");
    expect(within(folded).getByRole("menuitem", { name: /^Quiet/ })).toBeTruthy();
    expect(within(folded).getByRole("menuitem", { name: /^Focus mode/ })).toBeTruthy();
    expect(within(folded).getAllByRole("menuitemradio")).toHaveLength(6);
    // A solo thread's bar has no Tidy up to fold.
    expect(within(folded).queryByTestId("folded-tidy")).toBeNull();
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
});
