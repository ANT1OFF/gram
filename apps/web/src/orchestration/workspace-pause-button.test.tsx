// @vitest-environment happy-dom
import type { ThreadId, ThreadStatus, WorkspaceId, WorkspaceState } from "@gram/contracts";
import { Menu } from "@base-ui/react/menu";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";

import type { Api } from "@/api/types";
import { EXPLAIN } from "@/lib/explain";
import { renderInRouter, renderWithApi } from "@/panels/test-utils";
import { useThreadsStore } from "@/stores/threads";
import { useViewWorkspace } from "@/views/view-workspace";

import { PauseItem } from "@/shell/titlebar-fold";

import { TitlebarPause } from "./workspace-pause-button";

// Pause in the title bar's "…" and Resume in the bar, for the workspace the window is on, set by
// hand: one click each, with a short confirm in the menu only while work is mid-flight.

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
          <PauseItem state={workspace()} />
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  </Menu.Root>
);

/** The name of the workspace the window is on, once the server has listed it. */
function Viewing() {
  return <span data-testid="viewing">{useViewWorkspace()?.workspace.name}</span>;
}

/** The title bar's pause on the orchestrator's page, the server listing `state`. */
const renderBar = (state: WorkspaceState, api: Partial<Api> = {}) =>
  renderInRouter(
    <>
      <TitlebarPause />
      <Viewing />
    </>,
    { path: `/t/${ORCH}`, api: { listWorkspaces: async () => [state], ...api } },
  );

afterEach(() => {
  cleanup();
  useThreadsStore.setState({ byId: {} });
});

it('shows nothing in the bar while running: Pause is the "…"\'s', async () => {
  threads("idle", "idle");
  await renderBar(workspace());
  expect((await screen.findByTestId("viewing")).textContent).toBe("Shop");
  expect(screen.queryByTestId("titlebar-pause")).toBeNull();
});

it("pauses in one click when nothing is mid-flight", async () => {
  threads("idle", "idle");
  const setOrchestratorPaused = vi.fn<Api["setOrchestratorPaused"]>(async () => workspace(true));
  renderWithApi(<OpenMenu />, { setOrchestratorPaused, listWorkspaces: async () => [] });
  // What stops, and that only a resume wakes it.
  expect(item().textContent).toBe(`Pause workspace${EXPLAIN.pause}`);
  await act(async () => {
    fireEvent.click(item());
  });
  expect(setOrchestratorPaused).toHaveBeenCalledExactlyOnceWith("w-a", true);
  expect(screen.queryByTestId("folded-pause-confirm")).toBeNull();
});

it("asks first while a worker or the orchestrator is mid-turn, in the menu", async () => {
  threads("running", "running");
  const setOrchestratorPaused = vi.fn<Api["setOrchestratorPaused"]>(async () => workspace(true));
  renderWithApi(<OpenMenu />, { setOrchestratorPaused, listWorkspaces: async () => [] });
  expect(item().textContent).toBe(`Pause workspace…${EXPLAIN.pause}`);
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
  // A pause from today reads as its clock alone; one from another day would carry its date.
  const clock = vi.spyOn(Date, "now").mockReturnValue(PAUSED_AT + 60_000);
  onTestFinished(() => clock.mockRestore());
  threads("idle", "running");
  const setOrchestratorPaused = vi.fn<Api["setOrchestratorPaused"]>(async () => workspace());
  await renderBar(workspace(true), { setOrchestratorPaused });
  expect((await screen.findByTestId("titlebar-pause")).hasAttribute("data-paused")).toBe(true);
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
