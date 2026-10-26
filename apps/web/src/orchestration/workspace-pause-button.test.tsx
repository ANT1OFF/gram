// @vitest-environment happy-dom
import type { ThreadId, ThreadStatus, WorkspaceId, WorkspaceState } from "@gram/contracts";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { create } from "zustand";

import type { Api } from "@/api/types";
import { renderWithApi } from "@/panels/test-utils";
import { useThreadsStore } from "@/stores/threads";

import { TitlebarPause } from "./workspace-pause-button";

// The title bar's Pause and Resume for the workspace the window is on, set by hand: one click
// each, with a short confirm only while work is mid-flight.

const states = create<{ all: readonly WorkspaceState[] }>()(() => ({ all: [] }));
vi.mock("@/views/view-workspace", () => ({
  useViewWorkspace: () => states((s) => s.all[0]),
}));

const ORCH = "w-a-orch" as ThreadId;
const WORKER = "w-a-worker" as ThreadId;
const PAUSED_AT = new Date(2026, 9, 18, 14, 2).getTime();

const workspace = (paused = false): WorkspaceState =>
  ({
    workspace: { id: "w-a" as WorkspaceId, name: "Shop", orchestratorThreadId: ORCH },
    ...(paused ? { paused: { reason: "user", at: PAUSED_AT } } : {}),
  }) as unknown as WorkspaceState;

const threads = (orchestrator: ThreadStatus, worker: ThreadStatus) =>
  useThreadsStore.setState({
    byId: {
      [ORCH]: {
        status: orchestrator,
        thread: { id: ORCH, workspaceId: "w-a", role: "orchestrator" },
      },
      [WORKER]: {
        status: worker,
        thread: {
          id: WORKER,
          workspaceId: "w-a",
          spawnedBy: { threadId: ORCH, feature: "mail" },
          checkout: { kind: "worktree" },
        },
      },
    } as never,
  });

const button = () => screen.getByTestId("titlebar-pause");

afterEach(() => {
  cleanup();
  states.setState({ all: [] });
  useThreadsStore.setState({ byId: {} });
});

it("pauses in one click when nothing is mid-flight", async () => {
  states.setState({ all: [workspace()] });
  threads("idle", "idle");
  const setOrchestratorPaused = vi.fn<Api["setOrchestratorPaused"]>(
    async () => workspace(true) as never,
  );
  renderWithApi(<TitlebarPause />, { setOrchestratorPaused, listWorkspaces: async () => [] });
  expect(button().getAttribute("aria-label")).toBe("Pause");
  await act(async () => {
    fireEvent.click(button());
  });
  expect(setOrchestratorPaused).toHaveBeenCalledExactlyOnceWith("w-a", true);
  expect(screen.queryByTestId("titlebar-pause-confirm")).toBeNull();
});

it("asks first while a worker or the orchestrator is mid-turn, and Cancel pauses nothing", async () => {
  states.setState({ all: [workspace()] });
  threads("running", "running");
  const setOrchestratorPaused = vi.fn<Api["setOrchestratorPaused"]>(
    async () => workspace(true) as never,
  );
  renderWithApi(<TitlebarPause />, { setOrchestratorPaused, listWorkspaces: async () => [] });
  await act(async () => {
    fireEvent.click(button());
  });
  expect(setOrchestratorPaused).not.toHaveBeenCalled();
  const confirm = await screen.findByTestId("titlebar-pause-confirm");
  expect(confirm.textContent).toContain("Pause Shop?");
  expect(confirm.textContent).toContain("The orchestrator and 1 worker are mid-turn.");
  expect(confirm.textContent).toContain("finishes the step it is on, then stops");

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  });
  expect(setOrchestratorPaused).not.toHaveBeenCalled();

  await act(async () => {
    fireEvent.click(button());
  });
  await act(async () => {
    fireEvent.click(await screen.findByTestId("titlebar-pause-confirm-pause"));
  });
  expect(setOrchestratorPaused).toHaveBeenCalledExactlyOnceWith("w-a", true);
});

it("says since when it is paused, on the 24-hour clock, and resumes in one click", async () => {
  states.setState({ all: [workspace(true)] });
  threads("idle", "running");
  const setOrchestratorPaused = vi.fn<Api["setOrchestratorPaused"]>(
    async () => workspace() as never,
  );
  renderWithApi(<TitlebarPause />, { setOrchestratorPaused, listWorkspaces: async () => [] });
  expect(button().hasAttribute("data-paused")).toBe(true);
  expect(button().textContent).toBe("Paused 14:02");
  expect(button().getAttribute("aria-label")).toBe(
    "Paused by you since 14:02. Resume orchestration",
  );
  await act(async () => {
    fireEvent.click(button());
  });
  expect(setOrchestratorPaused).toHaveBeenCalledExactlyOnceWith("w-a", false);
  expect(screen.queryByTestId("titlebar-pause-confirm")).toBeNull();
});
