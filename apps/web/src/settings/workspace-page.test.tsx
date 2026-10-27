// @vitest-environment happy-dom
import { DEFAULT_SETTINGS, type ProjectId, type Settings } from "@gram/contracts";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMockApi } from "@/api/mock";
import { renderWithApi } from "@/panels/test-utils";
import { useServerSettings } from "@/settings-sync/store";
import { useThreadsStore } from "@/stores/threads";
import { useUndoToasts } from "@/stores/undo-toasts";

import { WorkspaceSettingsPage } from "./workspace-page";
import { WorkspacesSettings } from "./workspace-settings";

const navigate = vi.fn(async (_to: unknown) => {});

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...props }: { children?: ReactNode; "data-testid"?: string }) => (
    <a href="#" data-testid={props["data-testid"]}>
      {children}
    </a>
  ),
  useNavigate: () => navigate,
}));

const settings: Settings = {
  ...DEFAULT_SETTINGS,
};

afterEach(() => {
  cleanup();
  useServerSettings.setState({ settings: undefined });
  useUndoToasts.setState({ toasts: [] });
  useThreadsStore.setState({ byId: {}, ready: false });
  vi.restoreAllMocks();
});

const mount = async () => {
  const api = createMockApi({ speed: 0, autoplay: false });
  useServerSettings.setState({ settings });
  const state = await api.saveWorkspace({
    name: "platform",
    projectIds: ["p-web", "p-api"] as never,
    homeProjectId: "p-web" as ProjectId,
  });
  const stored = async () =>
    (await api.listWorkspaces()).find((each) => each.workspace.id === state.workspace.id)!;
  return { api, state, stored };
};

const undoLast = async () => {
  const toast = useUndoToasts.getState().toasts.at(-1);
  expect(toast).toBeDefined();
  await act(() => toast!.undo());
};

