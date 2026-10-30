// @vitest-environment happy-dom
import type { ThreadId } from "@gram/contracts";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockApi, type MockApi } from "@/api/mock";
import { draftProjectPrefill, prefillDraftProject } from "@/composer/draft-prefill";
import { useBindingsStore } from "@/keyboard/bindings-store";
import { installKeyboard } from "@/keyboard/registry";
import { renderWithApi } from "@/panels/test-utils";
import { EMPTY_GRID, useLayoutStore } from "@/stores/layout";
import { useThreadHistory } from "@/stores/thread-history";
import { useThreadsStore } from "@/stores/threads";

import { ThreadSwitcher } from "./thread-switcher";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  useParams: () => ({}),
}));

const FLAKY = "t-flaky" as ThreadId;
const QUESTION = "t-question" as ThreadId;
let api: MockApi;
let uninstall: () => void;

beforeEach(async () => {
  api = createMockApi({ speed: 0, autoplay: false });
  const abort = new AbortController();
  for await (const event of api.events(abort.signal)) {
    useThreadsStore.getState().applyEvent(event);
    if (event.type === "threads.snapshot") break;
  }
  abort.abort();
  useLayoutStore.setState({ grid: EMPTY_GRID });
  useThreadHistory.setState({ recent: [] });
  uninstall = installKeyboard(window);
});

afterEach(() => {
  cleanup();
  uninstall();
  navigate.mockReset();
  prefillDraftProject(undefined);
});

const ctrlTab = (shiftKey = false) =>
  fireEvent.keyDown(window, { key: "Tab", code: "Tab", ctrlKey: true, shiftKey });

const selected = () =>
  screen.getByTestId("thread-switcher").querySelector('[aria-current="true"]')?.textContent;

/** Focuses the flaky thread, then the question, so the question is the most recent. */
const visitBoth = () => {
  act(() => useLayoutStore.getState().openThread(FLAKY));
  act(() => useLayoutStore.getState().openThread(QUESTION));
};

describe("ThreadSwitcher", () => {
  it("walks recent threads while Ctrl is held and opens the pick on release", () => {
    renderWithApi(<ThreadSwitcher />, api);
    visitBoth();

    ctrlTab();
    expect(selected()).toContain("Fix flaky retry test");
    ctrlTab(true);
    expect(selected()).toContain("Pick a date library");
    ctrlTab();
    fireEvent.keyUp(window, { key: "Control" });

    expect(screen.queryByTestId("thread-switcher")).toBeNull();
    expect(navigate).toHaveBeenCalledWith({ to: "/t/$threadId", params: { threadId: FLAKY } });
    const { grid } = useLayoutStore.getState();
    expect(grid.panes[grid.focused]).toBe(FLAKY);
  });

  it("finishes on the rebound chord's modifier, not on Control", () => {
    useBindingsStore.setState({ overrides: { "thread.cycleNext": "alt+tab" } });
    try {
      renderWithApi(<ThreadSwitcher />, api);
      visitBoth();

      fireEvent.keyDown(window, { key: "Tab", code: "Tab", altKey: true });
      expect(selected()).toContain("Fix flaky retry test");
      // Neither another modifier nor the chord's own key ends it while Alt is held.
      fireEvent.keyUp(window, { key: "Control" });
      fireEvent.keyUp(window, { key: "Tab", code: "Tab" });
      expect(screen.queryByTestId("thread-switcher")).not.toBeNull();
      fireEvent.keyUp(window, { key: "Alt" });
      expect(screen.queryByTestId("thread-switcher")).toBeNull();
      expect(navigate).toHaveBeenCalledWith({ to: "/t/$threadId", params: { threadId: FLAKY } });
    } finally {
      useBindingsStore.setState({ overrides: {} });
    }
  });

  it("cancels on Escape without switching", () => {
    renderWithApi(<ThreadSwitcher />, api);
    visitBoth();

    ctrlTab();
    fireEvent.keyDown(window, { key: "Escape", code: "Escape", ctrlKey: true });
    expect(screen.queryByTestId("thread-switcher")).toBeNull();
    fireEvent.keyUp(window, { key: "Control" });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("drafts a new thread in the focused thread's folder on mod+t", () => {
    renderWithApi(<ThreadSwitcher />, api);
    act(() => useLayoutStore.getState().openThread(FLAKY));

    fireEvent.keyDown(window, { key: "t", code: "KeyT", ctrlKey: true });
    fireEvent.keyDown(window, { key: "t", code: "KeyT", metaKey: true });

    expect(navigate).toHaveBeenCalledWith({ to: "/new" });
    const checkout = useThreadsStore.getState().byId[FLAKY]!.thread.checkout;
    expect(draftProjectPrefill()).toBe(checkout.repoRoot ?? checkout.path);
  });
});
