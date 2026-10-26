// @vitest-environment happy-dom
import { DEFAULT_SETTINGS, type ProjectId, type Settings } from "@gram/contracts";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createMockApi } from "@/api/mock";
import { OrchestratorChips } from "@/orchestration/worker-banner";
import { renderWithRouter } from "@/panels/test-utils";
import { useServerSettings } from "@/settings-sync/store";
import { useThreadsStore } from "@/stores/threads";
import { useUndoToasts } from "@/stores/undo-toasts";

import { useWorkspaceSheet, WORKSPACE_SHEET_TEST_ID, WorkspaceSheet } from "./workspace-sheet";

const settings: Settings = {
  ...DEFAULT_SETTINGS,
};

afterEach(() => {
  cleanup();
  useServerSettings.setState({ settings: undefined });
  useUndoToasts.setState({ toasts: [] });
  useThreadsStore.setState({ byId: {}, ready: false });
  useWorkspaceSheet.setState({ open: false, workspaceId: undefined });
});

/** A workspace with its orchestrator open, its header beside the sheet as the app mounts it. */
const mount = async () => {
  const api = createMockApi({ speed: 0, autoplay: false });
  useServerSettings.setState({ settings });
  const state = await api.saveWorkspace({
    name: "platform",
    projectIds: ["p-web", "p-api"] as never,
    homeProjectId: "p-web" as ProjectId,
  });
  const thread = await api.openOrchestrator({ workspaceId: state.workspace.id });
  useThreadsStore.getState().applyEvent({ type: "thread.upsert", thread });
  const view = renderWithRouter(
    <>
      <OrchestratorChips thread={thread} />
      <WorkspaceSheet />
    </>,
    api,
  );
  const stored = async () =>
    (await api.listWorkspaces()).find((each) => each.workspace.id === state.workspace.id)!;
  return { ...view, api, state, stored };
};

const sheet = () => screen.queryByTestId(WORKSPACE_SHEET_TEST_ID);

describe("workspace settings in a sheet", () => {
  it("opens from the orchestrator's header, named for the workspace, and saves as the page does", async () => {
    const { stored } = await mount();
    expect(sheet()).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Workspace settings" }));
    const dialog = await screen.findByRole("dialog", { name: "platform" });
    expect(dialog.getAttribute("data-testid")).toBe(WORKSPACE_SHEET_TEST_ID);
    // Autonomy is the segmented control with its one-line caption; a new workspace is at Full.
    const autonomy = await within(dialog).findByTestId("autonomy");
    expect(autonomy.getAttribute("data-value")).toBe("full");
    expect(within(autonomy).getByTestId("autonomy-description").textContent).toContain(
      "Asks about nothing.",
    );
    // The Settings page's way back and its Open orchestrator have no place over the orchestrator.
    expect(within(dialog).queryByTestId("workspace-page-back")).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Open orchestrator" })).toBeNull();
    // The models and storage controls come along unchanged.
    expect(within(dialog).getByText("Models")).toBeDefined();

    fireEvent.click(within(autonomy).getByRole("radio", { name: "Supervised" }));
    await waitFor(async () => expect((await stored()).charter.autonomy).toBe("supervised"));
    await waitFor(() =>
      expect(useUndoToasts.getState().toasts.map((t) => t.title)).toEqual([
        "Autonomy set to Supervised",
      ]),
    );
  });

  it("closes with its Close button and with Esc", async () => {
    await mount();
    fireEvent.click(await screen.findByRole("button", { name: "Workspace settings" }));
    fireEvent.click(await screen.findByTestId("workspace-sheet-close"));
    expect(useWorkspaceSheet.getState().open).toBe(false);
    await waitFor(() => expect(sheet()).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Workspace settings" }));
    const dialog = await screen.findByRole("dialog", { name: "platform" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(useWorkspaceSheet.getState().open).toBe(false));
  });

  it("closes when something in it goes elsewhere", async () => {
    const { router } = await mount();
    fireEvent.click(await screen.findByRole("button", { name: "Workspace settings" }));
    await screen.findByRole("dialog", { name: "platform" });
    await act(() => router.navigate({ to: "/w/some/memory" as never }));
    await waitFor(() => expect(useWorkspaceSheet.getState().open).toBe(false));
  });
});
