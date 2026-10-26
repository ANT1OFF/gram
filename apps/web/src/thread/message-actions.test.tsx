// @vitest-environment happy-dom
import {
  InvalidState,
  NotImplemented,
  type AgentCapabilities,
  type ProjectId,
  type GramUIMessage,
  type ThreadId,
  type ThreadStatus,
  type ThreadSummary,
} from "@gram/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiProvider } from "@/api/context";
import type { Api } from "@/api/types";
import { useDraftStore } from "@/stores/drafts";
import { useThreadsStore } from "@/stores/threads";

import { MessageActions } from "./message-actions";

const T = "t1" as ThreadId;

const capabilities = (rewind: AgentCapabilities["rewind"]): AgentCapabilities => ({
  fork: true,
  rewind,
  steer: true,
  planMode: true,
  approvalScopes: ["once", "session", "always"],
  userQuestions: true,
  costReporting: true,
  perTurnModel: true,
  reasoningEffort: false,
  listSessions: false,
  subagentStreams: false,
  stopTasks: false,
});

const seed = (status: ThreadStatus, rewind?: AgentCapabilities["rewind"]) =>
  useThreadsStore.getState().applyEvent({
    type: "threads.snapshot",
    threads: [
      {
        status,
        pendingRequests: [],
        queue: [],
        ...(rewind === undefined ? {} : { capabilities: capabilities(rewind) }),
        thread: {
          id: T,
          projectId: "p" as ProjectId,
          title: "t",
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
        },
      } satisfies ThreadSummary,
    ],
  });

const assistant: GramUIMessage = {
  id: "a1",
  role: "assistant",
  metadata: { agentMessageIds: ["sdk-1", "sdk-2"] },
  parts: [{ type: "text", text: "Done." }],
};
const user: GramUIMessage = {
  id: "u1",
  role: "user",
  parts: [{ type: "text", text: "Fix the retry test" }],
};

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

vi.mock("@/stores/feeds", () => ({ feedMessages: () => [user, assistant] }));

const renderActions = (message: GramUIMessage, rewind: Api["rewind"]) =>
  render(
    <ApiProvider api={{ rewind } as unknown as Api}>
      <MessageActions threadId={T} message={message} />
    </ApiProvider>,
  );

const rewindRejecting = async (error: unknown) => {
  seed("idle", "history");
  renderActions(
    assistant,
    vi.fn(async () => Promise.reject(error)),
  );
  fireEvent.click(screen.getByTestId("message-rewind"));
  fireEvent.click(await screen.findByRole("button", { name: "Rewind" }));
  return (await screen.findByRole("alert")).textContent;
};

afterEach(() => {
  cleanup();
  useThreadsStore.setState({ byId: {} });
  useDraftStore.setState({ text: {}, edits: {} });
});

describe("MessageActions copy", () => {
  it("copies the message as Markdown, then says Copied", async () => {
    seed("idle", "history");
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    renderActions(assistant, vi.fn());

    fireEvent.click(screen.getByTestId("message-copy"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Done."));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    expect(screen.queryByTestId("turn-copy")).toBeNull();
  });

  it("copies the whole turn from its last reply", async () => {
    seed("idle", "history");
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(
      <ApiProvider api={{} as Api}>
        <MessageActions threadId={T} message={assistant} turnEnd />
      </ApiProvider>,
    );

    expect(screen.queryByTestId("turn-copy")).toBeNull();
    fireEvent.click(screen.getByTestId("message-more"));
    fireEvent.click(await screen.findByTestId("turn-copy"));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        "**You**\n\nFix the retry test\n\n**Assistant**\n\nDone.",
      ),
    );
    expect(await screen.findByRole("menuitem", { name: "Copied" })).toBeTruthy();
  });

  it("says why when the clipboard refuses", async () => {
    seed("idle", "history");
    const writeText = vi.fn(async () => Promise.reject(new Error("Document is not focused")));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    renderActions(user, vi.fn());

    fireEvent.click(screen.getByTestId("message-copy"));
    await waitFor(() =>
      expect(useThreadsStore.getState().notifications.at(-1)).toMatchObject({
        kind: "error",
        title: "Couldn't copy",
        body: "Document is not focused",
      }),
    );
    expect(screen.getByRole("button", { name: "Copy message" })).toBeTruthy();
  });
});

