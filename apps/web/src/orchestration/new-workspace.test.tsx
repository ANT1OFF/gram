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
import { EMPTY_SHELL, useEmbedShell } from "@/embed/store";
import { dispatchShortcut } from "@/keyboard/registry";
import { renderWithApi } from "@/panels/test-utils";
import { autonomyLevel } from "@/settings/workspace-settings-model";
import { useServerSettings } from "@/settings-sync/store";

import { DISCOVER_MESSAGE } from "./board-model";
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
    render: (props: { from?: WorkspaceId; repo?: ProjectId; read?: boolean } = {}) =>
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
  useEmbedShell.setState(EMPTY_SHELL);
  vi.unstubAllGlobals();
});

describe("NewWorkspaceSheet", { timeout: 20_000 }, () => {
  it("is one sheet: name, repos, what to work on and autonomy, nothing else", async () => {
    const { render } = await mount(settingsWith({ welcomeSeen: true }));
    render({ repo: API });
    await screen.findByRole("form", { name: "New workspace" });
    expect(chips()).toEqual(["api"]);
    expect(screen.getByLabelText("What should it work on?")).toBe(document.activeElement);
    expect(within(form()).getByTestId("autonomy")).toBeTruthy();
    // The name is optional: blank, it shows the home repository's, which the workspace gets.
    expect(screen.getByLabelText("Name")).toHaveProperty("placeholder", "api");
    // No stages: they wait for the workspace's settings.
    expect(screen.queryByRole("navigation", { name: "Steps" })).toBeNull();
    expect(screen.queryByTestId("workspace-guide")).toBeNull();
  });

  it("saves a typed name as typed, and refuses one another workspace has before saving", async () => {
    const { api, render } = await mount(settingsWith({ welcomeSeen: true }));
    const save = vi.spyOn(api, "saveWorkspace");
    render({ repo: API });
    await screen.findByRole("form", { name: "New workspace" });
    const name = screen.getByLabelText("Name");
    fireEvent.change(name, { target: { value: "  Payments " } });
    startChord(form());
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(save.mock.calls[0]![0]).toMatchObject({ name: "Payments", projectIds: [API] });

    cleanup();
    navigate.mockClear();
    render({ repo: API });
    await screen.findByRole("form", { name: "New workspace" });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "payments" } });
    startChord(form());
    expect(await screen.findByText("payments is taken. Pick another name.")).toBeTruthy();
    expect(save).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("is named by the embedding app's word for a workspace", async () => {
    useEmbedShell.setState({
      ...EMPTY_SHELL,
      threadsPage: { workspaces: { noun: "Project", plural: "Projects" } },
    });
    const { render } = await mount(settingsWith({ welcomeSeen: true }));
    render({ repo: API });
    await screen.findByRole("form", { name: "New project" });
    expect(screen.getByRole("heading", { name: "New project" })).toBeTruthy();
  });

  it("makes what it should work on the orchestrator's first message", async () => {
    const { api, render } = await mount(settingsWith({}));
    const save = vi.spyOn(api, "saveWorkspace");
    const task = vi.spyOn(api, "startTask");
    const open = vi.spyOn(api, "openOrchestrator");
    const send = vi.spyOn(api, "send");
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
    // A task alone never starts the survey: that is the person's choice, left unticked here.
    expect(send.mock.calls.filter(([, input]) => input.text === DISCOVER_MESSAGE)).toHaveLength(0);
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
    const send = vi.spyOn(api, "send");
    render({ repo: DOCS });
    await screen.findByRole("form", { name: "New workspace" });
    fireEvent.click(screen.getByTestId("new-workspace-start"));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(save.mock.calls[0]![0].name).toBe("docs 2");
    expect(task).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledOnce();
    // With no first message, nothing runs: no survey until the person asks for one.
    expect(send).not.toHaveBeenCalled();
    expect(api.updateSettings).not.toHaveBeenCalled();
  });

  it("surveys a blank workspace only when the person ticks it, and says so in the steps", async () => {
    const { api, render } = await mount(settingsWith({ welcomeSeen: true }));
    const open = vi.spyOn(api, "openOrchestrator");
    const send = vi.spyOn(api, "send");
    render({ repo: API });
    await screen.findByRole("form", { name: "New workspace" });
    const steps = screen.getByTestId("new-workspace-steps");
    expect(steps.textContent).toContain("Nothing else runs until you send one");
    expect(steps.textContent).not.toContain("reads the repositories");
    fireEvent.click(screen.getByLabelText(/Read the repositories first/));
    expect(steps.textContent).toContain("reads the repositories");
    fireEvent.click(screen.getByTestId("new-workspace-start"));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    const thread = await open.mock.results[0]!.value;
    expect(send).toHaveBeenCalledExactlyOnceWith(thread.id, { text: DISCOVER_MESSAGE });
  });

  it("opened from the first-run card, starts ticked to read the repositories, as the card promises", async () => {
    const { api, render } = await mount(settingsWith({ welcomeSeen: true }));
    const open = vi.spyOn(api, "openOrchestrator");
    const send = vi.spyOn(api, "send");
    render({ repo: API, read: true });
    await screen.findByRole("form", { name: "New workspace" });
    expect(screen.getByTestId("new-workspace-steps").textContent).toContain(
      "reads the repositories",
    );
    fireEvent.click(screen.getByTestId("new-workspace-start"));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    const thread = await open.mock.results[0]!.value;
    expect(send).toHaveBeenCalledExactlyOnceWith(thread.id, { text: DISCOVER_MESSAGE });
  });

  it("saves without starting: no orchestrator, no message, back to the list", async () => {
    const { api, render } = await mount(settingsWith({ welcomeSeen: true }));
    const save = vi.spyOn(api, "saveWorkspace");
    const open = vi.spyOn(api, "openOrchestrator");
    const task = vi.spyOn(api, "startTask");
    const send = vi.spyOn(api, "send");
    render({ repo: API });
    await screen.findByRole("form", { name: "New workspace" });
    fireEvent.change(screen.getByLabelText("What should it work on?"), {
      target: { value: "Add mail triggers" },
    });
    fireEvent.click(screen.getByTestId("new-workspace-save"));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/threads" }));
    expect(save).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
    expect(task).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("promises no agent merge where the deployment keeps merging to people", async () => {
    useEmbedShell.setState({ ...EMPTY_SHELL, machines: { merges: "person" } });
    const { render } = await mount(settingsWith({ welcomeSeen: true }));
    render({ repo: API });
    await screen.findByRole("form", { name: "New workspace" });
    const autonomy = screen.getByTestId("autonomy");
    expect(autonomy.textContent).not.toMatch(/merges pull requests|auto-merge/);
    expect(within(autonomy).getByRole("radio", { name: /Full/ }).textContent).toContain(
      "You merge.",
    );
  });

  it("asks the embedding app what agents can do in the picked GitHub repositories", async () => {
    const access = vi.fn(async ({ repositories }: { repositories: readonly string[] }) => ({
      repositories: repositories.map((fullName) => ({
        fullName,
        push: { allowed: false, text: "No: the app can only read", detail: "It reads only." },
        pullRequest: { allowed: false, text: "—" },
        merge: { allowed: false, text: "You, on GitHub" },
        checks: ["build"],
        fix: { label: `Give the app write on ${fullName}`, href: "https://example.invalid/i/1" },
      })),
      note: "Never main.",
    }));
    useEmbedShell.setState({
      ...EMPTY_SHELL,
      repositories: { list: async () => ({ repositories: [] }), access },
    });
    const { api, render } = await mount(settingsWith({ welcomeSeen: true }));
    const origins = vi.spyOn(api, "projectOrigins");
    render({ repo: API });
    const rows = await screen.findAllByTestId("new-workspace-access-row");
    expect(origins).toHaveBeenCalledWith([API]);
    expect(access.mock.calls[0]?.[0].repositories).toEqual(["EXAMPLE/api"]);
    expect(rows).toHaveLength(1);
    // Unknown checks are never said as none; these were named.
    expect(within(rows[0]!).getByTestId("new-workspace-access-checks").textContent).toContain(
      "build",
    );
    const fix = screen.getByRole("link", { name: "Give the app write on EXAMPLE/api" });
    expect(fix.getAttribute("target")).toBe("_blank");
  });

  it("says why it can't read what agents can do, and reads it again on Retry", async () => {
    const access = vi.fn(async ({ repositories }: { repositories: readonly string[] }) => ({
      repositories: repositories.map((fullName) => ({
        fullName,
        push: { allowed: true, text: "Yes" },
        pullRequest: { allowed: true, text: "Yes" },
        merge: { allowed: false, text: "You, on GitHub" },
      })),
    }));
    useEmbedShell.setState({
      ...EMPTY_SHELL,
      repositories: { list: async () => ({ repositories: [] }), access },
    });
    const { api, render } = await mount(settingsWith({ welcomeSeen: true }));
    const read = api.projectOrigins.bind(api);
    // The origins read fails once: the card must stop reading, not wait on an answer never asked.
    vi.spyOn(api, "projectOrigins")
      .mockRejectedValueOnce(new Error("The server couldn't read the repositories."))
      .mockImplementation(read);
    render({ repo: API });
    const card = await screen.findByTestId("new-workspace-access");
    await within(card).findByText("The server couldn't read the repositories.");
    expect(within(card).queryByText(/Reading what the agents can do/)).toBeNull();
    expect(access).not.toHaveBeenCalled();
    fireEvent.click(within(card).getByRole("button", { name: "Retry" }));
    expect(await screen.findAllByTestId("new-workspace-access-row")).toHaveLength(1);
  });

  it("says nothing of what agents can do where the app gives no source for it", async () => {
    const { api, render } = await mount(settingsWith({ welcomeSeen: true }));
    const origins = vi.spyOn(api, "projectOrigins");
    render({ repo: API });
    await screen.findByRole("form", { name: "New workspace" });
    expect(screen.queryByTestId("new-workspace-access")).toBeNull();
    expect(origins).not.toHaveBeenCalled();
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
          name: radio.getAttribute("aria-label"),
          slab: radio.querySelector('[data-testid="segment-slab"]')?.className ?? "",
          check: radio.querySelector('[data-testid="choice-check"]') !== null,
        }));
    // The one selected style: an accent-tinted fill and edge on the track, and a check, so the
    // pick never shows by colour alone.
    expect(within(autonomy).getByRole("radiogroup").className).toContain("bg-accent");
    const [initial] = marked();
    expect(marked()).toHaveLength(1);
    expect(initial!.name).toBe(
      autonomyLevel(autonomy.getAttribute("data-value") as Autonomy).label,
    );
    expect(initial!.slab).toContain("choice-selected");
    expect(initial!.check).toBe(true);
    expect(within(autonomy).getAllByTestId("segment-slab")).toHaveLength(1);
    expect(within(autonomy).getAllByTestId("choice-check")).toHaveLength(1);

    fireEvent.click(within(autonomy).getByRole("radio", { name: "Publish" }));
    await waitFor(() => expect(marked().map(({ name }) => name)).toEqual(["Publish"]));
    expect(marked()[0]!.slab).toContain("choice-selected");
    expect(marked()[0]!.check).toBe(true);
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
    fireEvent.click(within(failed).getByRole("button", { name: "Retry" }));
    await screen.findByRole("form", { name: "New workspace" });
    expect(list).toHaveBeenCalledTimes(2);

    const save = vi.spyOn(api, "saveWorkspace");
    const open = vi.spyOn(api, "openOrchestrator").mockRejectedValueOnce(new Error("no session"));
    const send = vi.spyOn(api, "send");
    fireEvent.click(screen.getByLabelText(/Read the repositories first/));
    fireEvent.click(screen.getByTestId("new-workspace-start"));
    await screen.findByText("no session");
    // Made, but not opened: Start now opens that workspace only.
    expect(screen.getByTestId("new-workspace-start").textContent).toContain("Open orchestrator");
    fireEvent.click(screen.getByTestId("new-workspace-start"));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(save).toHaveBeenCalledTimes(1);
    const [first, second] = open.mock.calls;
    expect(second).toEqual(first);
    // Discover went once, with the open that worked.
    expect(send).toHaveBeenCalledOnce();
    expect(first).toEqual([{ workspaceId: (await save.mock.results[0]!.value).workspace.id }]);
  });
  it("starts the person's own machine where none is up, and opens the workspace once it is", async () => {
    useEmbedShell.setState({
      ...EMPTY_SHELL,
      hosted: true,
      machines: { noun: "sandbox", repositories: "theirs" },
    });
    let started = false;
    const posts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "POST") {
          posts.push(url);
          started = true;
          return Response.json({ progress: { hostKey: "k", phase: "starting", at: 1 } });
        }
        return Response.json(
          started
            ? { available: true, machine: { id: "m-1", name: "sbx", online: true } }
            : { available: true },
        );
      }),
    );
    const { api, render } = await mount(settingsWith({ welcomeSeen: true }));
    const open = vi.spyOn(api, "openOrchestrator");
    render({ repo: DOCS });
    // Start starts it, so there is no second start: the steps say it comes first.
    await waitFor(() =>
      expect(screen.getByTestId("new-workspace-steps").textContent).toContain(
        "1.Start a sandbox and check out the repositories",
      ),
    );
    expect(screen.queryByText("Start a sandbox to run this")).toBeNull();
    fireEvent.click(screen.getByTestId("new-workspace-start"));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(posts).toEqual([expect.stringContaining("/machines/on-demand/start")]);
    expect(open).toHaveBeenCalledOnce();
  });
});
