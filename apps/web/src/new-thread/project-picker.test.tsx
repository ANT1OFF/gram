// @vitest-environment happy-dom
import { DEFAULT_SETTINGS, linkedCheckoutMessage, notARepositoryMessage } from "@gram/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiProvider } from "@/api/context";
import { prefillDraftProject, useDraftProjectRoot } from "@/composer/draft-prefill";
import { createMockApi, type MockApi } from "@/api/mock";
import { PROJECTS } from "@/api/mock-scripts";
import { Expand } from "@/motion";
import { useServerSettings } from "@/settings-sync/store";
import { DialogShell } from "@/thread/dialog-shell";

import { AddRepository, typedFolder } from "./add-repository";
import { ProjectPicker } from "./project-picker";
import { resetProjectPicker } from "./store";
import { useFolderStatus } from "./use-folder";

function Harness({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  const status = useFolderStatus(value, 0);
  return (
    <ProjectPicker
      value={value}
      onChange={setValue}
      status={status}
      projects={PROJECTS}
      debounceMs={0}
    />
  );
}

let api: MockApi;

function renderPicker(initial = "") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  api = createMockApi({ speed: 0, autoplay: false });
  render(
    <QueryClientProvider client={client}>
      <ApiProvider api={api}>
        <Harness initial={initial} />
      </ApiProvider>
    </QueryClientProvider>,
  );
  return screen.getByRole<HTMLInputElement>("combobox", { name: "Project path" });
}

const type = (input: HTMLInputElement, value: string) => {
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
};

const optionNames = async () => {
  const list = await screen.findByRole("listbox", { name: "Folder suggestions" });
  return within(list)
    .getAllByRole("option")
    .map((option) => option.textContent);
};

const breadcrumbCurrent = () =>
  within(screen.getByRole("navigation", { name: "Breadcrumb" }))
    .getAllByRole("button")
    .find((b) => b.getAttribute("aria-current") === "location")?.textContent;

afterEach(() => {
  cleanup();
  resetProjectPicker();
  useServerSettings.setState({ settings: undefined });
});

describe("default folder", () => {
  it("offers the default folder as a chip that browses there", async () => {
    useServerSettings.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        agents: { ...DEFAULT_SETTINGS.agents, defaultFolder: "~/code" },
      },
    });
    const input = renderPicker();
    fireEvent.click(screen.getByRole("button", { name: "Default folder" }));
    expect(input.value).toBe("~/code/");
    await waitFor(() => expect(breadcrumbCurrent()).toBe("code"));
  });

  it("saves the chosen folder as the default", async () => {
    useServerSettings.setState({ settings: DEFAULT_SETTINGS });
    const input = renderPicker();
    type(input, "~/Documents/code/gram");
    fireEvent.click(await screen.findByRole("button", { name: "Set as default folder" }));
    await waitFor(() =>
      expect(screen.getByTestId("folder-status").textContent).toContain("Default folder"),
    );
    expect((await api.getSettings()).agents.defaultFolder).toBe("~/Documents/code/gram");
    expect(screen.queryByRole("button", { name: "Set as default folder" })).toBeNull();
  });
});

describe("PathField autocomplete", () => {
  it("suggests matching folders as you type", async () => {
    const input = renderPicker();
    type(input, "~/Documents/code/gra");
    await waitFor(async () =>
      expect((await optionNames()).toSorted()).toEqual(["gramgit", "graph-tools"]),
    );
    expect(input.getAttribute("aria-expanded")).toBe("true");
  });

  it("completes the common prefix with Tab, then enters a unique match", async () => {
    const input = renderPicker();
    type(input, "~/Documents/code/gra");
    await waitFor(async () => expect(await optionNames()).toHaveLength(2));
    fireEvent.keyDown(input, { key: "Tab" });
    expect(input.value).toBe("~/Documents/code/gra");

    type(input, "~/Documents/code/cl");
    await waitFor(async () => expect(await optionNames()).toHaveLength(1));
    fireEvent.keyDown(input, { key: "Tab" });
    expect(input.value).toBe("~/Documents/code/client-app/");
  });

  it("picks a suggestion with the arrow keys and Enter", async () => {
    const input = renderPicker();
    type(input, "~/Documents/code/gram");
    await waitFor(async () => expect(await optionNames()).toEqual(["gramgit"]));
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getByRole("option", { selected: true }).textContent).toBe("gramgit");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("~/Documents/code/gram/");
  });
});

