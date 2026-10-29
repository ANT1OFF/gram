// @vitest-environment happy-dom
import {
  type Autonomy,
  DEFAULT_SETTINGS,
  type ProjectId,
  type Settings,
  type WorkspaceId,
} from "@gram/contracts";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockApi } from "@/api/mock";
import { dispatchShortcut } from "@/keyboard/registry";
import { renderWithApi } from "@/panels/test-utils";
import { autonomyLevel } from "@/settings/workspace-settings-model";
import { useServerSettings } from "@/settings-sync/store";

import { NewWorkspaceSheet } from "./new-workspace";

const navigate = vi.fn(async (_to: unknown) => {});
const back = vi.fn();
let canGoBack = true;

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children?: ReactNode }) => <a href="#">{children}</a>,
  useNavigate: () => navigate,
  useRouter: () => ({ history: { canGoBack: () => canGoBack, back } }),
}));

const settingsWith = (onboarding: Partial<Settings["onboarding"]>): Settings => ({
  ...DEFAULT_SETTINGS,
  onboarding: { ...DEFAULT_SETTINGS.onboarding, ...onboarding },
});

const API = "p-api" as ProjectId;
const DOCS = "p-docs" as ProjectId;

const mount = async (settings: Settings) => {
  const api = createMockApi({ speed: 0, autoplay: false });
  vi.spyOn(api, "updateSettings").mockImplementation(async () => settings);
  useServerSettings.setState({ settings });
  return {
    api,
    render: (props: { from?: WorkspaceId; repo?: ProjectId } = {}) =>
      renderWithApi(<NewWorkspaceSheet {...props} />, api),
  };
};

const form = () => screen.getByRole("form", { name: "New workspace" });
const chips = () => screen.queryAllByTestId("new-workspace-repo").map((chip) => chip.textContent);

const chord = (event: KeyboardEvent) => {
  if (!event.defaultPrevented) dispatchShortcut(event, true);
};

const startChord = (target: Element) => {
  window.addEventListener("keydown", chord);
  try {
    fireEvent.keyDown(target, { key: "Enter", metaKey: true });
  } finally {
    window.removeEventListener("keydown", chord);
  }
};

beforeEach(() => {
  navigate.mockClear();
  back.mockClear();
  canGoBack = true;
});

afterEach(() => {
  cleanup();
  useServerSettings.setState({ settings: undefined });
});

