// @vitest-environment happy-dom
import { DEFAULT_SETTINGS, type ThreadId, type WorkspaceState } from "@gram/contracts";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMockApi } from "@/api/mock";
import { useHandoffStore } from "@/orchestration/use-board-actions";
import { MENU_CAP } from "@/palette/menu-caps";
import { renderWithApi } from "@/panels/test-utils";
import { useServerSettings } from "@/settings-sync/store";
import { useDraftStore } from "@/stores/drafts";
import { useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";
import { useThreadDialogs } from "@/thread/thread-dialogs-store";
import { useViewStore } from "@/views/view-store";

import { Composer } from "./composer";
import { pendingTaskTarget, dropTaskTarget } from "./draft-prefill";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));

const THREAD = "t-orch" as ThreadId;
const WORKSPACE = "w-billing";

const setup = async ({
  role = "orchestrator",
  paused = false,
}: {
  role?: "orchestrator" | "worker";
  paused?: boolean;
} = {}) => {
  useServerSettings.setState({ settings: DEFAULT_SETTINGS });
  useThreadsStore.setState({
    byId: {
      [THREAD]: {
        status: "idle",
        thread: {
          id: THREAD,
          checkout: { path: "/Users/dev/code/billing" },
          workspaceId: WORKSPACE,
          ...(role === "orchestrator" ? { role } : { spawnedBy: "t-other" }),
        },
      },
    } as never,
  });
  const api = createMockApi({ speed: 0, autoplay: false });
  const state = {
    workspace: { id: WORKSPACE, name: "Billing" },
    ...(paused ? { paused: { reason: "user", at: 9 } } : {}),
  } as unknown as WorkspaceState;
  const listWorkspaces = vi.spyOn(api, "listWorkspaces").mockResolvedValue([state]);
  const setPaused = vi.spyOn(api, "setOrchestratorPaused").mockResolvedValue(undefined as never);
  // The thread lives only in the store, so the mock server would answer ThreadNotFound.
  vi.spyOn(api, "threadSuggestions").mockResolvedValue(null);
  renderWithApi(<Composer threadId={THREAD} focused />, api);
  const composer = screen.getByRole("combobox", { name: "Message" }) as HTMLTextAreaElement;
  if (role === "orchestrator") {
    await waitFor(() => expect(listWorkspaces).toHaveBeenCalled());
  }
  return { composer, setPaused, user: userEvent.setup() };
};

const verbMenu = () => screen.queryByRole("listbox", { name: "Orchestrator commands" });
const verbsShown = () =>
  within(screen.getByRole("listbox", { name: "Orchestrator commands" }))
    .getAllByRole("option")
    .map((option) => option.textContent);
const slashMenu = () => screen.queryByRole("listbox", { name: "Slash commands" });

afterEach(() => {
  cleanup();
  navigate.mockReset();
  dropTaskTarget();
  useThreadsStore.setState({ byId: {} });
  useDraftStore.setState({ text: {} });
  useViewStore.setState({ view: "chat", quiet: false });
  useHandoffStore.setState({ confirming: undefined });
  useThreadDialogs.setState({ dialog: undefined } as never);
});