describe("validation", () => {
  it.each([
    ["~/Documents/nope", "Folder not found: /Users/dev/Documents/nope"],
    ["~/Documents/code/README.md", "Not a folder: /Users/dev/Documents/code/README.md"],
  ])("explains why %s can't be used", async (path, message) => {
    const input = renderPicker();
    type(input, path);
    expect((await screen.findByTestId("folder-problem")).textContent).toContain(message);
  });

  it("offers recovery for a folder the system won't let it read, and retries the check", async () => {
    const input = renderPicker();
    type(input, "~/Documents/Private");
    const card = await screen.findByTestId("folder-access-recovery");
    expect(card.textContent).toContain("/Users/dev/Documents/Private");
    expect(card.textContent).toContain("Files & Folders");
    expect(screen.queryByTestId("folder-problem")).toBeNull();

    const browse = vi.spyOn(api, "browse");
    fireEvent.click(within(card).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(browse).toHaveBeenCalledWith("~/Documents/Private/"));
    expect(await screen.findByTestId("folder-access-recovery")).toBeTruthy();
  });

  it("marks a valid folder that is a git repo", async () => {
    const input = renderPicker();
    type(input, "~/Documents/code/gram");
    await waitFor(() => {
      const status = screen.getByTestId("folder-status").textContent ?? "";
      expect(status).toContain("~/Documents/code/gram");
      expect(status).toContain("git");
    });
  });
});

describe("FolderBrowser", () => {
  it("navigates with double-click, keyboard and parent, then chooses a folder", async () => {
    const input = renderPicker();
    fireEvent.click(screen.getByRole("button", { name: "Browse" }));

    const repo = await screen.findByRole("option", { name: /gram/ });
    expect(repo.textContent).toContain("git");
    fireEvent.doubleClick(repo);
    await waitFor(() => expect(breadcrumbCurrent()).toBe("gram"));

    fireEvent.click(screen.getByRole("button", { name: "Parent folder" }));
    await waitFor(() => expect(breadcrumbCurrent()).toBe("code"));

    const list = await screen.findByRole("listbox", { name: "Folders" });
    fireEvent.keyDown(list, { key: "Home" });
    fireEvent.keyDown(list, { key: "Enter" });
    await waitFor(() => expect(breadcrumbCurrent()).toBe("client-app"));
    fireEvent.keyDown(await screen.findByRole("listbox", { name: "Folders" }), {
      key: "Backspace",
    });
    await waitFor(() => expect(breadcrumbCurrent()).toBe("code"));

    fireEvent.click(screen.getByRole("button", { name: "Choose this folder" }));
    expect(input.value).toBe("~/Documents/code");
    await waitFor(() =>
      expect(screen.getByTestId("folder-status").textContent).toContain("Not a git repository"),
    );
  });

  it("lists recent and bookmarked projects, a bookmark once", () => {
    renderPicker();
    expect(
      within(screen.getByRole("region", { name: "Recent" })).getAllByRole("listitem"),
    ).toHaveLength(2);
    expect(
      within(screen.getByRole("region", { name: "Bookmarks" })).getByRole("listitem").textContent,
    ).toContain("api");
  });
});

const renderAdd = (adjust: (mock: typeof api) => void = () => {}) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  api = createMockApi({ speed: 0, autoplay: false });
  adjust(api);
  const onAdded = vi.fn();
  useServerSettings.setState({ settings: DEFAULT_SETTINGS });
  render(
    <QueryClientProvider client={client}>
      <ApiProvider api={api}>
        <AddRepository onAdded={onAdded} />
      </ApiProvider>
    </QueryClientProvider>,
  );
  const input = screen.getByRole<HTMLInputElement>("combobox", {
    name: "Folder, GitHub repo or URL",
  });
  return { input, onAdded };
};

