// @vitest-environment happy-dom
import {
  InvalidState,
  NotImplemented,
  type AgentCapabilities,
  type ProjectId,
  type GramUIMessage,
  type Thread,
  type ThreadId,
} from "@gram/contracts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithApi } from "@/panels/test-utils";
import { EMPTY_GRID, useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";

import { MessageActions } from "./message-actions";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));

const T = "t1" as ThreadId;

const thread = (id: string, extra: Partial<Thread> = {}): Thread => ({
  id: id as ThreadId,
  projectId: "p" as ProjectId,
  title: id,
  userNamed: false,
  model: { agent: "claude", model: "opus" },
  mode: "default",
  checkout: { kind: "main", path: "/" },
  labels: [],
  pinned: false,
  parked: false,
  unread: false,
  createdAt: 0,
  lastActivityAt: 0,
  ...extra,
});

const seed = (fork: boolean) =>
  useThreadsStore.getState().applyEvent({
    type: "threads.snapshot",
    threads: [
      {
        thread: thread(T),
        status: "idle",
        pendingRequests: [],
        queue: [],
        capabilities: { fork, rewind: "none" } as unknown as AgentCapabilities,
      },
    ],
  });

const reply: GramUIMessage = {
  id: "m2",
  role: "assistant",
  metadata: { agentMessageIds: ["sdk-m2"] },
  parts: [{ type: "text", text: "done" }],
};

afterEach(() => {
  cleanup();
  navigate.mockReset();
  useLayoutStore.setState({ grid: EMPTY_GRID });
});

describe("fork actions", () => {
  it("forks from a reply and opens the fork", async () => {
    seed(true);
    const forkThread = vi.fn(async () => thread("t2", { forkedFrom: { threadId: T } }));
    renderWithApi(<MessageActions threadId={T} message={reply} />, { forkThread });

    fireEvent.click(screen.getByTestId("message-fork"));
    await waitFor(() => expect(forkThread).toHaveBeenCalledWith(T, { fromMessageId: "m2" }));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ to: "/t/$threadId", params: { threadId: "t2" } }),
    );
    expect(useLayoutStore.getState().grid.panes).toEqual(["t2"]);
    expect(useThreadsStore.getState().byId["t2"]?.thread.forkedFrom).toEqual({ threadId: T });
  });

  it("continues in the worktree dialog when the source checkout is in use", async () => {
    seed(true);
    renderWithApi(<MessageActions threadId={T} message={reply} />, {
      forkThread: async () => {
        throw new InvalidState({
          message: "Fork into a new worktree: the source checkout is in use",
        });
      },
      listProjects: async () => [],
    });
    fireEvent.click(screen.getByTestId("message-fork"));
    expect(await screen.findByTestId("fork-dialog")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("needs its own worktree");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("blocks unavailable forks, describes why in the menu, and omits forks on user messages", async () => {
    seed(false);
    const user: GramUIMessage = {
      id: "m1",
      role: "user",
      parts: [{ type: "text", text: "hi" }],
    };
    renderWithApi(
      <>
        <MessageActions threadId={T} message={reply} />
        <MessageActions threadId={T} message={user} />
      </>,
      {},
    );
    expect(screen.getAllByTestId("message-fork")).toHaveLength(1);
    const trigger = screen.getByTestId("message-fork");
    expect(trigger.getAttribute("aria-disabled")).toBe("true");
    expect(trigger.tabIndex).toBe(0);
    fireEvent.click(trigger);
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("message-more"));
    const worktree = await screen.findByTestId("message-fork-worktree");
    expect(worktree.getAttribute("aria-disabled")).toBe("true");
    expect(worktree.textContent).toContain("This agent can't fork threads yet");
  });

  it("opens the worktree dialog from the secondary menu without forking immediately", async () => {
    seed(true);
    const forkThread = vi.fn();
    renderWithApi(<MessageActions threadId={T} message={reply} />, {
      forkThread,
      listProjects: async () => [],
    });
    expect(screen.queryByTestId("message-fork-worktree")).toBeNull();
    fireEvent.click(screen.getByTestId("message-more"));
    fireEvent.click(await screen.findByTestId("message-fork-worktree"));
    expect(await screen.findByTestId("fork-dialog")).toBeTruthy();
    expect(forkThread).not.toHaveBeenCalled();
  });

  it("explains a server that can't fork yet", async () => {
    seed(true);
    renderWithApi(<MessageActions threadId={T} message={reply} />, {
      forkThread: async () => {
        throw new NotImplemented({ rpc: "thread.fork" });
      },
    });
    fireEvent.click(screen.getByTestId("message-fork"));
    expect((await screen.findByRole("alert")).textContent).toBe("Forking isn't available yet.");
    expect(navigate).not.toHaveBeenCalled();
  });
});
