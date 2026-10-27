// @vitest-environment happy-dom
import type {
  AgentCapabilities,
  ProjectId,
  QueueItemId,
  ThreadId,
  ThreadSummary,
} from "@gram/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { ApiProvider } from "@/api/context";
import type { Api } from "@/api/types";
import { useThreadsStore } from "@/stores/threads";

import { QueueList, SEND_NOW_LABEL, STEER_LABEL, steerBlocked } from "./queue-list";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
  }: {
    children?: ReactNode;
    to: string;
    params: { threadId: string };
  }) => <a href={to.replace("$threadId", params.threadId)}>{children}</a>,
}));

const T = "t1" as ThreadId;

const summary: ThreadSummary = {
  status: "running",
  pendingRequests: [],
  capabilities: { steer: true } as AgentCapabilities,
  queue: [
    { id: "q1" as QueueItemId, input: { text: "one" } },
    { id: "q2" as QueueItemId, input: { text: "two" } },
  ],
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
};

const fakeApi = () => {
  const ops = {
    queueEdit: vi.fn(async () => {}),
    queueReorder: vi.fn(async () => {}),
    queueRemove: vi.fn(async () => {}),
    queueSteer: vi.fn(async () => {}),
  };
  return { api: ops as unknown as Api, ops };
};

const seed = (patch: Partial<ThreadSummary> = {}) =>
  useThreadsStore
    .getState()
    .applyEvent({ type: "threads.snapshot", threads: [{ ...summary, ...patch }] });

const renderQueue = (api: Api) =>
  render(
    <ApiProvider api={api}>
      <QueueList threadId={T} />
    </ApiProvider>,
  );

const itemTexts = () => screen.getAllByTestId("queue-item").map((li) => li.textContent);

const steerOf = (index: number) =>
  within(screen.getAllByTestId("queue-item")[index]!).getByTestId("queue-steer");

beforeEach(() => seed());
afterEach(cleanup);