describe("adding a repository", () => {
  it("suggests GitHub repositories, clones the one picked, and says where", async () => {
    const { input, onAdded } = renderAdd();
    type(input, "example-device");
    const list = await screen.findByRole("listbox", { name: "Repository suggestions" });
    expect(
      within(list)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["EXAMPLE/example-device-apps"]);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("EXAMPLE/example-device-apps");
    expect(screen.getByText(/^Clones into ~\/Documents\/code\/example-device-apps/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Clone" }));
    expect(screen.getByRole("status").textContent).toBe(
      "Cloning EXAMPLE/example-device-apps into ~/Documents/code/example-device-apps…",
    );
    await waitFor(() =>
      expect(onAdded).toHaveBeenCalledWith(
        expect.objectContaining({
          root: "/Users/dev/Documents/code/example-device-apps",
          name: "example-device-apps",
        }),
      ),
    );
    expect(input.value).toBe("");

    // A second clone of it finds the first.
    type(input, "https://github.com/EXAMPLE/example-device-apps.git");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(2));
    expect(onAdded.mock.calls[1]![0]).toEqual(onAdded.mock.calls[0]![0]);
  });

  it("asks for suggestions before the field is focused, and says while they load", async () => {
    const answer = Promise.withResolvers<{ repos: string[] }>();
    const cloneSuggestions = vi.fn(() => answer.promise);
    const { input } = renderAdd((mock) => Object.assign(mock, { cloneSuggestions }));
    expect(cloneSuggestions).toHaveBeenCalledTimes(1);
    type(input, "example");
    expect(screen.getByRole("status").textContent).toBe("Loading your GitHub repositories…");
    answer.resolve({ repos: ["EXAMPLE/example-device-apps"] });
    const list = await screen.findByRole("listbox", { name: "Repository suggestions" });
    expect(within(list).getByRole("option").textContent).toBe("EXAMPLE/example-device-apps");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows why a remote is refused or a clone failed, and adds nothing", async () => {
    const { input, onAdded } = renderAdd();
    type(input, "EXAMPLE/..");
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByRole("alert").textContent).toBe(
      "EXAMPLE/.. isn't a GitHub repository or a git URL.",
    );

    type(input, "EXAMPLE/missing");
    fireEvent.click(screen.getByRole("button", { name: "Clone" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Couldn't clone EXAMPLE/missing: GraphQL: Could not resolve to a Repository with the name 'EXAMPLE/missing'.",
    );

    type(input, "EXAMPLE/sandbox");
    fireEvent.keyDown(input, { key: "Enter" });
    expect((await screen.findByRole("alert")).textContent).toContain(
      "/Users/dev/Documents/code/sandbox already exists and isn't a clone of EXAMPLE/sandbox.",
    );
    expect(onAdded).not.toHaveBeenCalled();
  });

  it("takes no folder from the system dialog while a clone runs", async () => {
    const dialog = Promise.withResolvers<string>();
    const chooseFolder = vi.fn(() => dialog.promise);
    Object.defineProperty(window, "gram", {
      value: { platform: "darwin", chooseFolder },
      configurable: true,
    });
    try {
      const { input, onAdded } = renderAdd();
      const choose = screen.getByRole("button", { name: "Add folder…" });
      fireEvent.click(choose);
      type(input, "EXAMPLE/example-infra");
      fireEvent.click(screen.getByRole("button", { name: "Clone" }));
      expect(choose.hasAttribute("disabled")).toBe(true);
      // A dialog opened before the clone began answers during it, and is ignored.
      dialog.resolve("/Users/dev/code/web");
      await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
      expect(onAdded.mock.calls[0]![0]).toMatchObject({ name: "example-infra" });
    } finally {
      Reflect.deleteProperty(window, "gram");
    }
  });

  it("stops a clone when it is closed, and does nothing it would have done", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    api = createMockApi({ speed: 0, autoplay: false });
    const onAdded = vi.fn();
    const view = render(
      <QueryClientProvider client={client}>
        <ApiProvider api={api}>
          <AddRepository onAdded={onAdded} />
        </ApiProvider>
      </QueryClientProvider>,
    );
    const input = screen.getByRole<HTMLInputElement>("combobox", {
      name: "Folder, GitHub repo or URL",
    });
    type(input, "EXAMPLE/closed-early");
    fireEvent.click(screen.getByRole("button", { name: "Clone" }));
    view.unmount();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onAdded).not.toHaveBeenCalled();
    expect((await api.listProjects()).map((p) => p.name)).not.toContain("closed-early");
  });

  it("keeps an open draft on whichever came last, a prefill or what was typed", () => {
    const { result } = renderHook(() => useDraftProjectRoot());
    act(() => prefillDraftProject("/Users/dev/code/api"));
    expect(result.current[0]).toBe("/Users/dev/code/api");
    act(() => result.current[1]("EXAMPLE/web"));
    expect(result.current[0]).toBe("EXAMPLE/web");
    // A prefill before the draft first rendered is its start; one after replaces what was typed.
    const late = renderHook(() => useDraftProjectRoot());
    expect(late.result.current[0]).toBe("/Users/dev/code/api");
    act(() => prefillDraftProject("/Users/dev/code/web"));
    expect(result.current[0]).toBe("/Users/dev/code/web");
    expect(late.result.current[0]).toBe("/Users/dev/code/web");
    act(() => prefillDraftProject(undefined));
    expect(result.current[0]).toBe("/Users/dev/code/web");
  });

  it("ports the suggestion list out of a clipping expand, above the path hint", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    api = createMockApi({ speed: 0, autoplay: false });
    useServerSettings.setState({ settings: DEFAULT_SETTINGS });
    render(
      <QueryClientProvider client={client}>
        <ApiProvider api={api}>
          <Expand open>
            <AddRepository onAdded={() => {}} />
          </Expand>
        </ApiProvider>
      </QueryClientProvider>,
    );
    const input = screen.getByRole<HTMLInputElement>("combobox", {
      name: "Folder, GitHub repo or URL",
    });
    type(input, "~/code/w");
    const list = await screen.findByRole("listbox", { name: "Folder suggestions" });
    const root = screen.getByTestId("add-repository");
    // Out of `.gram-expand` (overflow: clip) and out of the field, so the hint can keep its gap.
    expect(list.closest(".gram-expand")).toBeNull();
    expect(list.closest("[data-base-ui-portal]")).not.toBeNull();
    expect(root.contains(list)).toBe(false);
    expect(root.className).toContain("gap-1.5");
    expect(list.className).toContain("bg-popover");
    expect(list.closest("[role='dialog']")).toBeNull();
    expect(input.getAttribute("aria-controls")).toBe(list.id);
    expect(input.getAttribute("aria-expanded")).toBe("true");
    fireEvent.mouseDown(within(list).getByRole("option", { name: "web" }));
    expect(input.value).toBe("~/code/web/");
  });

  it("keeps portaled suggestions usable inside a dialog, and Escape closes only the list", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    api = createMockApi({ speed: 0, autoplay: false });
    useServerSettings.setState({ settings: DEFAULT_SETTINGS });
    const onClose = vi.fn();
    render(
      <QueryClientProvider client={client}>
        <ApiProvider api={api}>
          <DialogShell testId="add-repo-dialog" title="Add repository" onClose={onClose}>
            <AddRepository onAdded={() => {}} />
          </DialogShell>
        </ApiProvider>
      </QueryClientProvider>,
    );
    const input = screen.getByRole<HTMLInputElement>("combobox", {
      name: "Folder, GitHub repo or URL",
    });
    type(input, "example-device");
    const list = await screen.findByRole("listbox", { name: "Repository suggestions" });
    expect(screen.getByTestId("add-repo-dialog").contains(list)).toBe(false);
    fireEvent.mouseDown(within(list).getByRole("option", { name: "EXAMPLE/example-device-apps" }));
    expect(input.value).toBe("EXAMPLE/example-device-apps");
    expect(document.activeElement).toBe(input);

    type(input, "example-device");
    await screen.findByRole("listbox", { name: "Repository suggestions" });
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("listbox", { name: "Repository suggestions" })).toBeNull(),
    );
    expect(screen.getByTestId("add-repo-dialog")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("adds a folder typed with completion", async () => {
    const { input, onAdded } = renderAdd();
    type(input, "~/code/w");
    const list = await screen.findByRole("listbox", { name: "Folder suggestions" });
    fireEvent.mouseDown(within(list).getByRole("option", { name: "web" }));
    expect(input.value).toBe("~/code/web/");
    // Add waits for the check to say it is a repository.
    const add = screen.getByRole("button", { name: "Add" });
    expect(add.hasAttribute("disabled")).toBe(true);
    await waitFor(() => expect(add.hasAttribute("disabled")).toBe(false));
    fireEvent.click(add);
    await waitFor(() =>
      expect(onAdded).toHaveBeenCalledWith(
        expect.objectContaining({ root: "/Users/dev/code/web" }),
      ),
    );
  });

  it("refuses a linked worktree or submodule as adding it would, and leaves an unreadable one to it", () => {
    const folder = { path: "/Users/dev/code/web-b", entries: [], truncated: false };
    expect(typedFolder({ state: "valid", folder: { ...folder, git: "linked" } })).toEqual({
      kind: "refused",
      message: linkedCheckoutMessage(folder.path),
    });
    expect(typedFolder({ state: "valid", folder: { ...folder, git: "repository" } })).toEqual({
      kind: "repo",
      path: folder.path,
    });
    expect(typedFolder({ state: "valid", folder: { ...folder, git: "unreadable" } })).toEqual({
      kind: "unchecked",
    });
    expect(typedFolder({ state: "checking" })).toBeUndefined();
  });

  it("checks a typed folder, and adds only a repository", async () => {
    const { input, onAdded } = renderAdd();
    type(input, "~/Documents/code/sandbox");
    await waitFor(() =>
      expect(screen.getByTestId("folder-check").textContent).toBe(
        notARepositoryMessage("/Users/dev/Documents/code/sandbox"),
      ),
    );
    expect(screen.getByRole("button", { name: "Add" }).hasAttribute("disabled")).toBe(true);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("alert").textContent).toContain("isn't the top folder");

    type(input, "~/Documents/code/nowhere");
    await waitFor(() =>
      expect(screen.getByTestId("folder-check").textContent).toContain("Folder not found"),
    );
    expect(screen.getByRole("button", { name: "Add" }).hasAttribute("disabled")).toBe(true);

    type(input, "~/Documents/code/infra");
    await waitFor(() =>
      expect(screen.getByTestId("folder-check").textContent).toBe("~/Documents/code/infragit"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(onAdded).toHaveBeenCalledWith(
        expect.objectContaining({ root: "/Users/dev/Documents/code/infra" }),
      ),
    );
  });

  it("offers to clone a GitHub name typed into the project picker, then picks the clone", async () => {
    useServerSettings.setState({ settings: DEFAULT_SETTINGS });
    const input = renderPicker();
    type(input, "EXAMPLE/agent-factory");
    const offer = await screen.findByTestId("clone-offer");
    expect(offer.textContent).toContain("Clones into ~/Documents/code/agent-factory");
    fireEvent.click(within(offer).getByRole("button", { name: "Clone EXAMPLE/agent-factory" }));
    await waitFor(() => expect(input.value).toBe("/Users/dev/Documents/code/agent-factory"));
    expect(await screen.findByTestId("folder-status")).toBeTruthy();
  });
});