describe("a workspace's settings page", () => {
  it("saves a change at once and offers Undo, which puts back what was there", async () => {
    const { api, state, stored } = await mount();
    renderWithApi(<WorkspaceSettingsPage workspaceId={state.workspace.id} />, api);
    const autonomy = await screen.findByTestId("autonomy");
    expect(autonomy.getAttribute("data-value")).toBe("full");
    fireEvent.click(within(autonomy).getByRole("radio", { name: "Supervised" }));
    await waitFor(async () => expect((await stored()).charter.autonomy).toBe("supervised"));
    await waitFor(() =>
      expect(useUndoToasts.getState().toasts.map((t) => t.title)).toEqual([
        "Autonomy set to Supervised",
      ]),
    );
    await undoLast();
    expect((await stored()).charter.autonomy).toBe("full");
  });

  it("keeps current identity separate from optimistic model preference, refused save and Undo", async () => {
    const { api, state, stored } = await mount();
    const thread = await api.openOrchestrator({ workspaceId: state.workspace.id });
    // Explicit future preference fixture: creating/opening may seed a model of its own.
    const { orchestratorModel: _preference, ...charter } = (await stored()).charter;
    // This control explicitly uses Full, independently of future new-workspace defaults.
    await api.setOrchestratorCharter(state.workspace.id, { ...charter, autonomy: "full" });
    useThreadsStore.getState().applyEvent({ type: "thread.upsert", thread });
    renderWithApi(<WorkspaceSettingsPage workspaceId={state.workspace.id} />, api);
    const current = await screen.findByTestId("orchestrator-current");
    const identity = current.textContent;
    const select = (await screen.findByTestId("orchestrator-model-follow")) as HTMLSelectElement;
    expect((await stored()).charter.autonomy).toBe("full");
    expect(select.value).toBe("follow");
    const original = api.setOrchestratorCharter.bind(api);
    const pending = Promise.withResolvers<void>();
    const save = vi.spyOn(api, "setOrchestratorCharter").mockImplementationOnce(async (...args) => {
      await pending.promise;
      return original(...args);
    });
    fireEvent.change(select, { target: { value: "own" } });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(select.value).toBe("own");
    expect((screen.getByTestId("switch-orchestrator-open") as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(current.textContent).toBe(identity);
    // An async callback keeps the act scope, and the act environment, open while the save that
    // was waiting on `pending` goes on; a sync one returns at once and leaves React's flush of that
    // work to run outside the act environment, which React reports.
    await act(async () => pending.resolve());
    await waitFor(() => expect(useUndoToasts.getState().toasts.at(-1)?.title).toBe("Models saved"));
    expect((screen.getByTestId("switch-orchestrator-open") as HTMLButtonElement).disabled).toBe(
      false,
    );
    await undoLast();
    await waitFor(() => expect(select.value).toBe("follow"));
    expect(current.textContent).toBe(identity);
    expect((await stored()).charter.autonomy).toBe("full");
    save.mockRejectedValueOnce(new Error("Synthetic save refusal"));
    fireEvent.change(select, { target: { value: "own" } });
    expect((await screen.findByRole("alert")).textContent).toContain("Synthetic save refusal");
    await waitFor(() => expect(select.value).toBe("follow"));
    expect(current.textContent).toBe(identity);
    expect((await stored()).charter.orchestratorModel).toBeUndefined();
  });

  it("removes a repository with Undo, but keeps the home repository", async () => {
    const { api, state, stored } = await mount();
    renderWithApi(<WorkspaceSettingsPage workspaceId={state.workspace.id} />, api);
    const repos = await screen.findByTestId("workspace-repos");
    const box = (name: string) =>
      within(repos)
        .getAllByRole("checkbox")
        .find((each) => each.closest("label")?.textContent?.includes(name))!;
    await waitFor(() => expect(box("api")).toBeDefined());
    fireEvent.click(box("web"));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "The home repository stays. Make another one home first.",
    );
    fireEvent.click(box("api"));
    await waitFor(async () => expect((await stored()).workspace.projectIds).toEqual(["p-web"]));
    await undoLast();
    expect((await stored()).workspace.projectIds).toEqual(["p-web", "p-api"]);
  });

  it("pauses with Undo, and resumes without one", async () => {
    const { api, state, stored } = await mount();
    renderWithApi(<WorkspaceSettingsPage workspaceId={state.workspace.id} />, api);
    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
    await waitFor(async () => expect((await stored()).paused?.reason).toBe("user"));
    expect(await screen.findByTestId("workspace-pause-reason")).toBeDefined();
    await undoLast();
    expect((await stored()).paused).toBeUndefined();
    useUndoToasts.setState({ toasts: [] });
    await act(() => api.setOrchestratorPaused(state.workspace.id, true));
    cleanup();
    renderWithApi(<WorkspaceSettingsPage workspaceId={state.workspace.id} />, api);
    fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
    await waitFor(async () => expect((await stored()).paused).toBeUndefined());
    expect(useUndoToasts.getState().toasts).toEqual([]);
  });

  it("says so when the workspace is gone", async () => {
    const { api } = await mount();
    renderWithApi(<WorkspaceSettingsPage workspaceId={"w-missing" as never} />, api);
    expect(await screen.findByTestId("workspace-page-missing")).toBeDefined();
  });
});

describe("the workspace list", () => {
  it("shows each workspace on a line, with its settings a click away", async () => {
    const { api } = await mount();
    renderWithApi(<WorkspacesSettings />, api);
    const row = await screen.findByRole("listitem", { name: "Workspace platform" });
    expect(within(row).getByTestId("workspace-projects").textContent).toBe("web, api");
    expect(within(row).getByTestId("workspace-autonomy").textContent).toBe("Full");
    expect(within(row).getByTestId("workspace-working").textContent).toContain("0 working");
    expect(within(row).getByTestId("workspace-link")).toBeDefined();
    // Global options are in Defaults, the roster new workspaces start with among them: with none
    // saved, none, as the server makes them, not a built-in one they don't get.
    const defaults = screen.getByTestId("workspace-defaults");
    expect(within(defaults).getByTestId("starting-roster").textContent).toBe(
      "None: workers run on the orchestrator's model.",
    );
    // Nothing to copy from while every workspace has that same empty roster.
    expect(within(defaults).getByTestId<HTMLSelectElement>("starting-roster-from").disabled).toBe(
      true,
    );
  });
});
