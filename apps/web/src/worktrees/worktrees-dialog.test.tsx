// @vitest-environment happy-dom
import type { GitState } from "@gram/contracts";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockApi, type MockApi } from "@/api/mock";
import { renderWithApi } from "@/panels/test-utils";
import { useThreadsStore } from "@/stores/threads";
import { ThreadDialogs } from "@/thread/thread-dialogs";
import { useThreadDialogs } from "@/thread/thread-dialogs-store";

import { WorktreesDialog } from "./worktrees-dialog";

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
}));

const API = "/Users/dev/code/api";
const EXPERIMENT = `${API}/.worktrees/cache-experiment`;

async function seedStore(api: MockApi) {
  const abort = new AbortController();
  for await (const event of api.events(abort.signal)) {
    useThreadsStore.getState().applyEvent(event);
    if (event.type === "threads.snapshot") break;
  }
  abort.abort();
}

const row = (name: string) => screen.getByRole("listitem", { name });

let api: MockApi;

beforeEach(async () => {
  api = createMockApi({ speed: 0, autoplay: false });
  await seedStore(api);
});

afterEach(() => {
  cleanup();
  useThreadsStore.setState({ byId: {} });
  useThreadDialogs.setState({ dialog: undefined, error: undefined });
});

describe("WorktreesDialog", () => {
  it("keeps the first checkout owner and updates rows from the current thread snapshot", async () => {
    const byId = useThreadsStore.getState().byId;
    const owner = byId["t-flaky"]!;
    const sibling = {
      ...owner,
      thread: { ...owner.thread, id: "t-sibling" as typeof owner.thread.id, title: "Other owner" },
    };
    useThreadsStore.setState({ byId: { ...byId, [sibling.thread.id]: sibling } });
    renderWithApi(<WorktreesDialog repoPath={API} onClose={() => {}} />, api);

    const worktree = await screen.findByRole("listitem", { name: "fix/flaky-retry" });
    expect(worktree.textContent).toContain("Used by “Fix flaky retry test”");
    expect(within(worktree).queryByRole("checkbox")).toBeNull();
    act(() => {
      useThreadsStore.setState({
        byId: {
          ...useThreadsStore.getState().byId,
          [owner.thread.id]: { ...owner, thread: { ...owner.thread, title: "Renamed owner" } },
        },
      });
    });
    expect(worktree.textContent).toContain("Used by “Renamed owner”");

    act(() => {
      const { [owner.thread.id]: _removed, ...remaining } = useThreadsStore.getState().byId;
      useThreadsStore.setState({ byId: remaining });
    });
    expect(worktree.textContent).toContain("Used by “Other owner”");
    expect(within(worktree).queryByRole("checkbox")).toBeNull();
  });

  it("lists the main checkout first, each worktree's thread and its uncommitted work", async () => {
    renderWithApi(<WorktreesDialog repoPath={API} onClose={() => {}} />, api);

    await waitFor(() => expect(screen.getAllByTestId("worktree-row").length).toBeGreaterThan(3));
    const [first] = screen.getAllByTestId("worktree-row");
    expect(first!.getAttribute("aria-label")).toBe("Main checkout");
    expect(within(first!).queryByRole("button", { name: "Remove…" })).toBeNull();

    const flaky = row("fix/flaky-retry");
    expect(flaky.textContent).toContain("Used by “Fix flaky retry test”");
    expect(flaky.textContent).toContain("Close the thread to remove its worktree");
    expect(within(flaky).queryByRole("button", { name: "Remove…" })).toBeNull();
    expect((await within(flaky).findByTestId("worktree-warning")).textContent).toBe(
      "This worktree has 5 uncommitted changes and 2 commits not merged to main.",
    );
    expect((await within(row("chore/deps")).findByTestId("worktree-clean")).textContent).toBe(
      "Clean",
    );

    const experiment = row("experiment/cache");
    expect(experiment.textContent).toContain("No thread");
    expect(experiment.textContent).toContain(EXPERIMENT);
    expect((await within(experiment).findByTestId("worktree-warning")).textContent).toBe(
      "This worktree has 2 uncommitted changes and 1 commit not merged to main.",
    );
  });

  it("removes an unused worktree with the picked rules, forcing after a dirty refusal", async () => {
    renderWithApi(<WorktreesDialog repoPath={API} onClose={() => {}} />, api);

    const experiment = await screen.findByRole("listitem", { name: "experiment/cache" });
    fireEvent.click(within(experiment).getByRole("button", { name: "Remove…" }));
    fireEvent.click(
      await within(experiment).findByRole("checkbox", { name: "WebFetch(domain:github.com)" }),
    );
    fireEvent.click(within(experiment).getByRole("button", { name: "Delete worktree" }));

    expect(await within(experiment).findByText(/Delete it anyway\?/)).toBeTruthy();
    expect(experiment.textContent).toContain("This worktree has 2 uncommitted changes");
    expect(api.lastRemove).toEqual({
      path: EXPERIMENT,
      options: { force: false, permissionRules: ["Bash(pnpm test:*)"] },
    });

    fireEvent.click(within(experiment).getByRole("button", { name: "Delete anyway" }));
    await waitFor(() =>
      expect(screen.queryByRole("listitem", { name: "experiment/cache" })).toBeNull(),
    );
    expect(api.lastRemove?.options).toEqual({
      force: true,
      permissionRules: ["Bash(pnpm test:*)"],
    });
    expect(screen.getByRole("status").textContent).toBe(
      "Removed the worktree folder cache-experiment. The branch experiment/cache and its commits are kept.",
    );
  });

  it("keeps keyboard focus in the dialog when a removal is cancelled or done", async () => {
    renderWithApi(<WorktreesDialog repoPath={API} onClose={() => {}} />, api);
    const experiment = await screen.findByRole("listitem", { name: "experiment/cache" });
    const removeButton = () => within(experiment).getByRole("button", { name: "Remove…" });

    removeButton().focus();
    fireEvent.click(removeButton());
    const cancel = await within(experiment).findByRole("button", { name: "Cancel" });
    cancel.focus();
    fireEvent.click(cancel);
    await waitFor(() => expect(document.activeElement).toBe(removeButton()));

    fireEvent.click(removeButton());
    const remove = await within(experiment).findByRole("button", { name: "Delete worktree" });
    await waitFor(() => expect(remove.hasAttribute("disabled")).toBe(false));
    fireEvent.click(remove);
    const anyway = await within(experiment).findByRole("button", { name: "Delete anyway" });
    anyway.focus();
    fireEvent.click(anyway);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("status")));
  });

  it("shows the server's refusal inline", async () => {
    const listWorktrees = vi.fn(async () => ({
      repoTop: "/r",
      worktrees: [
        {
          path: "/r/.worktrees/x",
          branch: "x",
          detached: false,
          isMain: false,
          isOpen: false,
          lastActivity: 0,
        },
      ],
    }));
    const removeWorktree = vi.fn(async () => {
      throw Object.assign(new Error("A thread has this worktree open"), { _tag: "InvalidState" });
    });
    renderWithApi(<WorktreesDialog repoPath="/r" onClose={() => {}} />, {
      listWorktrees,
      removeWorktree,
      worktreeStatus: vi.fn(async () => ({ repo: false }) as GitState),
      worktreePendingPermissions: vi.fn(async () => []),
    });

    fireEvent.click(await screen.findByRole("button", { name: "Remove…" }));
    const remove = await screen.findByRole("button", { name: "Delete worktree" });
    await waitFor(() => expect(remove.hasAttribute("disabled")).toBe(false));
    fireEvent.click(remove);
    expect((await screen.findByRole("alert")).textContent).toBe("A thread has this worktree open");
  });

  it("won't remove a worktree open in a thread it doesn't know", async () => {
    useThreadsStore.setState({ byId: {} });
    const listWorktrees = vi.fn(async () => ({
      repoTop: "/r",
      worktrees: [
        {
          path: "/r",
          branch: "main",
          detached: false,
          isMain: true,
          isOpen: false,
          lastActivity: 0,
        },
        {
          path: "/r/.worktrees/y",
          branch: "y",
          detached: false,
          isMain: false,
          isOpen: true,
          lastActivity: 0,
        },
      ],
    }));
    renderWithApi(<WorktreesDialog repoPath="/r" onClose={() => {}} />, {
      listWorktrees,
      worktreeStatus: vi.fn(async () => ({ repo: false }) as GitState),
    });

    const open = await screen.findByRole("listitem", { name: "y" });
    expect(open.textContent).toContain("open in a thread");
    expect(open.textContent).toContain("Close the thread to remove its worktree");
    expect(screen.queryByRole("button", { name: "Remove…" })).toBeNull();
  });

  it("opens from the thread dialogs store", async () => {
    useThreadDialogs.getState().open({ kind: "worktrees", repoPath: API });
    renderWithApi(<ThreadDialogs />, api);
    expect(await screen.findByTestId("worktrees-dialog")).toBeTruthy();
    expect(await screen.findByRole("listitem", { name: "Main checkout" })).toBeTruthy();
  });
});