describe("NewWorkspaceSheet", { timeout: 20_000 }, () => {
  it("is one sheet: repos, what to work on and autonomy, nothing else", async () => {
    const { render } = await mount(settingsWith({ welcomeSeen: true }));
    render({ repo: API });
    await screen.findByRole("form", { name: "New workspace" });
    expect(chips()).toEqual(["api"]);
    expect(screen.getByLabelText("What should it work on?")).toBe(document.activeElement);
    expect(within(form()).getByTestId("autonomy")).toBeTruthy();
    // No name, models or steps: they wait for the workspace's settings.
    expect(screen.queryByRole("navigation", { name: "Steps" })).toBeNull();
    expect(screen.queryByLabelText("Name")).toBeNull();
    expect(screen.queryByTestId("workspace-guide")).toBeNull();
  });

  it("makes what it should work on the orchestrator's first message", async () => {
    const { api, render } = await mount(settingsWith({}));
    const save = vi.spyOn(api, "saveWorkspace");
    const task = vi.spyOn(api, "startTask");
    const open = vi.spyOn(api, "openOrchestrator");
    render({ repo: API });
    await screen.findByRole("form", { name: "New workspace" });
    fireEvent.change(screen.getByLabelText("What should it work on?"), {
      target: { value: "  Add mail triggers  " },
    });
    startChord(form());
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    const made = await save.mock.results[0]!.value;
    expect(save.mock.calls[0]![0]).toMatchObject({
      name: "api",
      projectIds: [API],
      homeProjectId: API,
    });
    expect(task).toHaveBeenCalledWith({
      target: { workspaceId: made.workspace.id },
      input: { text: "Add mail triggers" },
    });
    expect(open).not.toHaveBeenCalled();
    const thread = await task.mock.results[0]!.value;
    expect(thread.workspaceId).toBe(made.workspace.id);
    expect(navigate).toHaveBeenCalledWith({
      to: "/t/$threadId",
      params: { threadId: thread.id },
    });
    // The first run is done once the workspace exists.
    expect(api.updateSettings).toHaveBeenCalledWith({ onboarding: { welcomeSeen: true } });
  });

  it("opens the orchestrator without a message when the field is left empty, numbering the name", async () => {
    const { api, render } = await mount(settingsWith({ welcomeSeen: true }));
    await api.saveWorkspace({ name: "docs", projectIds: [API], homeProjectId: API });
    const save = vi.spyOn(api, "saveWorkspace");
    const task = vi.spyOn(api, "startTask");
    const open = vi.spyOn(api, "openOrchestrator");
    render({ repo: DOCS });
    await screen.findByRole("form", { name: "New workspace" });
    fireEvent.click(screen.getByTestId("new-workspace-start"));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(save.mock.calls[0]![0].name).toBe("docs 2");
    expect(task).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledOnce();
    expect(api.updateSettings).not.toHaveBeenCalled();
  });

  it("starts with autonomy picked on the sheet", async () => {
    const { api, render } = await mount(settingsWith({ welcomeSeen: true }));
    const save = vi.spyOn(api, "saveWorkspace");
    render({ repo: API });
    await screen.findByRole("form", { name: "New workspace" });
    fireEvent.click(within(screen.getByTestId("autonomy")).getByRole("radio", { name: /Publish/ }));
    fireEvent.click(screen.getByTestId("new-workspace-start"));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0]![0].charter?.autonomy).toBe("publish");
  });

  it("marks the selected autonomy level on the sheet's card, not by its fill alone", async () => {
    const { render } = await mount(settingsWith({ welcomeSeen: true }));
    render({ repo: API });
    await screen.findByRole("form", { name: "New workspace" });
    const autonomy = screen.getByTestId("autonomy");
    const marked = () =>
      within(autonomy)
        .getAllByRole("radio")
        .filter((radio) => radio.getAttribute("aria-checked") === "true")
        .map((radio) => ({
          name: radio.textContent,
          slab: radio.querySelector('[data-testid="segment-slab"]')?.className ?? "",
        }));
    // The sheet is a card, and the slab's fill is a card's too: the track and hairline show it.
    expect(within(autonomy).getByRole("radiogroup").className).toContain("bg-accent");
    const [initial] = marked();
    expect(marked()).toHaveLength(1);
    expect(initial!.name).toBe(
      autonomyLevel(autonomy.getAttribute("data-value") as Autonomy).label,
    );
    expect(initial!.slab).toContain("ring-1");
    expect(within(autonomy).getAllByTestId("segment-slab")).toHaveLength(1);

    fireEvent.click(within(autonomy).getByRole("radio", { name: "Publish" }));
    await waitFor(() => expect(marked().map(({ name }) => name)).toEqual(["Publish"]));
    expect(marked()[0]!.slab).toContain("ring-1");
  });

  it("asks for a repository first, adds one from the list and removes it with its chip", async () => {
    const { api, render } = await mount(settingsWith({ welcomeSeen: true }));
    const save = vi.spyOn(api, "saveWorkspace");
    render();
    await screen.findByRole("form", { name: "New workspace" });
    // Nothing picked, so the list is open.
    expect(screen.getByTestId("new-workspace-add").getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByTestId("new-workspace-start"));
    await screen.findByText("Pick at least one repository.");
    expect(save).not.toHaveBeenCalled();

    const list = within(await screen.findByTestId("new-workspace-checklist"));
    fireEvent.click(list.getByRole("checkbox", { name: /^web/ }));
    fireEvent.click(list.getByRole("checkbox", { name: /^api/ }));
    expect(chips()).toEqual(["web", "api"]);
    fireEvent.click(screen.getByRole("button", { name: "Remove web" }));
    expect(chips()).toEqual(["api"]);
    fireEvent.click(screen.getByTestId("new-workspace-start"));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0]![0]).toMatchObject({ projectIds: [API], homeProjectId: API });
  });

  it("waits for both unset-default discoveries and creates with the resulting Codex choice", async () => {
    const { api, render } = await mount(settingsWith({ welcomeSeen: true }));
    const codex = Promise.withResolvers<Awaited<ReturnType<typeof api.listModels>>>();
    const claude = Promise.withResolvers<Awaited<ReturnType<typeof api.listModels>>>();
    const listing = vi
      .spyOn(api, "listModels")
      .mockImplementation((agent) => (agent === "codex" ? codex.promise : claude.promise));
    const save = vi.spyOn(api, "saveWorkspace");
    render({ repo: API });
    await screen.findByText("Finding your agents…");
    await waitFor(() => expect(listing).toHaveBeenCalledTimes(2));
    startChord(screen.getByTestId("new-workspace"));
    expect(save).not.toHaveBeenCalled();
    await act(async () =>
      codex.resolve({
        models: [
          {
            id: "codex-personal",
            displayName: "Synthetic Codex",
            supportsEffort: false,
            isDefault: true,
          },
        ],
      }),
    );
    expect(screen.queryByRole("form", { name: "New workspace" })).toBeNull();
    await act(async () => claude.reject(new Error("Synthetic Claude signed out")));
    await screen.findByRole("form", { name: "New workspace" });
    startChord(form());
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0]![0].charter?.orchestratorModel).toEqual({
      agent: "codex",
      model: "codex-personal",
      speed: "standard",
    });
  });

  it("registers a typed GitHub repo before Start, then starts with it", async () => {
    const { api, render } = await mount(settingsWith({ welcomeSeen: true }));
    render();
    await screen.findByRole("form", { name: "New workspace" });
    const { promise, resolve } = Promise.withResolvers<void>();
    const cloneProject = api.cloneProject.bind(api);
    const clone = vi.spyOn(api, "cloneProject").mockImplementation(async (value, options) => {
      await promise;
      return cloneProject(value, options);
    });
    const save = vi.spyOn(api, "saveWorkspace");
    fireEvent.change(screen.getByRole("combobox", { name: "Folder, GitHub repo or URL" }), {
      target: { value: "EXAMPLE/start-fixture" },
    });
    fireEvent.click(screen.getByTestId("new-workspace-start"));
    expect(clone).toHaveBeenCalledTimes(1);
    // A second Start while it clones adds nothing and saves nothing.
    fireEvent.click(screen.getByTestId("new-workspace-start"));
    expect(clone).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
    resolve();
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0]![0].name).toBe("start-fixture");
  });

  it("keeps a failed registration and its input, and saves nothing", async () => {
    const { api, render } = await mount(settingsWith({ welcomeSeen: true }));
    render();
    await screen.findByRole("form", { name: "New workspace" });
    const { promise, reject } = Promise.withResolvers<never>();
    vi.spyOn(api, "cloneProject").mockImplementationOnce(() => promise);
    const save = vi.spyOn(api, "saveWorkspace");
    const field = screen.getByRole<HTMLInputElement>("combobox", {
      name: "Folder, GitHub repo or URL",
    });
    fireEvent.change(field, { target: { value: "EXAMPLE/retry-fixture" } });
    fireEvent.click(screen.getByTestId("new-workspace-start"));
    reject(new Error("Sign into GitHub with gh auth login, then retry."));
    await screen.findByText("Sign into GitHub with gh auth login, then retry.");
    expect(field.value).toBe("EXAMPLE/retry-fixture");
    expect(save).not.toHaveBeenCalled();
  });

  it("leaves with Esc, but Esc in a field with text only leaves the field", async () => {
    const { render } = await mount(settingsWith({ welcomeSeen: true }));
    render({ repo: API });
    await screen.findByRole("form", { name: "New workspace" });
    const task = screen.getByLabelText("What should it work on?");
    fireEvent.change(task, { target: { value: "Keep this" } });
    fireEvent.keyDown(task, { key: "Escape" });
    expect(back).not.toHaveBeenCalled();
    expect((task as HTMLTextAreaElement).value).toBe("Keep this");
    fireEvent.change(task, { target: { value: "" } });
    fireEvent.keyDown(task, { key: "Escape" });
    expect(back).toHaveBeenCalledOnce();
  });

  it("starts from another workspace's setup, everything but its repos", async () => {
    const { api, render } = await mount(settingsWith({ welcomeSeen: true }));
    const source = await api.saveWorkspace({
      name: "shop",
      projectIds: [API],
      homeProjectId: API,
      charter: {
        maxConcurrentWorkers: 2,
        autonomy: "publish",
        workerMode: "acceptEdits",
        workerModels: [{ agent: "claude", model: "haiku", useFor: "docs" }],
      },
    });
    const save = vi.spyOn(api, "saveWorkspace");
    render({ from: source.workspace.id, repo: DOCS });
    await screen.findByRole("form", { name: "New workspace" });
    expect(screen.getByTestId("new-workspace-from").textContent).toBe("Setup from shop");
    expect(screen.getByTestId("autonomy").getAttribute("data-value")).toBe("publish");
    fireEvent.click(screen.getByTestId("new-workspace-start"));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save).toHaveBeenCalledWith({
      name: "docs",
      projectIds: [DOCS],
      homeProjectId: DOCS,
      charter: source.charter,
    });
  });

  it("waits for the list it copies from, and retries opening the workspace it made, never another", async () => {
    const { api, render } = await mount(settingsWith({ welcomeSeen: true }));
    const source = await api.saveWorkspace({
      name: "shop",
      projectIds: [API],
      homeProjectId: API,
      charter: { maxConcurrentWorkers: 2, autonomy: "publish" },
    });
    const list = vi.spyOn(api, "listWorkspaces").mockRejectedValueOnce(new Error("offline"));
    render({ from: source.workspace.id, repo: DOCS });

    // Nothing to start from yet, so nothing is offered: a default charter would slip in unseen.
    const failed = await screen.findByTestId("sheet-load-error");
    expect(failed.textContent).toContain("offline");
    expect(screen.queryByRole("form", { name: "New workspace" })).toBeNull();
    fireEvent.click(within(failed).getByRole("button", { name: "Try again" }));
    await screen.findByRole("form", { name: "New workspace" });
    expect(list).toHaveBeenCalledTimes(2);

    const save = vi.spyOn(api, "saveWorkspace");
    const open = vi.spyOn(api, "openOrchestrator").mockRejectedValueOnce(new Error("no session"));
    fireEvent.click(screen.getByTestId("new-workspace-start"));
    await screen.findByText("no session");
    // Made, but not opened: Start now opens that workspace only.
    expect(screen.getByTestId("new-workspace-start").textContent).toContain("Open orchestrator");
    fireEvent.click(screen.getByTestId("new-workspace-start"));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(save).toHaveBeenCalledTimes(1);
    const [first, second] = open.mock.calls;
    expect(second).toEqual(first);
    expect(first).toEqual([{ workspaceId: (await save.mock.results[0]!.value).workspace.id }]);
  });
});
