import {
  DEFAULT_SPEECH_MODEL,
  type ApprovalRequest,
  type RequestId,
  type ThreadId,
} from "@gram/contracts";
import { describe, expect, it, vi } from "vitest";

import { createThreadFeed, syncScheduler } from "@/stores/thread-feed";

import { createMockApi, type MockApi } from "./mock";
import type { ApiServerEvent } from "./types";

const T = "t-flaky" as ThreadId;

async function waitFor(predicate: () => boolean, label: string) {
  for (let i = 0; i < 2000; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function threadSummary(api: MockApi, threadId: ThreadId) {
  const abort = new AbortController();
  try {
    for await (const event of api.events(abort.signal)) {
      if (event.type === "threads.snapshot")
        return event.threads.find((summary) => summary.thread.id === threadId);
    }
  } finally {
    abort.abort();
  }
  throw new Error("Mock snapshot missing");
}

const independentApproval = (id: string): ApprovalRequest => ({
  kind: "approval",
  id: id as RequestId,
  toolName: "Bash",
  displayName: "Bash",
  input: { command: "pwd" },
  suggestions: [],
});

describe("MockApi", () => {
  it.each([
    ["t-deps", "idle"],
    ["t-grpc", "cold"],
  ] as const)("restores %s to %s after its last independent approval", async (id, status) => {
    const api = createMockApi({ speed: 0, autoplay: false });
    const threadId = id as ThreadId;
    const first = independentApproval("independent-1");
    const second = independentApproval("independent-2");
    expect(await threadSummary(api, threadId)).toMatchObject({ status, pendingRequests: [] });
    api.simulateRequest(threadId, first);
    api.simulateRequest(threadId, second);
    await api.respond(threadId, second.id, {
      kind: "approval",
      decision: "deny",
      scope: "once",
    });
    expect(await threadSummary(api, threadId)).toMatchObject({
      status: "needsApproval",
      pendingRequests: [first],
    });
    await api.respond(threadId, first.id, {
      kind: "approval",
      decision: "allow",
      scope: "once",
    });
    expect(await threadSummary(api, threadId)).toMatchObject({ status, pendingRequests: [] });
  });

  it("returns an independent approval to the running turn without completing it", async () => {
    const api = createMockApi({ speed: 0, autoplay: false });
    const threadId = "t-deps" as ThreadId;
    await api.send(threadId, { text: "Continue the real turn" });
    const request = independentApproval("during-turn");
    api.simulateRequest(threadId, request);
    await api.respond(threadId, request.id, {
      kind: "approval",
      decision: "allow",
      scope: "once",
    });
    expect(await threadSummary(api, threadId)).toMatchObject({
      status: "running",
      pendingRequests: [],
    });
    const abort = new AbortController();
    try {
      for await (const event of api.events(abort.signal)) {
        if (
          event.type === "thread.status" &&
          event.threadId === threadId &&
          event.status === "idle"
        )
          break;
      }
    } finally {
      abort.abort();
    }
  });

  it("settles a manual merge like the server: merged badge, completed thread, one toast", async () => {
    const api = createMockApi({ speed: 0, autoplay: false });
    const abort = new AbortController();
    const events: ApiServerEvent[] = [];
    void (async () => {
      for await (const event of api.events(abort.signal)) events.push(event);
    })();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const toasts = () => events.filter((e) => e.type === "notify" && e.title === "#412 merged");

    await api.prMerge(T, "squash");
    await waitFor(() => toasts().length > 0, "merge toast");
    expect(toasts()).toEqual([expect.objectContaining({ kind: "done", threadId: T })]);
    expect(events.findLast((e) => e.type === "git.state")?.state.pr?.state).toBe("MERGED");
    expect(events.findLast((e) => e.type === "thread.upsert")?.thread.completedAt).toBeTypeOf(
      "number",
    );

    await api.prMerge(T, "squash");
    expect(toasts()).toHaveLength(1);
    abort.abort();
  });

  it("scripts a turn through an approval, then drains the queue", async () => {
    const api = createMockApi({ speed: 0 });
    const abort = new AbortController();
    const events: ApiServerEvent[] = [];
    void (async () => {
      for await (const event of api.events(abort.signal)) events.push(event);
    })();
    const feed = createThreadFeed({ scheduler: syncScheduler });
    void (async () => {
      for await (const event of api.threadFeed(T, abort.signal)) feed.apply(event);
    })();

    await waitFor(() => events.some((e) => e.type === "thread.request"), "approval request");
    const request = events.find((e) => e.type === "thread.request");
    expect(request).toMatchObject({ request: { kind: "approval", toolName: "Bash" } });

    await expect(api.send(T, { text: "also update the changelog" })).resolves.toEqual({
      queued: true,
    });
    expect(events.at(-1)).toMatchObject({
      type: "thread.queue",
      queue: [{ input: { text: "also update the changelog" } }],
    });

    const requestId = (request as { request: { id: RequestId } }).request.id;
    await api.respond(T, requestId, { kind: "approval", decision: "allow", scope: "once" });

    await waitFor(
      () =>
        feed.store
          .getState()
          .messages.some(
            (m) =>
              m.role === "user" &&
              m.parts.some((p) => p.type === "text" && p.text === "also update the changelog"),
          ),
      "queued message sent",
    );
    await waitFor(
      () =>
        events.at(-1)?.type === "thread.upsert" &&
        feed.store.getState().streamingMessageIds.length === 0,
      "turn end",
    );

    const { messages } = feed.store.getState();
    const parts = messages.flatMap((m) => m.parts);
    expect(parts.some((p) => p.type === "tool-Edit" && p.state === "output-available")).toBe(true);
    expect(parts.some((p) => p.type === "data-task-chip")).toBe(true);
    expect(messages.some((m) => m.metadata?.parentToolUseId !== undefined)).toBe(true);
    expect(events.filter((e) => e.type === "thread.plan").length).toBeGreaterThanOrEqual(2);
    // Usage is reported repeatedly as the turn runs; the last report is the turn's total.
    const usages = events.filter((e) => e.type === "thread.usage");
    expect(usages.length).toBeGreaterThanOrEqual(2);
    expect(usages.at(-1)).toMatchObject({ usage: { contextWindow: 200_000, costUsd: 0.63 } });
    abort.abort();
  });

  it("follows a /model the way the server follows the agent's own switch", async () => {
    const api = createMockApi({ speed: 0, autoplay: false });
    const abort = new AbortController();
    const events: ApiServerEvent[] = [];
    void (async () => {
      for await (const event of api.events(abort.signal)) events.push(event);
    })();

    await api.send(T, { text: "/model claude-preview[1m]" });
    await waitFor(
      () => events.some((e) => e.type === "thread.status" && e.status === "idle"),
      "the command's reply",
    );
    abort.abort();

    const upserts = events.flatMap((e) =>
      e.type === "thread.upsert" && e.thread.id === T ? [e.thread.model.model] : [],
    );
    expect(upserts).toContain("claude-preview[1m]");
    expect((await api.modelSuggestions()).suggestions).toContainEqual({
      agent: "claude",
      id: "claude-preview[1m]",
      source: "a thread's model",
    });
  });

  it("rewinds to an assistant reply, or to before a user message", async () => {
    const api = createMockApi({ speed: 0, autoplay: false });
    const abort = new AbortController();
    const feed = createThreadFeed({ scheduler: syncScheduler });
    void (async () => {
      for await (const event of api.threadFeed("t-deps" as ThreadId, abort.signal))
        feed.apply(event);
    })();
    await waitFor(() => feed.store.getState().messages.length === 2, "history");

    await api.rewind("t-deps" as ThreadId, "m-d2", false);
    await waitFor(() => feed.store.getState().phase === "live", "caught up after rewind");
    expect(feed.store.getState().messages.map((m) => m.id)).toEqual(["m-d1", "m-d2"]);

    await api.rewind("t-deps" as ThreadId, "m-d1", true);
    await waitFor(() => feed.store.getState().messages.length === 0, "user message removed");
    await expect(api.rewind("t-deps" as ThreadId, "m-d1", false)).rejects.toThrow("NotFound");
    abort.abort();
  });

  it("resumes a feed from its revision, and from nothing past a rewind", async () => {
    const api = createMockApi({ speed: 0, autoplay: false });
    const D = "t-deps" as ThreadId;
    const feed = createThreadFeed({ scheduler: syncScheduler });
    const heads: string[] = [];
    const open = () => {
      const abort = new AbortController();
      let first = true;
      void (async () => {
        for await (const event of api.threadFeed(D, abort.signal, feed.resume)) {
          if (first && event.type !== "subscribed") heads.push(event.type);
          if (event.type !== "subscribed") first = false;
          feed.apply(event);
        }
      })();
      return abort;
    };
    let abort = open();
    await waitFor(() => feed.store.getState().messages.length === 2, "history");
    abort.abort();

    abort = open();
    await waitFor(() => heads.length === 2, "the second head");
    expect(heads).toEqual(["messages", "resumed"]);
    abort.abort();

    await api.rewind(D, "m-d2", false);
    abort = open();
    await waitFor(() => heads.length === 3, "the third head");
    expect(heads[2]).toBe("messages");
    expect(feed.store.getState().messages.map((m) => m.id)).toEqual(["m-d1", "m-d2"]);
    abort.abort();
  });

  it("reopens a closed thread under its own id, with its conversation", async () => {
    const api = createMockApi({ speed: 0, autoplay: false });
    const question = "t-question" as ThreadId;
    await api.closeThread(question);
    const reopened = await api.reopenClosedThread();
    expect(reopened?.thread?.id).toBe(question);
    expect(reopened?.closed.problem).toBeUndefined();
    const abort = new AbortController();
    const feed = createThreadFeed({ scheduler: syncScheduler });
    for await (const event of api.threadFeed(question, abort.signal)) {
      feed.apply(event);
      if (event.type === "caughtUp") break;
    }
    abort.abort();
    expect(feed.store.getState().messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(await api.reopenClosedThread()).toBeNull();
  });

  it("replays history and in-flight chunks to a late subscriber", async () => {
    const api = createMockApi({ speed: 0, autoplay: false });
    const abort = new AbortController();
    const feed = createThreadFeed({ scheduler: syncScheduler });
    void (async () => {
      for await (const event of api.threadFeed("t-deps" as ThreadId, abort.signal))
        feed.apply(event);
    })();
    await waitFor(() => feed.store.getState().phase === "live", "caught up");
    expect(feed.store.getState().messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    abort.abort();
  });
});

describe("MockApi review", () => {
  it("seeds the bot review into t-flaky's PR badge", async () => {
    const api = createMockApi({ speed: 0, autoplay: false });
    const abort = new AbortController();
    const events: ApiServerEvent[] = [];
    void (async () => {
      for await (const event of api.events(abort.signal)) events.push(event);
    })();
    await waitFor(() => events.length > 0, "snapshot");
    const snapshot = events[0] as Extract<ApiServerEvent, { type: "threads.snapshot" }>;
    expect(snapshot.threads.find((t) => t.thread.id === T)?.git?.pr?.review).toMatchObject({
      verdictOnHead: "changesRequested",
      roundInFlight: false,
      threads: { unresolved: 5, blockers: 2, suggestions: 2, outdatedUnresolved: 1 },
    });
    abort.abort();
  });

  it("replies, applies, resolves and runs a re-review round", async () => {
    const api = createMockApi({ speed: 0, autoplay: false });
    const abort = new AbortController();
    const events: ApiServerEvent[] = [];
    void (async () => {
      for await (const event of api.events(abort.signal)) events.push(event);
    })();
    await waitFor(() => events.length > 0, "snapshot");
    const lastReview = () => events.findLast((e) => e.type === "git.state")?.state.pr?.review;

    const reply = await api.prReplyThread(T, "PRRT_backoff_name", "Renamed in 1a2b3c4.");
    const review = await api.prReview(T);
    expect(review.threads.find((t) => t.id === "PRRT_backoff_name")?.comments.at(-1)).toEqual(
      reply,
    );

    await expect(api.prApplySuggestion(T, "PRRC_2")).resolves.toEqual({
      path: "src/retry.test.ts",
      startLine: 13,
      endLine: 13,
    });
    await expect(api.prApplySuggestion(T, "PRRC_5")).rejects.toMatchObject({
      _tag: "InvalidState",
    });

    await api.prResolveThread(T, "PRRT_restore_timers");
    await waitFor(() => lastReview() !== undefined, "git.state after resolve");
    expect(lastReview()?.threads).toMatchObject({ unresolved: 4, blockers: 1 });

    await expect(api.prRequestRereview(T)).resolves.toEqual({ command: "/agent review" });
    await waitFor(() => lastReview()?.roundInFlight === true, "round in flight");
    await waitFor(() => events.some((e) => e.type === "pr.reviewRound"), "review round");
    expect(events.find((e) => e.type === "pr.reviewRound")).toMatchObject({
      threadId: T,
      round: { number: 3, verdict: "changesRequested", counts: { blockers: 1 } },
    });
    expect(lastReview()).toMatchObject({ roundInFlight: false, latestReviewId: "PRR_round_3" });

    await expect(api.prReview("t-question" as ThreadId)).resolves.toMatchObject({
      available: false,
    });
    abort.abort();
  });
});

describe("MockApi filesystem", () => {
  const api = createMockApi({ speed: 0, autoplay: false });

  const names = async (path: string, limit?: number) =>
    (await api.browse(path, limit)).entries.map((e) => e.name);

  it("lists a folder with ~ expanded, folders only, with git badges", async () => {
    const code = await api.browse("~/Documents/code/");
    expect(code).toMatchObject({
      path: "/Users/dev/Documents/code",
      parent: "/Users/dev/Documents",
      truncated: false,
    });
    expect(code.entries.map((e) => e.name)).not.toContain("README.md");
    expect(code.entries.find((e) => e.name === "gram")).toEqual({
      name: "gram",
      path: "/Users/dev/Documents/code/gram",
      isGitRepo: true,
    });
  });

  it("filters the parent by case-insensitive prefix without a trailing slash", async () => {
    expect(await names("~/Documents/code/GRA")).toEqual(["gram", "graph-tools"]);
    expect(await names("~/")).not.toContain(".config");
    expect(await names("~/.c")).toEqual([".config"]);
    await expect(api.browse("~/Documents/code/", 2)).resolves.toMatchObject({
      truncated: true,
      entries: [{ name: "client-app" }, { name: "gram" }],
    });
  });

  it("rejects like the server", async () => {
    await expect(api.browse("~/nope/")).rejects.toMatchObject({
      _tag: "NotFound",
      entity: "project",
      message: "Folder not found: /Users/dev/nope",
    });
    await expect(api.browse("~/Documents/code/README.md/")).rejects.toMatchObject({
      _tag: "InvalidState",
      message: "Not a folder: /Users/dev/Documents/code/README.md",
    });
    await expect(api.browse("~/Documents/Private/")).rejects.toMatchObject({
      _tag: "InvalidState",
      message: expect.stringContaining("Files & Folders"),
    });
    await expect(
      api.createThread({ projectRoot: "~/nope", checkout: { kind: "current" } }),
    ).rejects.toMatchObject({ _tag: "NotFound" });
  });

  it("records a newly browsed folder as a project when a thread starts there", async () => {
    await api.createThread({
      projectRoot: "/Users/dev/Documents/code/gram",
      checkout: { kind: "current" },
    });
    expect((await api.listProjects())[0]).toMatchObject({
      name: "gram",
      repoRoot: "/Users/dev/Documents/code/gram",
    });
  });
});

describe("background tasks", () => {
  it("stops one by id like the server, and rejects one that isn't running", async () => {
    const api = createMockApi({ speed: 0 });
    const abort = new AbortController();
    const events: ApiServerEvent[] = [];
    void (async () => {
      for await (const event of api.events(abort.signal)) events.push(event);
    })();
    const shell = {
      taskId: "b1",
      kind: "shell" as const,
      description: "Run the checks",
      command: "pnpm check",
      startedAt: 1,
    };
    api.simulateBackground(T, [shell]);
    await api.stopTask(T, "b1");
    await expect(api.stopTask(T, "b1")).rejects.toMatchObject({
      _tag: "NotFound",
      entity: "backgroundTask",
    });
    await waitFor(() => events.filter((e) => e.type === "thread.background").length === 2, "both");
    expect(events.flatMap((e) => (e.type === "thread.background" ? [e.tasks] : []))).toEqual([
      [shell],
      [],
    ]);
    abort.abort();
  });
});

describe("the background subagent script", () => {
  it("goes idle while the subagent works, then answers in a turn of its own", async () => {
    const T_BACKGROUND = "t-background" as ThreadId;
    const api = createMockApi({ speed: 0 });
    const abort = new AbortController();
    const events: ApiServerEvent[] = [];
    void (async () => {
      for await (const event of api.events(abort.signal)) events.push(event);
    })();
    const feed = createThreadFeed({ scheduler: syncScheduler });
    void (async () => {
      for await (const event of api.threadFeed(T_BACKGROUND, abort.signal)) feed.apply(event);
    })();
    const statuses = () =>
      events.flatMap((e) => (e.type === "thread.status" && e.threadId === T_BACKGROUND ? [e] : []));

    await waitFor(() => {
      const last = statuses().at(-1);
      const answered = feed.store
        .getState()
        .messages.some((m) => m.metadata?.initiator === "agent");
      return answered && last?.status === "idle" && last.detail === undefined;
    }, "the script to finish");
    await feed.whenSettled();

    const idleWithSubagent = statuses().findIndex(
      (s) => s.status === "idle" && s.detail?.startsWith("Explore: ") === true,
    );
    const followUp = statuses().findLastIndex((s) => s.status === "running");
    expect(idleWithSubagent).toBeGreaterThan(-1);
    expect(followUp).toBeGreaterThan(idleWithSubagent);
    expect(statuses().at(-1)).toEqual({
      type: "thread.status",
      threadId: T_BACKGROUND,
      status: "idle",
    });

    const messages = feed.store.getState().messages;
    const nested = messages.filter((m) => m.metadata?.parentToolUseId === "toolu_fixture_0023");
    expect(nested).toHaveLength(1);
    expect(messages.at(-1)?.metadata?.initiator).toBe("agent");
    expect(messages.at(-1)?.parts.some((p) => p.type === "text" && p.text === "DONE")).toBe(true);
    abort.abort();
  });
});

describe("MockApi agent runtime", () => {
  it("lists Codex from the store once chosen, and refuses a rollback mid-install", async () => {
    vi.useFakeTimers();
    try {
      const api = createMockApi();
      const before = (await api.agentRuntimes()).agents.find((a) => a.agent === "codex")!;
      expect(before.managed?.candidate?.version).toBe("0.159.4");

      await api.installRuntime("codex", "0.159.4");
      await vi.runAllTimersAsync();
      // Installed, but the user's own codex stays in use until they choose the verified one.
      const installed = (await api.agentRuntimes()).agents.find((a) => a.agent === "codex")!;
      expect(installed.resolved?.source).toBe("path");
      expect(installed.managed).toEqual({});
      await api.setRuntimeSource("codex", "managed");
      const after = (await api.agentRuntimes()).agents.find((a) => a.agent === "codex")!;
      expect(after.resolved).toMatchObject({ source: "managed", version: "0.159.4" });
      expect(after.managed).toEqual({});
      expect(after.newer).toBeUndefined();

      await api.installRuntime("codex", "0.159.5");
      await expect(api.rollbackRuntime("codex")).rejects.toMatchObject({ reason: "busy" });
      await vi.runAllTimersAsync();
      expect((await api.runtimeInstallState("codex")).active?.version).toBe("0.159.5");
      const past = (await api.agentRuntimes()).agents.find((a) => a.agent === "codex")!;
      expect(past.resolved?.version).toBe("0.159.5");
      expect(past.newer).toBeUndefined();
      expect((await api.rollbackRuntime("codex")).active?.version).toBe("0.159.4");

      await api.setRuntimeSource("codex", "path");
      const own = (await api.agentRuntimes()).agents.find((a) => a.agent === "codex")!;
      expect(own.resolved?.source).toBe("path");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("MockApi speech store", () => {
  const model = DEFAULT_SPEECH_MODEL;

  it("resumes a cancelled download from the bytes it kept, then installs and removes", async () => {
    vi.useFakeTimers();
    try {
      const api = createMockApi();
      await api.installSpeechModel(model);
      await vi.advanceTimersByTimeAsync(api.speech.stepMs * 2);
      const cancelled = await api.cancelSpeechInstall(model);
      expect(cancelled.install.state).toBe("idle");
      const kept = cancelled.install.state === "idle" ? cancelled.install.resumableBytes : 0;
      expect(kept).toBeGreaterThan(0);
      // Cancelling again with nothing running keeps what was kept.
      expect((await api.cancelSpeechInstall(model)).install).toEqual(cancelled.install);

      const resumed = await api.installSpeechModel(model);
      expect(resumed.install).toMatchObject({ state: "downloading", receivedBytes: kept });
      await vi.runAllTimersAsync();
      expect((await api.speechStatus(model)).installed?.id).toBe(model);
      expect((await api.removeSpeechModel(model)).installed).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends a watch whose signal is already aborted without registering it", async () => {
    const api = createMockApi();
    const abort = new AbortController();
    abort.abort();
    const seen: unknown[] = [];
    for await (const status of api.watchSpeechInstall(model, abort.signal)) seen.push(status);
    expect(seen).toEqual([]);
  });
});
