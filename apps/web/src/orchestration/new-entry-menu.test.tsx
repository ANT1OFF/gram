// @vitest-environment happy-dom
import {
  DEFAULT_CHARTER,
  type Project,
  type ProjectId,
  type Thread,
  type ThreadId,
  type WorkspaceId,
  type WorkspaceState,
} from "@gram/contracts";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithApi } from "@/panels/test-utils";
import { EMPTY_GRID, useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";

import { newEntryLabel, newEntryRoute } from "./new-entry";
import { NewEntryMenu } from "./new-entry-menu";
import { useTaskDraftStore } from "./task-draft-store";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));

const project = (name: string): Project => ({
  id: `p-${name}` as ProjectId,
  name,
  root: `/synthetic/${name}`,
  bookmarked: false,
});
const app = project("app");
const bot = project("bot");
const workspace = (name: string, repo: Project): WorkspaceState => ({
  workspace: {
    id: `w-${name}` as WorkspaceId,
    name,
    projectIds: [repo.id],
    homeProjectId: repo.id,
    createdAt: 0,
  },
  charter: DEFAULT_CHARTER,
});
const studio = workspace("Studio", app);
const arb = workspace("Arb", bot);
const OPEN = "t-open" as ThreadId;

/** The focused pane shows a thread of `inWorkspace`, or none. */
const focus = (inWorkspace: WorkspaceState | undefined) => {
  if (inWorkspace === undefined) {
    useLayoutStore.setState({ grid: { ...EMPTY_GRID, panes: [null] } });
    return;
  }
  const thread = {
    id: OPEN,
    projectId: inWorkspace.workspace.projectIds[0],
    workspaceId: inWorkspace.workspace.id,
  } as Thread;
  useThreadsStore.setState({ byId: { [OPEN]: { thread } } } as never);
  useLayoutStore.setState({ grid: { ...EMPTY_GRID, panes: [OPEN] } });
};

const open = async () => {
  renderWithApi(<NewEntryMenu />, {
    listWorkspaces: async () => [studio, arb],
    listProjects: async () => [app, bot],
  });
  // The labels name the default workspace once the list is in.
  await waitFor(() => expect(screen.getByRole("button", { name: "New" })).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "New" }));
  return screen.findByTestId("new-entry-menu");
};

beforeEach(() => {
  navigate.mockReset();
  useTaskDraftStore.setState({ last: undefined, entry: undefined, workers: {} });
});
afterEach(cleanup);

describe("newEntryRoute", () => {
  it("lands each entry on its existing first screen", () => {
    const id = studio.workspace.id;
    expect(newEntryRoute("task")).toEqual({ to: "/new-task", search: {} });
    expect(newEntryRoute("task", id)).toEqual({ to: "/new-task", search: { workspace: id } });
    expect(newEntryRoute("worker", id)).toEqual({
      to: "/new-task",
      search: { way: "direct", workspace: id },
    });
    expect(newEntryRoute("oneOff", id)).toEqual({ to: "/new" });
    expect(newEntryRoute("workspace")).toEqual({ to: "/new-workspace" });
  });

  it("names the workspace a task or worker goes to, when there is one", () => {
    expect(newEntryLabel("task", "Studio")).toBe("Task for Studio's orchestrator");
    expect(newEntryLabel("worker", "Studio")).toBe("Worker in Studio");
    expect(newEntryLabel("task", undefined)).toBe("New task");
    expect(newEntryLabel("worker", undefined)).toBe("New worker");
  });
});

describe("NewEntryMenu", () => {
  it("offers the four entries, for the open thread's workspace", async () => {
    focus(arb);
    const menu = await open();
    await within(menu).findByText("Task for Arb's orchestrator");
    expect(within(menu).getByText("Worker in Arb")).toBeTruthy();
    expect(within(menu).getByText("One-off thread")).toBeTruthy();
    expect(within(menu).getByText("New workspace…")).toBeTruthy();
    expect(within(menu).getAllByRole("separator")).toHaveLength(1);

    fireEvent.click(screen.getByTestId("new-entry-worker"));
    expect(navigate).toHaveBeenCalledWith({
      to: "/new-task",
      search: { way: "direct", workspace: arb.workspace.id },
    });
    expect(useTaskDraftStore.getState().entry).toBe("worker");
  });

  it("goes to the last workspace used without an open thread", async () => {
    focus(undefined);
    useTaskDraftStore.setState({ last: { kind: "workspace", workspaceId: studio.workspace.id } });
    const menu = await open();
    await within(menu).findByText("Task for Studio's orchestrator");
    fireEvent.click(screen.getByTestId("new-entry-task"));
    expect(navigate).toHaveBeenCalledWith({
      to: "/new-task",
      search: { workspace: studio.workspace.id },
    });
  });

  it("sends a task to another workspace from Send to", async () => {
    focus(studio);
    await open();
    fireEvent.keyDown(await screen.findByTestId("new-entry-task"), { key: "ArrowRight" });
    const sendTo = await screen.findByTestId("new-entry-task-to");
    expect(within(sendTo).getByText("Send to")).toBeTruthy();
    fireEvent.click(within(sendTo).getByRole("menuitem", { name: "Arb" }));
    expect(navigate).toHaveBeenCalledWith({
      to: "/new-task",
      search: { workspace: arb.workspace.id },
    });
    expect(useTaskDraftStore.getState().entry).toBe("task");
  });

  it("opens on the entry used last", async () => {
    focus(studio);
    useTaskDraftStore.setState({ entry: "oneOff" });
    await open();
    const oneOff = await screen.findByTestId("new-entry-oneOff");
    await act(() => new Promise(requestAnimationFrame));
    await waitFor(() => expect(oneOff.hasAttribute("data-highlighted")).toBe(true));
    fireEvent.click(oneOff);
    expect(navigate).toHaveBeenCalledWith({ to: "/new" });
  });
});
