// @vitest-environment happy-dom
import type { ThreadId } from "@gram/contracts";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockApi, type MockApi } from "@/api/mock";
import { renderWithApi } from "@/panels/test-utils";
import { EMPTY_GRID, useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";

import { PANE_DRAG_TYPE, THREAD_DRAG_TYPE } from "./drag";
import { ThreadGrid } from "./thread-grid";

const navigate = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children?: ReactNode }) => children,
  useNavigate: () => navigate,
  useParams: () => ({}),
}));

let api: MockApi;

beforeEach(async () => {
  api = createMockApi({ speed: 0, autoplay: false });
  const abort = new AbortController();
  for await (const event of api.events(abort.signal)) {
    useThreadsStore.getState().applyEvent(event);
    if (event.type === "threads.snapshot") break;
  }
  abort.abort();
  useLayoutStore.setState({
    grid: {
      ...EMPTY_GRID,
      preset: "3c",
      panes: ["t-flaky" as ThreadId, "t-deps" as ThreadId, null],
      focused: 0,
    },
  });
});

afterEach(() => {
  cleanup();
  navigate.mockReset();
});

const pane = (index: number) => screen.getAllByTestId("pane")[index]!;

/** A drop carrying `data`, as the browser hands it to the pane. */
const drop = (target: HTMLElement, data: Record<string, string>) => {
  const dataTransfer = { types: Object.keys(data), getData: (type: string) => data[type] ?? "" };
  fireEvent.dragOver(target, { dataTransfer });
  fireEvent.drop(target, { dataTransfer });
};

describe("ThreadGrid", () => {
  it("maximizes and restores on a header double-click, but not on its controls", () => {
    renderWithApi(<ThreadGrid />, api);
    const grid = screen.getByTestId("thread-grid");
    const header = within(pane(1)).getByTestId("pane-header");

    fireEvent.pointerDown(header);
    fireEvent.doubleClick(within(header).getByRole("heading"));
    expect(grid.dataset["maximized"]).toBe("true");
    expect(useLayoutStore.getState().grid.focused).toBe(1);

    fireEvent.doubleClick(within(header).getByRole("button", { name: "Close pane" }));
    expect(grid.dataset["maximized"]).toBe("true");
    fireEvent.doubleClick(header);
    expect(grid.dataset["maximized"]).toBe("false");
  });

  it("swaps panes when a header is dropped on another pane, and places a dropped row", () => {
    renderWithApi(<ThreadGrid />, api);
    const header = within(pane(0)).getByTestId("pane-header");
    expect(header.getAttribute("draggable")).toBe("true");

    act(() => drop(pane(2), { [PANE_DRAG_TYPE]: "0" }));
    expect(useLayoutStore.getState().grid).toMatchObject({
      panes: [null, "t-deps", "t-flaky"],
      focused: 2,
    });

    act(() => drop(pane(0), { [THREAD_DRAG_TYPE]: "t-docs" }));
    expect(useLayoutStore.getState().grid).toMatchObject({
      panes: ["t-docs", "t-deps", "t-flaky"],
      focused: 0,
    });
  });

  it("keeps a single pane's header plain", () => {
    useLayoutStore.setState({ grid: { ...EMPTY_GRID, panes: ["t-flaky" as ThreadId] } });
    renderWithApi(<ThreadGrid />, api);
    const header = screen.getByTestId("pane-header");
    expect(header.getAttribute("draggable")).toBe("false");
    fireEvent.doubleClick(header);
    expect(useLayoutStore.getState().grid.maximized).toBe(false);
  });

  it("offers recent threads that aren't on screen and opens one in the empty pane", () => {
    renderWithApi(<ThreadGrid />, api);
    const list = within(pane(2)).getByRole("region", { name: "Open a thread here" });
    expect(within(list).queryByRole("button", { name: /Fix flaky retry test/ })).toBeNull();
    expect(within(list).queryByRole("button", { name: /gRPC transport/ })).toBeNull();

    fireEvent.click(within(list).getByRole("button", { name: /Rewrite the README/ }));
    expect(useLayoutStore.getState().grid).toMatchObject({
      panes: ["t-flaky", "t-deps", "t-docs"],
      focused: 2,
    });
    expect(navigate).toHaveBeenCalledWith({ to: "/t/$threadId", params: { threadId: "t-docs" } });
  });

  it("starts a new thread from an empty pane with that pane focused for it to land in", () => {
    renderWithApi(<ThreadGrid />, api);
    fireEvent.click(within(pane(2)).getByRole("button", { name: "New thread here" }));
    expect(useLayoutStore.getState().grid.focused).toBe(2);
    expect(navigate).toHaveBeenCalledWith({ to: "/new" });
  });

  it("moves focus into the pane that takes over when a pane's close button is used", async () => {
    renderWithApi(<ThreadGrid />, api);
    const close = within(within(pane(0)).getByTestId("pane-header")).getByRole("button", {
      name: "Close pane",
    });
    close.focus();
    fireEvent.click(close);

    expect(useLayoutStore.getState().grid).toMatchObject({
      panes: [null, "t-deps", null],
      focused: 1,
    });
    await waitFor(() => expect(pane(1).contains(document.activeElement)).toBe(true));
  });
});
