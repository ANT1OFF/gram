// @vitest-environment happy-dom
import { DEFAULT_SETTINGS, type ThreadId } from "@gram/contracts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockApi, type MockApi } from "@/api/mock";
import { installKeyboard, isMac } from "@/keyboard/registry";
import { renderWithApi } from "@/panels/test-utils";
import { useServerSettings } from "@/settings-sync/store";
import { EMPTY_GRID, useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";

import { ThreadDialogs } from "./thread-dialogs";
import { useThreadDialogs } from "./thread-dialogs-store";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  useParams: () => ({ threadId: "t-flaky" }),
  useLocation: ({ select }: { select: (location: { pathname: string }) => unknown }) =>
    select({ pathname: "/t/t-flaky" }),
}));

const FLAKY = "t-flaky" as ThreadId;

async function seedStore(api: MockApi) {
  const abort = new AbortController();
  for await (const event of api.events(abort.signal)) {
    useThreadsStore.getState().applyEvent(event);
    if (event.type === "threads.snapshot") break;
  }
  abort.abort();
}

/** Stands in for pane `index` of the grid, with its composer. */
function addPaneComposer(index: number): HTMLTextAreaElement {
  const pane = document.createElement("div");
  pane.dataset["paneIndex"] = String(index);
  const composer = document.createElement("textarea");
  composer.setAttribute("aria-label", "Message");
  pane.append(composer);
  document.body.append(pane);
  return composer;
}

let api: MockApi;

beforeEach(async () => {
  api = createMockApi({ speed: 0, autoplay: false });
  await seedStore(api);
  useLayoutStore.setState({ grid: { ...EMPTY_GRID, panes: [FLAKY] } });
});

afterEach(() => {
  cleanup();
  for (const pane of document.querySelectorAll("[data-pane-index]")) pane.remove();
  useThreadDialogs.setState({ dialog: undefined, error: undefined });
  useServerSettings.setState({ settings: undefined });
  navigate.mockReset();
});

