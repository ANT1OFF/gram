// @vitest-environment happy-dom
import { DEFAULT_SETTINGS } from "@gram/contracts";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMockApi } from "@/api/mock";
import { renderWithApi } from "@/panels/test-utils";
import { useServerSettings } from "@/settings-sync/store";

import { NewThreadDraft } from "./new-thread-draft";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

afterEach(() => {
  cleanup();
  useServerSettings.setState({ settings: undefined });
});

/** The draft over the mock, with `folder` typed as the project path. */
const setup = (folder: string) => {
  useServerSettings.setState({ settings: DEFAULT_SETTINGS });
  const api = createMockApi({ speed: 0, autoplay: false });
  const fsFiles = vi.spyOn(api, "fsFiles");
  renderWithApi(<NewThreadDraft />, api);
  const path = screen.getByRole("combobox", { name: "Project path" });
  // React drops a change to the value the input already holds, so `folder` of "" would leave the
  // field untyped and fall back to the most recent project once its query landed.
  fireEvent.change(path, { target: { value: " " } });
  fireEvent.change(path, { target: { value: folder } });
  const prompt = screen.getByRole("combobox", { name: "First prompt" }) as HTMLTextAreaElement;
  return { fsFiles, prompt, user: userEvent.setup() };
};

const folderChecked = () => screen.findByRole("button", { name: /Resume a past session/ });
const files = () => screen.queryByRole("listbox", { name: "Files" });
const offered = () =>
  within(screen.getByRole("listbox", { name: "Files" }))
    .getAllByRole("option")
    .map((option) => option.getAttribute("aria-label"));
const listedPaths = (fsFiles: ReturnType<typeof setup>["fsFiles"]) =>
  fsFiles.mock.calls.map(([target]) => ("path" in target ? target.path : undefined));

describe("New thread draft @ mentions", () => {
  it("waits for saved preferences before initializing a cold draft", async () => {
    const api = createMockApi({ speed: 0, autoplay: false });
    renderWithApi(<NewThreadDraft />, api);
    expect(screen.getByRole("status").textContent).toContain("Loading agent preferences");
    expect(screen.queryByRole("form", { name: "New thread" })).toBeNull();
    act(() => {
      useServerSettings.setState({
        settings: {
          ...DEFAULT_SETTINGS,
          agents: {
            ...DEFAULT_SETTINGS.agents,
            defaultModel: { agent: "codex", model: "gpt-5.5", variant: "high", speed: "fast" },
          },
        },
      });
    });
    expect(await screen.findByRole("form", { name: "New thread" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Agent" }).textContent).toContain("Codex");
    expect(screen.getByRole("combobox", { name: "Speed" }).textContent).toContain("Fast");
  });

  it("offers the project folder's files and inserts the chosen one", async () => {
    const { fsFiles, prompt, user } = setup("/Users/dev/code/web");
    await folderChecked();
    await user.click(prompt);
    await user.type(prompt, "start with @sr");
    await waitFor(() => expect(offered()[0]).toBe("src/"));
    expect(listedPaths(fsFiles).at(-1)).toMatch(/^\/Users\/dev\/code\/web\/?$/);

    await user.keyboard("{Tab}");
    await user.type(prompt, "ret");
    await waitFor(() => expect(offered()[0]).toBe("src/retry.ts"));
    await user.keyboard("{Enter}");
    expect(prompt.value).toBe("start with @src/retry.ts ");
    expect(files()).toBeNull();
  });

  it("lists a chosen existing worktree rather than the project folder", async () => {
    const { fsFiles, prompt, user } = setup("/Users/dev/code/api");
    await folderChecked();
    await user.click(screen.getByRole("radio", { name: "Existing worktree" }));
    const worktrees = await screen.findByRole("radiogroup", { name: "Existing worktrees" });
    const pick = within(worktrees)
      .getAllByRole("radio")
      .find((radio) => !(radio as HTMLButtonElement).disabled)!;
    await user.click(pick);

    await user.click(prompt);
    await user.type(prompt, "@");
    await waitFor(() => expect(files()).not.toBeNull());
    expect(listedPaths(fsFiles).at(-1)).toMatch(/^\/Users\/dev\/code\/api\/\.worktrees\/[^/]+$/);
  });

  it("offers nothing while no folder is chosen", async () => {
    const { fsFiles, prompt, user } = setup("");
    await user.click(prompt);
    await user.type(prompt, "@src");
    // Past the folder check's debounce and the projects query, which is when an untyped field used
    // to fall back to a recent project and open the list.
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(screen.getByRole<HTMLInputElement>("combobox", { name: "Project path" }).value).toBe("");
    expect(files()).toBeNull();
    expect(fsFiles).not.toHaveBeenCalled();
    expect(prompt.value).toBe("@src");
  });
});
