// @vitest-environment happy-dom
import { Menu } from "@base-ui/react/menu";
import type { ThreadId, ThreadStatus, WorkspaceId, WorkspaceState } from "@gram/contracts";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { create } from "zustand";

import type { Api } from "@/api/types";
import { EXPLAIN } from "@/lib/explain";
import { DISCOVER_MESSAGE, TIDY_UP_MESSAGE } from "@/orchestration/board-model";
import { TIDY_SENT_MS } from "@/orchestration/use-board-actions";
import { renderWithApi } from "@/panels/test-utils";
import { useThreadsStore } from "@/stores/threads";

import { DiscoverItem, TidyItem, TidyScope } from "./titlebar-fold";

// The title bar's "…" Tidy up against a workspace set by hand. The bar holds its state, so a menu
// that closes and opens again still says it asked.

const ORCH = "w-a-orch" as ThreadId;

const workspace = (orchestratorThreadId?: ThreadId): WorkspaceState =>
  ({
    workspace: {
      id: "w-a" as WorkspaceId,
      name: "w-a",
      ...(orchestratorThreadId === undefined ? {} : { orchestratorThreadId }),
    },
  }) as unknown as WorkspaceState;

const withOrchestrator = (status: ThreadStatus) =>
  useThreadsStore.setState({
    byId: { [ORCH]: { status, thread: { id: ORCH, workspaceId: "w-a" } } as never },
  });

/** Whether the "…" is open, as a click on it or outside it sets it. */
const menu = create<{ open: boolean }>()(() => ({ open: true }));

/** The bar's scope around a menu that opens and closes. */
const Bar = ({ state }: { state: WorkspaceState }) => (
  <TidyScope state={state}>
    <Menu.Root open={menu((s) => s.open)}>
      <Menu.Portal>
        <Menu.Positioner>
          <Menu.Popup>
            <TidyItem />
            <DiscoverItem />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  </TidyScope>
);

const item = () => screen.getByTestId("folded-tidy");

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useThreadsStore.setState({ byId: {} });
  menu.setState({ open: true });
});

it("is disabled, and says why in words, while there is no orchestrator that can take a message", () => {
  const send = vi.fn<Api["send"]>();
  const { unmount } = renderWithApi(<Bar state={workspace()} />, { send });
  expect(item().getAttribute("aria-disabled")).toBe("true");
  expect(item().textContent).toBe("Tidy upNo orchestrator yet: open it first");
  fireEvent.click(item());
  unmount();

  withOrchestrator("ended");
  renderWithApi(<Bar state={workspace(ORCH)} />, { send });
  expect(item().textContent).toBe("Tidy upThe orchestrator thread has ended");
  fireEvent.click(item());
  expect(send).not.toHaveBeenCalled();
});

it("sends the board's tidy-up message, says so, rests across a reopen, then comes back", async () => {
  vi.useFakeTimers();
  withOrchestrator("running");
  const applyEvent = vi.spyOn(useThreadsStore.getState(), "applyEvent");
  const send = vi.fn<Api["send"]>(async () => ({ queued: true }) as never);
  renderWithApi(<Bar state={workspace(ORCH)} />, { send });
  // Its name, and under it what it asks the orchestrator to do.
  expect(item().textContent).toBe(`Tidy up${EXPLAIN.tidyUp}`);
  expect(item().getAttribute("aria-disabled")).not.toBe("true");

  await act(async () => {
    fireEvent.click(item());
  });
  expect(send).toHaveBeenCalledExactlyOnceWith(ORCH, { text: TIDY_UP_MESSAGE });
  // The menu has closed by then: a toast says it went.
  expect(applyEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "notify",
      title: "Asked the orchestrator to tidy up",
      body: "It starts once its current turn ends.",
    }),
  );
  // Closed and opened again, it still rests: a second press doesn't queue a second sweep.
  act(() => menu.setState({ open: false }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
  expect(screen.queryByTestId("folded-tidy")).toBeNull();
  act(() => menu.setState({ open: true }));
  expect(item().getAttribute("data-sent")).toBe("queued");
  expect(item().textContent).toBe("Asked to tidy up");
  expect(item().getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(item());
  expect(send).toHaveBeenCalledOnce();

  act(() => vi.advanceTimersByTime(TIDY_SENT_MS));
  expect(item().hasAttribute("data-sent")).toBe(false);
  expect(item().getAttribute("aria-disabled")).not.toBe("true");
});

it("says so when the message couldn't be sent", async () => {
  withOrchestrator("idle");
  const applyEvent = vi.spyOn(useThreadsStore.getState(), "applyEvent");
  const send = vi.fn<Api["send"]>(async () => {
    throw new Error("offline");
  });
  renderWithApi(<Bar state={workspace(ORCH)} />, { send });
  await act(async () => {
    fireEvent.click(item());
  });
  expect(applyEvent).toHaveBeenCalledWith(
    expect.objectContaining({ type: "notify", title: "Couldn't ask the orchestrator to tidy up" }),
  );
  expect(item().hasAttribute("data-sent")).toBe(false);
  expect(item().getAttribute("aria-disabled")).not.toBe("true");
});

const discover = () => screen.getByTestId("folded-discover");

it("offers Discover beside Tidy up, off with the same reason while there is no orchestrator", () => {
  const send = vi.fn<Api["send"]>();
  renderWithApi(<Bar state={workspace()} />, { send });
  expect(discover().getAttribute("aria-disabled")).toBe("true");
  expect(discover().textContent).toBe("Discover workspaceNo orchestrator yet: open it first");
  fireEvent.click(discover());
  expect(send).not.toHaveBeenCalled();
});

it("sends the discover message, says so, and rests on its own, apart from Tidy up", async () => {
  vi.useFakeTimers();
  withOrchestrator("idle");
  const applyEvent = vi.spyOn(useThreadsStore.getState(), "applyEvent");
  const send = vi.fn<Api["send"]>(async () => ({ queued: false }) as never);
  renderWithApi(<Bar state={workspace(ORCH)} />, { send });
  expect(discover().textContent).toBe(`Discover workspace${EXPLAIN.discover}`);

  await act(async () => {
    fireEvent.click(discover());
  });
  expect(send).toHaveBeenCalledExactlyOnceWith(ORCH, { text: DISCOVER_MESSAGE });
  expect(applyEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "notify",
      title: "Asked the orchestrator to discover the workspace",
      body: "It asks which starter tasks to start once the survey is done.",
    }),
  );
  expect(discover().getAttribute("data-sent")).toBe("sent");
  expect(discover().textContent).toBe("Asked to discover");
  expect(discover().getAttribute("aria-disabled")).toBe("true");
  // Tidy up is not resting on Discover's send.
  expect(item().getAttribute("aria-disabled")).not.toBe("true");

  act(() => vi.advanceTimersByTime(TIDY_SENT_MS));
  expect(discover().hasAttribute("data-sent")).toBe(false);
});