describe("CloseThreadDialog", () => {
  it("warns, deletes the worktree with picked rules, and forces after a dirty refusal", async () => {
    useThreadDialogs.getState().open({ kind: "close", threadId: FLAKY });
    renderWithApi(<ThreadDialogs />, api);

    const dialog = await screen.findByTestId("close-thread-dialog");
    expect(dialog.textContent).toContain("5 uncommitted changes and 2 commits not merged to main");

    fireEvent.click(screen.getByRole("checkbox", { name: /Also delete the worktree/ }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "WebFetch(domain:github.com)" }));
    fireEvent.click(screen.getByRole("button", { name: "Close and delete worktree" }));

    expect(await screen.findByText(/Delete it anyway\?/)).toBeTruthy();
    expect(api.lastClose?.options).toEqual({
      removeWorktree: { force: false },
      permissionRules: ["Bash(pnpm test:*)"],
    });

    fireEvent.click(screen.getByRole("button", { name: "Delete anyway" }));
    await waitFor(() => expect(screen.queryByTestId("close-thread-dialog")).toBeNull());
    expect(api.lastClose?.options).toEqual({
      removeWorktree: { force: true },
      permissionRules: ["Bash(pnpm test:*)"],
    });
    expect(useLayoutStore.getState().grid.panes).not.toContain(FLAKY);
    expect(navigate).toHaveBeenCalledWith({ to: "/" });
  });

  it("just closes a thread on the main checkout", async () => {
    const main = Object.values(useThreadsStore.getState().byId).find(
      (s) => s.thread.checkout.kind === "main",
    )!;
    useThreadDialogs.getState().open({ kind: "close", threadId: main.thread.id });
    renderWithApi(<ThreadDialogs />, api);

    await screen.findByTestId("close-thread-dialog");
    expect(screen.queryByRole("checkbox", { name: /Also delete the worktree/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close thread" }));
    await waitFor(() => expect(api.lastClose).toEqual({ threadId: main.thread.id, options: {} }));
  });

  it("gives the caret to the pane that takes focus once the closed thread's pane is gone", async () => {
    const main = Object.values(useThreadsStore.getState().byId).find(
      (s) => s.thread.checkout.kind === "main",
    )!;
    useLayoutStore.setState({
      grid: { ...EMPTY_GRID, preset: "3c", panes: [main.thread.id, FLAKY, null], focused: 0 },
    });
    const composer = addPaneComposer(1);
    useThreadDialogs.getState().open({ kind: "close", threadId: main.thread.id });
    renderWithApi(<ThreadDialogs />, api);

    fireEvent.click(await screen.findByRole("button", { name: "Close thread" }));
    await waitFor(() => expect(screen.queryByTestId("close-thread-dialog")).toBeNull());
    expect(useLayoutStore.getState().grid.focused).toBe(1);
    await waitFor(() => expect(document.activeElement).toBe(composer));
  });
});

describe("pane shortcuts", () => {
  it("⌘W closes the pane and gives the caret to the pane that takes focus", async () => {
    const uninstall = installKeyboard(window);
    try {
      useLayoutStore.setState({
        grid: {
          ...EMPTY_GRID,
          preset: "3c",
          panes: [FLAKY, "t-deps" as ThreadId, null],
          focused: 0,
        },
      });
      const composer = addPaneComposer(1);
      renderWithApi(<ThreadDialogs />, api);

      fireEvent.keyDown(window, { key: "w", code: "KeyW", metaKey: isMac(), ctrlKey: !isMac() });
      expect(useLayoutStore.getState().grid).toMatchObject({
        panes: [null, "t-deps", null],
        focused: 1,
      });
      await waitFor(() => expect(document.activeElement).toBe(composer));
    } finally {
      uninstall();
    }
  });
});

describe("other thread dialogs", () => {
  it("renames a thread", async () => {
    const rename = vi.spyOn(api, "rename");
    useThreadDialogs.getState().open({ kind: "rename", threadId: FLAKY });
    renderWithApi(<ThreadDialogs />, api);

    fireEvent.change(await screen.findByRole("textbox", { name: "Thread title" }), {
      target: { value: "  Deterministic retry test  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(rename).toHaveBeenCalledWith(FLAKY, "Deterministic retry test"));
    await waitFor(() => expect(screen.queryByTestId("rename-dialog")).toBeNull());
  });

  it("creates and deletes labels", async () => {
    useThreadDialogs.getState().open({ kind: "labels" });
    renderWithApi(<ThreadDialogs />, api);

    await waitFor(() => expect(screen.getAllByTestId("label-row")).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: "New label" }));
    await waitFor(() => expect(screen.getAllByTestId("label-row")).toHaveLength(3));

    fireEvent.click(screen.getByRole("button", { name: "Delete label urgent" }));
    await waitFor(() => expect(screen.getAllByTestId("label-row")).toHaveLength(2));
    expect((await api.labels()).map((l) => l.name)).not.toContain("urgent");
  });

  it("closes every thread after one confirm", async () => {
    const close = vi.spyOn(api, "closeThread");
    const count = Object.keys(useThreadsStore.getState().byId).length;
    useThreadDialogs.getState().open({ kind: "closeAll" });
    renderWithApi(<ThreadDialogs />, api);

    expect(await screen.findByText(`Close all ${count} threads?`)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close all" }));
    await waitFor(() => expect(screen.queryByTestId("close-all-dialog")).toBeNull());
    expect(close).toHaveBeenCalledTimes(count);
    expect(navigate).toHaveBeenCalledWith({ to: "/" });
  });

  it("removes a workspace in one go: its orchestrator, its worker when asked, then the workspace", async () => {
    useServerSettings.setState({
      settings: { ...DEFAULT_SETTINGS },
    });
    const made = await api.simulateOrchestration();
    await seedStore(api);
    const close = vi.spyOn(api, "closeThread");
    const remove = vi.spyOn(api, "removeWorkspace");
    useThreadDialogs.getState().open({ kind: "removeWorkspace", workspaceId: made.workspaceId });
    renderWithApi(<ThreadDialogs />, api);

    const dialog = await screen.findByTestId("remove-workspace-dialog");
    expect(dialog.textContent).toContain("Its worker stays open as an ordinary thread");
    fireEvent.click(screen.getByRole("checkbox", { name: /Also close its worker/ }));
    expect(dialog.textContent).toContain("Its worker stops and closes.");
    fireEvent.click(screen.getByRole("button", { name: "Remove workspace" }));
    await waitFor(() => expect(screen.queryByTestId("remove-workspace-dialog")).toBeNull());
    expect(close.mock.calls.map(([threadId]) => threadId)).toEqual([
      made.orchestratorThreadId,
      made.workerThreadId,
    ]);
    expect(remove).toHaveBeenCalledWith(made.workspaceId);
    expect(await api.listWorkspaces()).toEqual([]);
  });

  it("picks a failed removal up where it stopped, without closing a thread twice", async () => {
    useServerSettings.setState({
      settings: { ...DEFAULT_SETTINGS },
    });
    const made = await api.simulateOrchestration();
    await seedStore(api);
    const close = vi.spyOn(api, "closeThread");
    const removal = Promise.withResolvers<void>();
    vi.spyOn(api, "removeWorkspace").mockImplementationOnce(() => removal.promise);
    useThreadDialogs.getState().open({ kind: "removeWorkspace", workspaceId: made.workspaceId });
    renderWithApi(<ThreadDialogs />, api);

    await screen.findByTestId("remove-workspace-dialog");
    fireEvent.click(screen.getByRole("checkbox", { name: /Also close its worker/ }));
    fireEvent.click(screen.getByRole("button", { name: "Remove workspace" }));
    // Nothing dismisses it while the removal runs.
    await waitFor(() => expect(api.removeWorkspace).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(true);
    fireEvent.keyDown(screen.getByTestId("remove-workspace-dialog"), { key: "Escape" });
    expect(screen.queryByTestId("remove-workspace-dialog")).not.toBeNull();
    removal.reject(new Error("offline"));
    expect((await screen.findByRole("alert")).textContent).toBe("offline");
    // The worker the orchestrator's close cut loose is still in the plan that was confirmed.
    expect(screen.getByTestId("remove-workspace-happens").textContent).toContain(
      "Its worker stops and closes.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove workspace" }));
    await waitFor(() => expect(screen.queryByTestId("remove-workspace-dialog")).toBeNull());
    expect(close.mock.calls.map(([threadId]) => threadId)).toEqual([
      made.orchestratorThreadId,
      made.workerThreadId,
    ]);
    expect(await api.listWorkspaces()).toEqual([]);
  });

  it("shows a failed one-click action", async () => {
    renderWithApi(<ThreadDialogs />, api);
    useThreadDialogs.getState().fail("Couldn't pin the thread: offline");
    expect((await screen.findByRole("alert")).textContent).toBe("Couldn't pin the thread: offline");
  });
});
