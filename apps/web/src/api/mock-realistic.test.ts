// @vitest-environment happy-dom
import type { ThreadId } from "@gram/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createThreadFeed, syncScheduler } from "@/stores/thread-feed";

import { createMockApi, type MockApi } from "./mock";
import { MOCK_ORCHESTRATION_KEY } from "./mock-overrides";

const messagesOf = async (api: MockApi, threadId: ThreadId) => {
  const abort = new AbortController();
  const feed = createThreadFeed({ scheduler: syncScheduler });
  for await (const event of api.threadFeed(threadId, abort.signal)) {
    feed.apply(event);
    if (event.type === "caughtUp") break;
  }
  abort.abort();
  return feed.store.getState().messages;
};

beforeEach(() => sessionStorage.clear());
afterEach(() => sessionStorage.clear());

describe("the realistic mock scenario", () => {
  it("starts with four calm workspaces, live workers and a single ask", async () => {
    sessionStorage.setItem(MOCK_ORCHESTRATION_KEY, "realistic");
    const api = createMockApi({ speed: 0, autoplay: false });
    const workspaces = await api.listWorkspaces();
    expect(workspaces.map((state) => state.workspace.name)).toEqual([
      "Gram",
      "billing-api",
      "web",
      "infra",
    ]);
    const made = await api.startedRealistic();
    expect(made).toBeDefined();

    // The seeded solo threads' question and plan are left answered: the worker's is the one ask.
    const asking = [made!.asking, "t-question", "t-plan"].map(
      (id) => api.world.summary(id as ThreadId).pendingRequests.length,
    );
    expect(asking).toEqual([1, 0, 0]);

    // Each live worker keeps what it is doing on its summary, for a window that loads later.
    for (const { threadId } of made!.running) {
      expect(api.world.summary(threadId)).toMatchObject({ status: "running" });
      expect(api.world.summary(threadId).activity).toMatch(/^(Running|Editing) /);
    }

    // The orchestrator's morning: digests with merges, replies, and a "Since you left" window.
    const messages = await messagesOf(api, made!.orchestratorThreadId);
    const digests = messages.filter((message) =>
      message.parts.some((part) => part.type === "data-orchestration-digest"),
    );
    expect(digests).toHaveLength(4);
    expect(messages.filter((message) => message.role === "assistant").length).toBeGreaterThan(5);
    const orchestrator = api.world.summary(made!.orchestratorThreadId).thread;
    expect(orchestrator.lastViewedAt).toBeLessThan(digests.at(-1)!.metadata!.createdAt!);

    // The search worker's finished turn changed three files, for its card and Undo.
    const transcript = await messagesOf(api, made!.searchWorker);
    const turnId = transcript.find((message) => message.metadata?.turnId !== undefined)?.metadata
      ?.turnId;
    expect(turnId).toBeDefined();
    const diff = await api.gitDiff(made!.searchWorker, { kind: "turn", turnId: turnId! });
    expect(diff.repo && diff.files?.map((file) => file.path)).toHaveLength(3);
  });

  it("leaves the seeded asks and workspaces alone without the flag", async () => {
    const api = createMockApi({ speed: 0, autoplay: false });
    expect(await api.listWorkspaces()).toEqual([]);
    expect(await api.startedRealistic()).toBeUndefined();
    expect(api.world.summary("t-question" as ThreadId).pendingRequests).toHaveLength(1);
  });
});
