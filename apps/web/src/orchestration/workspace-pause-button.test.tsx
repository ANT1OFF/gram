// @vitest-environment happy-dom
import type { ThreadId, ThreadStatus, WorkspaceId, WorkspaceState } from "@gram/contracts";
import { Menu } from "@base-ui/react/menu";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { create } from "zustand";

import type { Api } from "@/api/types";
import { renderWithApi } from "@/panels/test-utils";
import { useThreadsStore } from "@/stores/threads";

import { PauseItem } from "@/shell/titlebar-fold";

import { TitlebarPause } from "./workspace-pause-button";

// Pause in the title bar's "…" and Resume in the bar, for the workspace the window is on, set by
// hand: one click each, with a short confirm in the menu only while work is mid-flight.

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
const item = () => screen.getByTestId("folded-pause");

/** The title bar's "…", open, with its Pause. */
const OpenMenu = () => (
  <Menu.Root open>
    <Menu.Portal>
      <Menu.Positioner>
        <Menu.Popup>
          <PauseItem state={states.getState().all[0]!} />
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  </Menu.Root>
);

afterEach(() => {
  cleanup();
  states.setState({ all: [] });
  useThreadsStore.setState({ byId: {} });
});

it('shows nothing in the bar while running: Pause is the "…"\'s', () => {
  states.setState({ all: [workspace()] });
  threads("idle", "idle");
  renderWithApi(<TitlebarPause />, { listWorkspaces: async () => [] });
  expect(screen.queryByTestId("titlebar-pause")).toBeNull();
});

it("pauses in one click when nothing is mid-flight", async () => {
  states.setState({ all: [workspace()] });
  threads("idle", "idle");
  const setOrchestratorPaused = vi.fn<Api["setOrchestratorPaused"]>(
    async () => workspace(true) as never,
  );
  renderWithApi(<OpenMenu />, { setOrchestratorPaused, listWorkspaces: async () => [] });
  expect(item().textContent).toBe("Pause workspace");
  await act(async () => {
    fireEvent.click(item());
  });
  expect(setOrchestratorPaused).toHaveBeenCalledExactlyOnceWith("w-a", true);
  expect(screen.queryByTestId("folded-pause-confirm")).toBeNull();
});

it("asks first while a worker or the orchestrator is mid-turn, in the menu", async () => {
  states.setState({ all: [workspace()] });
  threads("running", "running");
  const setOrchestratorPaused = vi.fn<Api["setOrchestratorPaused"]>(
    async () => workspace(true) as never,
  );
  renderWithApi(<OpenMenu />, { setOrchestratorPaused, listWorkspaces: async () => [] });
  expect(item().textContent).toBe("Pause workspace…");
  await act(async () => {
    fireEvent.click(item());
  });
  expect(setOrchestratorPaused).not.toHaveBeenCalled();
  const confirm = await screen.findByTestId("folded-pause-confirm");
  expect(confirm.textContent).toContain("The orchestrator and 1 worker are mid-turn.");
  expect(confirm.textContent).toContain("finishes the step it is on, then stops");
  expect(confirm.textContent).toContain("Pause Shop anyway");

  await act(async () => {
    fireEvent.click(await screen.findByTestId("folded-pause-confirmed"));
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
