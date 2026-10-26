// @vitest-environment happy-dom
import type { ThreadId, ThreadStatus, WorkspaceId, WorkspaceState } from "@gram/contracts";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { create } from "zustand";

import type { Api } from "@/api/types";
import { renderWithApi } from "@/panels/test-utils";
import { useThreadsStore } from "@/stores/threads";

import { TIDY_UP_MESSAGE } from "./board-model";
import { TitlebarTidyUp } from "./tidy-up-button";
import { TIDY_SENT_MS } from "./use-board-actions";

// The title bar's Tidy up against the workspace the window is on, set by hand.

const states = create<{ all: readonly WorkspaceState[] }>()(() => ({ all: [] }));
vi.mock("@/views/view-workspace", () => ({
  useViewWorkspace: () => states((s) => s.all[0]),
}));

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

const button = () => screen.getByTestId("titlebar-tidy");

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  states.setState({ all: [] });
  useThreadsStore.setState({ byId: {} });
});

it("isn't there without a workspace", () => {
  renderWithApi(<TitlebarTidyUp />, {});
  expect(screen.queryByTestId("titlebar-tidy")).toBeNull();
});

it("is disabled, and says why, while there is no orchestrator that can take a message", () => {
  states.setState({ all: [workspace()] });
  const send = vi.fn<Api["send"]>();
  const { unmount } = renderWithApi(<TitlebarTidyUp />, { send });
  expect(button().getAttribute("aria-disabled")).toBe("true");
  expect(button().getAttribute("aria-label")).toBe("Tidy up (No orchestrator yet: open it first)");
  fireEvent.click(button());
  unmount();

  states.setState({ all: [workspace(ORCH)] });
  withOrchestrator("ended");
  renderWithApi(<TitlebarTidyUp />, { send });
  expect(button().getAttribute("aria-label")).toBe("Tidy up (The orchestrator thread has ended)");
  fireEvent.click(button());
  expect(send).not.toHaveBeenCalled();
});

it("sends the board's tidy-up message, rests while it shows it went, then comes back", async () => {
  vi.useFakeTimers();
  states.setState({ all: [workspace(ORCH)] });
  withOrchestrator("running");
  const send = vi.fn<Api["send"]>(async () => ({ queued: true }) as never);
  renderWithApi(<TitlebarTidyUp />, { send });
  expect(button().getAttribute("aria-label")).toBe("Tidy up");
  expect(button().getAttribute("aria-disabled")).not.toBe("true");

  await act(async () => {
    fireEvent.click(button());
  });
  expect(send).toHaveBeenCalledExactlyOnceWith(ORCH, { text: TIDY_UP_MESSAGE });
  expect(button().getAttribute("data-sent")).toBe("queued");
  expect(button().getAttribute("aria-disabled")).toBe("true");
  expect(screen.getByRole("status").textContent).toBe(
    "Asked: the orchestrator tidies up once its current turn ends",
  );
  // Resting: a second press doesn't queue a second sweep.
  fireEvent.click(button());
  expect(send).toHaveBeenCalledOnce();

  act(() => vi.advanceTimersByTime(TIDY_SENT_MS));
  expect(button().hasAttribute("data-sent")).toBe(false);
  expect(button().getAttribute("aria-disabled")).not.toBe("true");
});

it("says so when the message couldn't be sent", async () => {
  states.setState({ all: [workspace(ORCH)] });
  withOrchestrator("idle");
  const applyEvent = vi.spyOn(useThreadsStore.getState(), "applyEvent");
  const send = vi.fn<Api["send"]>(async () => {
    throw new Error("offline");
  });
  renderWithApi(<TitlebarTidyUp />, { send });
  await act(async () => {
    fireEvent.click(button());
  });
  expect(applyEvent).toHaveBeenCalledWith(
    expect.objectContaining({ type: "notify", title: "Couldn't ask the orchestrator to tidy up" }),
  );
  expect(button().hasAttribute("data-sent")).toBe(false);
  expect(button().getAttribute("aria-disabled")).not.toBe("true");
});