describe("Composer / verbs on the orchestrator", () => {
  it("opens the eight verbs on /, seven and More…, instead of the agent's commands", async () => {
    const { composer, user } = await setup();
    await user.click(composer);
    await user.type(composer, "/");
    await waitFor(() => expect(verbMenu()).not.toBeNull());
    expect(verbsShown()).toEqual([
      "Task",
      "Pause",
      "Memory",
      "Board",
      "Files",
      "Repo",
      "Fresh",
      "More…",
    ]);
    expect(verbsShown().filter((v) => v !== "More…").length).toBeLessThanOrEqual(MENU_CAP);
    expect(slashMenu()).toBeNull();
    expect(composer.getAttribute("aria-activedescendant")).toBe(`slash-menu-${THREAD}-0`);
  });

  it("runs a verb picked by its name and Enter, and clears the /", async () => {
    const { composer, user } = await setup();
    await user.click(composer);
    await user.type(composer, "/b");
    await waitFor(() => expect(verbsShown()).toEqual(["Board", "More…"]));
    await user.keyboard("{Enter}");
    expect(useViewStore.getState().view).toBe("board");
    expect(composer.value).toBe("");
    expect(verbMenu()).toBeNull();
  });

  it("moves through the grid with the arrows", async () => {
    const { composer, user } = await setup();
    await user.click(composer);
    await user.type(composer, "/");
    await waitFor(() => expect(verbMenu()).not.toBeNull());
    // Down a row from Task is Files; two right of it, Fresh.
    await user.keyboard("{ArrowDown}{ArrowRight}{ArrowRight}");
    expect(composer.getAttribute("aria-activedescendant")).toBe(`slash-menu-${THREAD}-6`);
    await user.keyboard("{Enter}");
    expect(useHandoffStore.getState().confirming).toBe(WORKSPACE);
  });

  it("wires each verb to the action Gram has for it", async () => {
    const { composer, setPaused, user } = await setup();
    const pick = async (typed: string) => {
      await user.type(composer, typed);
      await waitFor(() => expect(verbMenu()).not.toBeNull());
      await user.keyboard("{Enter}");
    };
    await user.click(composer);

    await pick("/task");
    expect(navigate).toHaveBeenLastCalledWith({ to: "/new-task" });
    expect(pendingTaskTarget()).toEqual({ kind: "workspace", workspaceId: WORKSPACE });

    await pick("/pause");
    await waitFor(() => expect(setPaused).toHaveBeenCalledWith(WORKSPACE, true));

    await pick("/memory");
    expect(navigate).toHaveBeenLastCalledWith({
      to: "/w/$workspaceId/memory",
      params: { workspaceId: WORKSPACE },
    });

    await pick("/repo");
    expect(useThreadDialogs.getState().dialog).toEqual({ kind: "addRepo", workspaceId: WORKSPACE });

    await pick("/files");
    expect(navigate).toHaveBeenLastCalledWith({
      to: "/w/$workspaceId/files",
      params: { workspaceId: WORKSPACE },
    });

    const openPalette = vi.spyOn(useLayoutStore.getState(), "openPalette");
    useLayoutStore.setState({ openPalette });
    await pick("/more");
    await waitFor(() =>
      expect(openPalette).toHaveBeenCalledWith("", { kind: "workspace", workspaceId: WORKSPACE }),
    );
  });

  it("offers Resume on a paused workspace", async () => {
    const { composer, setPaused, user } = await setup({ paused: true });
    await user.click(composer);
    await user.type(composer, "/");
    await waitFor(() => expect(verbsShown()[1]).toBe("Resume"));
    await user.click(screen.getByRole("option", { name: "Resume" }));
    await waitFor(() => expect(setPaused).toHaveBeenCalledWith(WORKSPACE, false));
    expect(composer.value).toBe("");
  });

  it("falls through to the agent's and Gram's commands for a name no verb starts", async () => {
    const { composer, user } = await setup();
    await user.click(composer);
    await user.type(composer, "/mod");
    await waitFor(() => expect(slashMenu()).not.toBeNull());
    expect(verbMenu()).toBeNull();
    expect(within(slashMenu()!).getByRole("option", { name: /\/model/ })).toBeTruthy();
  });

  it("leaves Enter and Escape to an input method still composing", async () => {
    const { composer, user } = await setup();
    await user.click(composer);
    await user.type(composer, "/mod");
    await waitFor(() => expect(slashMenu()).not.toBeNull());
    fireEvent.keyDown(composer, { key: "Enter", isComposing: true });
    fireEvent.keyDown(composer, { key: "Escape", keyCode: 229 });
    expect(composer.value).toBe("/mod");
    expect(slashMenu()).not.toBeNull();
  });

  it("closes on Escape for that /, as the slash menu does", async () => {
    const { composer, user } = await setup();
    await user.click(composer);
    await user.type(composer, "/");
    await waitFor(() => expect(verbMenu()).not.toBeNull());
    await user.keyboard("{Escape}");
    expect(verbMenu()).toBeNull();
    expect(composer.value).toBe("/");
  });
});

describe("Composer / elsewhere keeps the slash menu", () => {
  it("in a worker's composer", async () => {
    const { composer, user } = await setup({ role: "worker" });
    await user.click(composer);
    await user.type(composer, "/");
    await waitFor(() => expect(slashMenu()).not.toBeNull());
    expect(verbMenu()).toBeNull();
  });
});