describe("MessageActions", () => {
  it("rewinds to an assistant message, restoring files when the agent supports it", async () => {
    seed("idle", "historyAndFiles");
    const rewind = vi.fn(async () => {});
    renderActions(assistant, rewind);

    fireEvent.click(screen.getByTestId("message-rewind"));
    fireEvent.click(await screen.findByLabelText("Restore files too"));
    fireEvent.click(screen.getByRole("button", { name: "Rewind" }));

    await waitFor(() => expect(rewind).toHaveBeenCalledWith(T, "a1", true));
  });

  it("offers history only when capabilities are absent or history-only", async () => {
    for (const rewind of [undefined, "history"] as const) {
      seed("idle", rewind);
      renderActions(assistant, vi.fn());
      fireEvent.click(screen.getByTestId("message-rewind"));
      await screen.findByRole("button", { name: "Rewind" });
      expect(screen.queryByLabelText("Restore files too")).toBeNull();
      cleanup();
    }
  });

  it("hides the actions when the agent can't rewind", () => {
    seed("idle", "none");
    renderActions(assistant, vi.fn());
    expect(screen.queryByTestId("message-rewind")).toBeNull();
  });

  it("explains NotImplemented and InvalidState failures", async () => {
    expect(await rewindRejecting(new NotImplemented({ rpc: "thread.rewind" }))).toBe(
      "Rewind isn't available yet.",
    );
    cleanup();
    expect(await rewindRejecting(new InvalidState({ message: "a turn is running" }))).toBe(
      "Can't rewind right now: a turn is running",
    );
  });

  it("pre-fills the composer for an edit without rewinding yet", async () => {
    seed("idle", "history");
    const rewind = vi.fn(async () => {});
    renderActions(user, rewind);

    fireEvent.click(screen.getByTestId("message-edit"));
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));

    expect(useDraftStore.getState().text[T]).toBe("Fix the retry test");
    expect(useDraftStore.getState().edits[T]).toEqual({ messageId: "u1", files: false });
    expect(rewind).not.toHaveBeenCalled();
  });

  it.each(["starting", "running", "needsApproval", "needsInput"] as const)(
    "blocks rewinding while %s but keeps the reason keyboard-accessible",
    (status) => {
      seed(status, "history");
      renderActions(assistant, vi.fn());
      const trigger = screen.getByTestId("message-rewind");
      expect(trigger.getAttribute("aria-disabled")).toBe("true");
      expect(trigger.tabIndex).toBe(0);
      expect(trigger.getAttribute("aria-description")).toBe("Wait for the turn to finish");
      fireEvent.click(trigger);
      expect(screen.queryByTestId("rewind-confirm")).toBeNull();
    },
  );

  it("explains a reply without agent message ids and blocks both forks", async () => {
    seed("idle", "history");
    renderActions({ ...assistant, metadata: {} }, vi.fn());
    const trigger = screen.getByTestId("message-rewind");
    expect(trigger.getAttribute("aria-disabled")).toBe("true");

    expect(trigger.getAttribute("aria-description")).toBe("This reply can't be rewound to yet");
    const fork = screen.getByTestId("message-fork");
    expect(fork.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(fork);
    fireEvent.click(screen.getByTestId("message-more"));
    const worktree = await screen.findByTestId("message-fork-worktree");
    expect(worktree.getAttribute("aria-disabled")).toBe("true");
    expect(worktree.textContent).toContain("This reply can't be forked from yet");
    fireEvent.click(worktree);
    expect(screen.queryByTestId("fork-dialog")).toBeNull();
  });
});