describe("QueueList", () => {
  it("renders nothing when the queue is empty", () => {
    useThreadsStore.getState().applyEvent({ type: "thread.queue", threadId: T, queue: [] });
    renderQueue(fakeApi().api);
    expect(screen.queryByTestId("queue")).toBeNull();
  });

  it("removes an item", async () => {
    const { api, ops } = fakeApi();
    renderQueue(api);
    fireEvent.click(
      within(screen.getAllByTestId("queue-item")[0]!).getByRole("button", { name: "Remove" }),
    );
    await waitFor(() => expect(itemTexts()).toEqual(["two"]));
    expect(ops.queueRemove).toHaveBeenCalledWith(T, "q1");
  });

  it("moves an item down", async () => {
    const { api, ops } = fakeApi();
    renderQueue(api);
    fireEvent.click(
      within(screen.getAllByTestId("queue-item")[0]!).getByRole("button", { name: "Move down" }),
    );
    await waitFor(() => expect(itemTexts()).toEqual(["two", "one"]));
    expect(ops.queueReorder).toHaveBeenCalledWith(T, ["q2", "q1"]);
  });

  it("edits an item inline", async () => {
    const { api, ops } = fakeApi();
    renderQueue(api);
    fireEvent.click(
      within(screen.getAllByTestId("queue-item")[1]!).getByRole("button", { name: "Edit" }),
    );
    fireEvent.change(screen.getByLabelText("Edit queued message"), { target: { value: "deux" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(itemTexts()[1]).toContain("deux"));
    expect(ops.queueEdit).toHaveBeenCalledWith(T, "q2", { text: "deux" });
  });

  it("steers an item into the running turn and takes it off the list", async () => {
    const { api, ops } = fakeApi();
    renderQueue(api);
    fireEvent.click(
      within(screen.getAllByTestId("queue-item")[1]!).getByRole("button", { name: STEER_LABEL }),
    );
    await waitFor(() => expect(itemTexts()).toEqual(["one"]));
    expect(ops.queueSteer).toHaveBeenCalledWith(T, "q2");
  });

  it("puts a rejected steer back on the list", async () => {
    const { api, ops } = fakeApi();
    const refused = new Error("InvalidState");
    ops.queueSteer.mockRejectedValueOnce(refused);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    onTestFinished(() => logged.mockRestore());
    renderQueue(api);
    fireEvent.click(steerOf(0));
    await waitFor(() => expect(itemTexts()).toEqual(["one", "two"]));
    await waitFor(() => expect(logged).toHaveBeenCalledExactlyOnceWith("queue", refused));
  });

  it("sends an item now when no turn is running, whatever the agent can steer", async () => {
    seed({ status: "idle", capabilities: { steer: false } as AgentCapabilities });
    const { api, ops } = fakeApi();
    renderQueue(api);
    expect(steerOf(0).getAttribute("aria-label")).toBe(SEND_NOW_LABEL);
    fireEvent.click(steerOf(0));
    await waitFor(() => expect(itemTexts()).toEqual(["two"]));
    expect(ops.queueSteer).toHaveBeenCalledWith(T, "q1");
    expect(steerBlocked("cold", true, "claude")).toBeUndefined();
    expect(steerBlocked("error", true, "claude")).toBeUndefined();
  });

  it("disables Steer, saying why, unless the thread is running an agent that can steer", () => {
    seed({ status: "starting" });
    const { api, ops } = fakeApi();
    renderQueue(api);
    expect(steerOf(0).getAttribute("aria-label")).toBe(
      "Steer now (No turn is running to steer into)",
    );
    fireEvent.click(steerOf(0));
    expect(ops.queueSteer).not.toHaveBeenCalled();

    cleanup();
    seed({ capabilities: { steer: false } as AgentCapabilities });
    renderQueue(fakeApi().api);
    expect(steerOf(1).getAttribute("aria-label")).toContain("can't take a message mid-turn");
    expect(steerOf(1).getAttribute("aria-disabled")).toBe("true");

    expect(steerBlocked("running", true, "claude")).toBeUndefined();
    expect(steerBlocked("needsApproval", true, "claude")).toBe(
      "The turn is waiting on you: steer once it's running again",
    );
  });

  it("says which thread queued a message and why, and nothing on the user's own", () => {
    seed({
      queue: [
        { id: "q1" as QueueItemId, input: { text: "mine" } },
        {
          id: "q2" as QueueItemId,
          input: {
            text: "The API is v2.",
            origin: {
              threadId: "t-orch" as ThreadId,
              title: "Orchestrator · api",
              depth: 1,
              role: "orchestrator",
              mode: "queue",
            },
          },
        },
        {
          id: "q3" as QueueItemId,
          input: {
            text: "Stop and rebase.",
            origin: {
              threadId: "t-orch" as ThreadId,
              title: "Orchestrator · api",
              depth: 1,
              mode: "steer",
            },
          },
        },
        {
          id: "q4" as QueueItemId,
          input: {
            text: "hi",
            origin: { threadId: "t-p" as ThreadId, title: "Planner", depth: 1 },
          },
        },
      ],
    });
    renderQueue(fakeApi().api);
    const [mine, context, fallback, plain] = screen.getAllByTestId("queue-item");
    expect(within(mine!).queryByTestId("queue-origin")).toBeNull();
    expect(within(context!).getByTestId("queue-origin").textContent).toBe(
      "FromOrchestrator · api· queued as context",
    );
    expect(within(context!).getByRole("link").getAttribute("href")).toBe("/t/t-orch");
    expect(within(fallback!).getByTestId("queue-origin").textContent).toContain(
      "queued, as it couldn't be steered",
    );
    expect(within(plain!).getByTestId("queue-origin").textContent).toBe("FromPlanner");
  });

  it("marks a queued item that carries attachments", () => {
    seed({
      queue: [
        {
          id: "q1" as QueueItemId,
          input: { text: "look", attachments: [{ path: "/tmp/shot.png" }] },
        },
      ],
    });
    renderQueue(fakeApi().api);
    expect(screen.getByLabelText("1 attachment")).toBeTruthy();
  });
});
