import { describe, expect, it } from "@effect/vitest";
import {
  AgentUnavailable,
  InvalidState,
  EXAMPLE_GATEWAY,
  RequestNotFound,
  type AgentEvent,
  type MessageId,
  type ModelRef,
  type ProfileId,
  type GramUIMessageChunk,
  type RequestId,
  type ServerEvent,
  type ThreadId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Stream from "effect/Stream";
import * as Duration from "effect/Duration";
import * as TestClock from "effect/testing/TestClock";
import { EventHub } from "../events/event-hub.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { closeAtRest } from "./close-at-rest.ts";
import { FakeAgentControl, type FakeSession } from "./fake-agent.ts";
import { RuntimeTestLayer, waitFor } from "./test-harness.ts";
import { failureText, requestHost, unavailableError } from "./thread-error.ts";
import { RETRY_DEADLINE, retryFacts, ThreadRuntimes } from "./thread-runtimes.ts";

const createRunning = (text = "one") =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    const fake = yield* FakeAgentControl;
    const thread = yield* runtimes.create({
      projectRoot: "/work/repo",
      checkout: { kind: "main", path: "/work/repo" },
      input: { text },
    });
    const session = yield* waitFor(
      "the first send",
      fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
    );
    yield* waitStatus(thread.id, "running");
    return { thread, session };
  });

/** `ThreadPorts` whose fresh scan finds `busy` running a terminal command. */
const ports = (busy: ReadonlyArray<ThreadId> | undefined) => ({
  busyTerminalsNow: Effect.succeed(busy),
});

const waitStatus = (threadId: ThreadId, status: string) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    return yield* waitFor(
      `status ${status}`,
      runtimes.status(threadId).pipe(Effect.map((s) => s === status)),
    );
  });

/** Collects every `notify` event published from now on. */
const collectNotices = Effect.gen(function* () {
  const hub = yield* EventHub;
  const notices: Array<ServerEvent> = [];
  yield* Effect.forkScoped(
    Stream.runForEach(
      hub.serverEvents(Effect.succeed({ type: "threads.snapshot", threads: [] })),
      (event) =>
        Effect.sync(() => {
          if (event.type === "notify") notices.push(event);
        }),
    ),
  );
  return notices;
});

/**
 * A source thread with one finished turn, and a fork of it stored as if its session had opened and
 * been evicted before its first message.
 */
const unusedFork = Effect.gen(function* () {
  const runtimes = yield* ThreadRuntimes;
  const store = yield* ThreadStore;
  const { thread: source, session } = yield* createRunning();
  yield* session.completeTurn();
  yield* waitStatus(source.id, "idle");
  const plan = yield* runtimes.forkTarget(source.id, undefined);
  const fork = yield* runtimes.fork(plan, { checkout: { kind: "worktree", path: "/work/fork" } });
  yield* store.updateThread(fork.id, (t) => ({
    ...t,
    agentSessionId: "fork-session",
    agentSessionUnused: true,
  }));
  return { source: session, plan, fork };
});

const forkSession = (fake: FakeAgentControl["Service"], threadId: ThreadId) =>
  Effect.sync(() => fake.sessions.find((s) => s.options.threadId === threadId) ?? false);

/** What the session-policy test's port answers for a thread in `path`. */
const policy = (path: string) => ({
  audience: "orchestrator",
  instructions: `role prompt in ${path}`,
  outwardGate: "irreversible",
  mcpAllowlist: ["teams", "https://mcp.example.test/notes"],
  mcpNoneWithoutToolSearch: true,
});

/** A Bash approval card as an agent raises one. */
const pushApproval = (id: string) => ({
  type: "request" as const,
  request: {
    kind: "approval" as const,
    id: id as RequestId,
    toolName: "Bash",
    displayName: "Bash",
    input: { command: "git push" },
    suggestions: [],
  },
});

/** An 8 MB text part, so that every save of the message after it is slow, then `parts` tool calls. */
const bigReply = (
  session: FakeSession,
  messageId: MessageId,
  parts: number,
  metadata?: Record<string, unknown>,
) => {
  const chunk = (c: GramUIMessageChunk) => ({
    type: "chunk" as const,
    messageId,
    chunk: c,
  });
  return Effect.gen(function* () {
    yield* session.emit(
      chunk({
        type: "start",
        ...(metadata === undefined ? {} : { messageMetadata: metadata }),
      } as GramUIMessageChunk),
      chunk({ type: "text-start", id: "t" }),
      chunk({ type: "text-delta", id: "t", delta: "x".repeat(8 * 1024 * 1024) }),
      chunk({ type: "text-end", id: "t" }),
    );
    for (let i = 0; i < parts; i++) {
      yield* session.emit(
        chunk({ type: "tool-input-available", toolCallId: `c${i}`, toolName: "Read", input: {} }),
        chunk({ type: "tool-output-available", toolCallId: `c${i}`, output: "ok" }),
      );
    }
    return chunk;
  });
};

describe("ThreadRuntimes", () => {
  it.effect("counts foreground subagent progress without tracking its tools as parent tools", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const { thread, session } = yield* createRunning();
      const emit = (...events: AgentEvent[]) =>
        Effect.gen(function* () {
          const before = (yield* runtimes.replay(thread.id)).lastSeq;
          yield* session.emit(...events);
          yield* waitFor(
            "delegated chunks",
            runtimes
              .replay(thread.id)
              .pipe(Effect.map((replay) => replay.lastSeq >= before + events.length)),
          );
        });
      const main = "delegating" as MessageId;
      const nested = "foreground" as MessageId;
      yield* emit(
        { type: "chunk", messageId: main, chunk: { type: "start", messageId: main } },
        {
          type: "chunk",
          messageId: main,
          chunk: {
            type: "tool-input-available",
            toolName: "Agent",
            toolCallId: "delegate",
            input: {},
          },
        },
        {
          type: "chunk",
          messageId: nested,
          chunk: {
            type: "start",
            messageId: nested,
            messageMetadata: { parentToolUseId: "delegate" },
          },
        },
      );
      yield* TestClock.adjust("9 minutes");
      yield* emit({
        type: "chunk",
        messageId: nested,
        chunk: { type: "text-start", id: "answer" },
      });
      yield* TestClock.adjust("9 minutes");
      expect(yield* runtimes.quiet(thread.id)).toBeUndefined();
      yield* emit({
        type: "chunk",
        messageId: nested,
        chunk: {
          type: "tool-input-available",
          toolName: "Bash",
          toolCallId: "nested-command",
          input: {},
        },
      });
      yield* TestClock.adjust("9 minutes");
      expect(yield* runtimes.quiet(thread.id)).toBeUndefined();
      yield* emit({
        type: "chunk",
        messageId: main,
        chunk: { type: "tool-output-available", toolCallId: "delegate", output: "done" },
      });
      // The nested command is still open, but the parent's foreground call has completed.
      yield* TestClock.adjust("11 minutes");
      expect(yield* runtimes.quiet(thread.id)).toBeUndefined();
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("excludes background and earlier-turn subagents from a current silent tool", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const { thread, session } = yield* createRunning();
      const emit = (...events: AgentEvent[]) =>
        Effect.gen(function* () {
          const before = (yield* runtimes.replay(thread.id)).lastSeq;
          yield* session.emit(...events);
          yield* waitFor(
            "background chunks",
            runtimes
              .replay(thread.id)
              .pipe(Effect.map((replay) => replay.lastSeq >= before + events.length)),
          );
        });
      const main = "first" as MessageId;
      const old = "old-subagent" as MessageId;
      yield* emit(
        { type: "chunk", messageId: main, chunk: { type: "start", messageId: main } },
        {
          type: "chunk",
          messageId: main,
          chunk: {
            type: "tool-input-available",
            toolName: "Task",
            toolCallId: "old-task",
            input: {},
          },
        },
        {
          type: "chunk",
          messageId: old,
          chunk: {
            type: "start",
            messageId: old,
            messageMetadata: { parentToolUseId: "old-task" },
          },
        },
      );
      yield* session.completeTurn();
      yield* waitStatus(thread.id, "idle");
      yield* runtimes.send(thread.id, { text: "continue" });
      yield* waitStatus(thread.id, "running");
      const next = "next" as MessageId;
      const background = "background-subagent" as MessageId;
      yield* emit(
        { type: "chunk", messageId: next, chunk: { type: "start", messageId: next } },
        {
          type: "chunk",
          messageId: next,
          chunk: {
            type: "tool-input-available",
            toolName: "Task",
            toolCallId: "background-task",
            input: {},
          },
        },
        {
          type: "chunk",
          messageId: background,
          chunk: {
            type: "start",
            messageId: background,
            messageMetadata: { parentToolUseId: "background-task" },
          },
        },
        {
          type: "chunk",
          messageId: next,
          chunk: {
            type: "tool-input-available",
            toolName: "Bash",
            toolCallId: "silent-command",
            input: {},
          },
        },
      );
      yield* session.emit({
        type: "backgroundTasks",
        tasks: [
          {
            taskId: "bg",
            kind: "subagent",
            description: "background",
            toolCallId: "background-task",
            startedAt: 0,
          },
        ],
      });
      yield* waitFor(
        "background task listed",
        runtimes.snapshot.pipe(
          Effect.map((rows) =>
            rows.some((row) => row.thread.id === thread.id && row.background?.length === 1),
          ),
        ),
      );
      yield* TestClock.adjust("9 minutes");
      yield* emit(
        { type: "chunk", messageId: old, chunk: { type: "text-start", id: "old-text" } },
        { type: "chunk", messageId: background, chunk: { type: "text-start", id: "bg-text" } },
      );
      yield* TestClock.adjust("1 minute");
      yield* waitFor(
        "silent parent despite background progress",
        runtimes.quiet(thread.id).pipe(Effect.map((quiet) => quiet !== undefined)),
      );
      expect(yield* runtimes.quiet(thread.id)).toMatchObject({
        kind: "toolStalled",
        lastTool: "Bash",
      });
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("flags a silent running tool once and clears the flag on progress and turn end", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const { thread, session } = yield* createRunning();
      const quiet: unknown[] = [];
      yield* runtimes.observe({
        onQuiet: (_thread, condition) => Effect.sync(() => void quiet.push(condition)),
      });
      const messageId = "tool-reply" as MessageId;
      yield* session.emit({ type: "chunk", messageId, chunk: { type: "start", messageId } });
      yield* session.emit({
        type: "chunk",
        messageId,
        chunk: {
          type: "tool-input-available",
          toolName: "Bash",
          toolCallId: "tool-1",
          input: { command: "long command" },
        },
      });
      yield* waitFor(
        "tool activity",
        runtimes.snapshot.pipe(
          Effect.map((rows) =>
            rows.some((s) => s.thread.id === thread.id && s.activity !== undefined),
          ),
        ),
      );
      yield* TestClock.adjust("9 minutes");
      expect(yield* runtimes.quiet(thread.id)).toBeUndefined();
      yield* TestClock.adjust("1 minute");
      yield* waitFor(
        "silent tool notice",
        Effect.sync(() => quiet.length === 1),
      );
      expect(yield* runtimes.quiet(thread.id)).toMatchObject({
        kind: "toolStalled",
        lastTool: "Bash",
      });
      yield* TestClock.adjust("10 minutes");
      expect(quiet).toHaveLength(1);
      yield* session.emit({
        type: "chunk",
        messageId,
        chunk: { type: "tool-output-available", toolCallId: "tool-1", output: "finished" },
      });
      yield* waitFor(
        "tool progress",
        runtimes.quiet(thread.id).pipe(Effect.map((q) => q === undefined)),
      );
      yield* waitFor(
        "quiet clear callback",
        Effect.sync(() => quiet.length === 2),
      );
      expect(quiet[1]).toBeUndefined();
      yield* TestClock.adjust("10 minutes");
      expect(quiet).toHaveLength(2);
      yield* session.emit({
        type: "chunk",
        messageId,
        chunk: {
          type: "tool-input-available",
          toolName: "Bash",
          toolCallId: "tool-2",
          input: { command: "another long command" },
        },
      });
      yield* waitFor(
        "second tool progress",
        runtimes.snapshot.pipe(
          Effect.map((rows) =>
            rows.some((s) => s.thread.id === thread.id && s.activity !== undefined),
          ),
        ),
      );
      yield* TestClock.adjust("11 minutes");
      yield* waitFor(
        "second silent tool",
        Effect.sync(() => quiet.length === 3),
      );
      yield* session.completeTurn();
      yield* waitStatus(thread.id, "idle");
      expect(yield* runtimes.quiet(thread.id)).toBeUndefined();
      yield* waitFor(
        "turn end quiet callback",
        Effect.sync(() => quiet.length === 4),
      );
      expect(quiet[3]).toBeUndefined();
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );
  it.effect("opens a session, sends the first prompt after identity, and persists the turn", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const { thread, session } = yield* createRunning("fix the flaky test");
      expect(thread.title).toBe("fix the flaky test");
      expect(session.options.resumeId).toBeUndefined();

      yield* session.completeTurn("fixed");
      yield* waitStatus(thread.id, "idle");

      const stored = yield* store.getThread(thread.id);
      expect(stored.agentSessionId).toBe(session.agentSessionId);
      const messages = yield* store.listMessages(thread.id);
      expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
      expect(messages[1]?.parts).toEqual([{ type: "text", text: "fixed", state: "done" }]);
      const turns = yield* store.listTurns(thread.id);
      expect(turns).toMatchObject([{ reason: "completed" }]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("queues sends while running and sends the next one only after idle", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const { thread, session } = yield* createRunning();

      expect(yield* runtimes.send(thread.id, { text: "two" })).toEqual({ queued: true });
      expect(yield* runtimes.send(thread.id, { text: "three" })).toEqual({ queued: true });
      const [summary] = yield* runtimes.snapshot;
      expect(summary?.queue.map((q) => q.input.text)).toEqual(["two", "three"]);
      expect(session.sent).toHaveLength(1);

      yield* session.completeTurn();
      yield* waitFor(
        "the second send",
        Effect.sync(() => session.sent.length === 2),
      );
      // The trailing `status idle` of the first turn must not release "three" early.
      for (let i = 0; i < 50; i++) yield* Effect.yieldNow;
      expect(session.sent.map((i) => i.text)).toEqual(["one", "two"]);
      expect(yield* runtimes.status(thread.id)).toBe("running");

      yield* session.completeTurn();
      yield* waitFor(
        "the third send",
        Effect.sync(() => session.sent.length === 3),
      );
      yield* session.completeTurn();
      yield* waitStatus(thread.id, "idle");
      const [after] = yield* runtimes.snapshot;
      expect(after?.queue).toEqual([]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("rejects steer between turns and forwards it mid-turn", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const { thread, session } = yield* createRunning();
      yield* runtimes.steer(thread.id, { text: "use vitest" });
      expect(session.steered.map((i) => i.text)).toEqual(["use vitest"]);

      // The transcript records it, so the steer isn't invisible after the fact.
      const steered = (yield* store.listMessages(thread.id)).filter((m) => m.role === "user");
      expect(
        steered.map((m) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : []))),
      ).toEqual([["one"], ["use vitest"]]);
      expect(steered.at(-1)?.metadata?.turnId).toBe(steered[0]?.metadata?.turnId);

      yield* session.completeTurn();
      yield* waitStatus(thread.id, "idle");
      const error = yield* runtimes.steer(thread.id, { text: "late" }).pipe(Effect.flip);
      expect(error).toBeInstanceOf(InvalidState);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("answers a steer the agent refuses with InvalidState, recording nothing", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const fake = yield* FakeAgentControl;
      const { thread, session } = yield* createRunning();
      yield* fake.setSteerFails(true);
      // Callers that queue on InvalidState (a worker's message, the user's to an orchestrator)
      // keep the input this way; nothing reaches the transcript twice.
      const error = yield* runtimes.steer(thread.id, { text: "refused" }).pipe(Effect.flip);
      expect(error).toBeInstanceOf(InvalidState);
      const users = (yield* store.listMessages(thread.id)).filter((m) => m.role === "user");
      expect(
        users.flatMap((m) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : []))),
      ).toEqual(["one"]);
      expect(session.steered).toEqual([]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("publishes a cross-thread steer once, with its origin part", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const { thread } = yield* createRunning();
      yield* runtimes.steer(thread.id, {
        text: "from over here",
        origin: { threadId: "other" as ThreadId, title: "Other", depth: 1 },
      });
      const user = (yield* store.listMessages(thread.id)).filter(
        (m) =>
          m.role === "user" &&
          m.parts.some((p) => p.type === "text" && p.text === "from over here"),
      );
      expect(user).toHaveLength(1);
      expect(user[0]?.parts.some((p) => p.type === "data-thread-origin")).toBe(true);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("evicts an idle session after N minutes and resumes it on the next send", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      yield* fake.setResumeNeedsTranscript(true);
      const { thread, session } = yield* createRunning();
      yield* session.completeTurn();
      yield* waitStatus(thread.id, "idle");

      yield* TestClock.adjust("14 minutes");
      for (let i = 0; i < 50; i++) yield* Effect.yieldNow;
      expect(session.closed).toBe(false);

      yield* TestClock.adjust("1 minute");
      yield* waitStatus(thread.id, "cold");
      expect(session.closed).toBe(true);

      expect(yield* runtimes.send(thread.id, { text: "again" })).toEqual({ queued: false });
      const resumed = yield* waitFor(
        "the resumed session",
        Effect.sync(() => fake.sessions.length === 2 && fake.sessions[1]),
      );
      expect(resumed.options.resumeId).toBe(session.agentSessionId);
      yield* waitFor(
        "the resumed send",
        Effect.sync(() => resumed.sent.length === 1),
      );
      expect(resumed.sent[0]?.text).toBe("again");
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("opens an evicted session that never had a turn fresh, under the same id", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const fake = yield* FakeAgentControl;
      yield* fake.setResumeNeedsTranscript(true);
      const thread = yield* runtimes.create({
        projectRoot: "/work/repo",
        checkout: { kind: "main", path: "/work/repo" },
      });
      yield* waitStatus(thread.id, "idle");
      const warm = yield* fake.latest(thread.id);
      expect((yield* store.getThread(thread.id)).agentSessionUnused).toBe(true);

      yield* TestClock.adjust("15 minutes");
      yield* waitStatus(thread.id, "cold");
      expect(warm.closed).toBe(true);

      expect(yield* runtimes.send(thread.id, { text: "hello" })).toEqual({ queued: false });
      const reopened = yield* waitFor(
        "the fresh session's send",
        Effect.sync(() => fake.sessions.length === 2 && fake.sessions[1]!.sent.length === 1),
      ).pipe(Effect.as(fake.sessions[1]!));
      expect(reopened.options.resumeId).toBeUndefined();
      expect(reopened.options.sessionId).toBe(warm.agentSessionId);
      expect(reopened.agentSessionId).toBe(warm.agentSessionId);
      expect((yield* store.getThread(thread.id)).agentSessionUnused).toBeUndefined();

      yield* reopened.completeTurn();
      yield* waitStatus(thread.id, "idle");
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("reopens an unused fork by re-forking its source, under the fork's own id", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const fake = yield* FakeAgentControl;
      const { source, plan, fork } = yield* unusedFork;

      yield* runtimes.send(fork.id, { text: "carry on" });
      const reopened = yield* waitFor("the fork's session", forkSession(fake, fork.id));
      expect(reopened.options).toMatchObject({
        resumeId: source.agentSessionId,
        fork: true,
        resumeAt: plan.resumeAt,
        sessionId: "fork-session",
      });
      yield* waitFor(
        "the fork's send",
        Effect.sync(() => reopened.sent.length === 1),
      );
      const stored = yield* store.getThread(fork.id);
      expect(stored.agentSessionId).toBe("fork-session");
      expect(stored.agentSessionUnused).toBeUndefined();
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("re-forks at the copied anchor after a first send that couldn't start", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      const { source, plan, fork } = yield* unusedFork;
      yield* fake.setUnavailable("claude is not installed");
      yield* runtimes.send(fork.id, { text: "carry on" });
      yield* waitStatus(fork.id, "error");

      // Taken back, the unsent message leaves nothing behind for the next open to anchor on.
      const [queued] = (yield* runtimes.snapshot).flatMap((s) =>
        s.thread.id === fork.id ? s.queue : [],
      );
      yield* runtimes.removeQueued(fork.id, queued!.id);
      yield* fake.setUnavailable(undefined);
      yield* runtimes.send(fork.id, { text: "something else" });
      const reopened = yield* waitFor("the fork's session", forkSession(fake, fork.id));
      expect(reopened.options).toMatchObject({
        resumeId: source.agentSessionId,
        fork: true,
        resumeAt: plan.resumeAt,
      });
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect(
    "re-forks at the copied anchor when a model switch reopens the fork's first session",
    () =>
      Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const fake = yield* FakeAgentControl;
        const { source, plan, fork } = yield* unusedFork;
        yield* fake.setOpenDelay("300 millis");
        yield* runtimes.send(fork.id, { text: "carry on" });
        // Switched while the session opens: it reopens on the new model before taking the launch.
        yield* runtimes.setModel(fork.id, { ...fork.model, model: "reopen:eu" });
        yield* fake.setOpenDelay(undefined);
        yield* TestClock.adjust("400 millis");
        const reopened = yield* waitFor(
          "the fork reopened on the switched model",
          Effect.sync(
            () =>
              fake.sessions.find(
                (s) => s.options.threadId === fork.id && s.options.model?.model === "reopen:eu",
              ) ?? false,
          ),
        );
        expect(reopened.options).toMatchObject({
          resumeId: source.agentSessionId,
          fork: true,
          resumeAt: plan.resumeAt,
        });
        yield* waitFor(
          "the launch",
          Effect.sync(() => reopened.sent.length === 1),
        );
        expect(reopened.sent.map((i) => i.text)).toEqual(["carry on"]);
      }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("rewinds an unused fork by re-forking its source at the rewind point", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const fake = yield* FakeAgentControl;
      const { source, fork } = yield* unusedFork;
      const copied = (yield* store.listMessages(fork.id)).at(-1)!;

      yield* runtimes.rewind(fork.id, {
        messageId: copied.id,
        role: "assistant",
        turnId: undefined,
        cwd: "/work/fork",
        resumeAt: "sdk-anchor",
      });
      const reopened = yield* waitFor("the rewound fork's session", forkSession(fake, fork.id));
      expect(reopened.options).toMatchObject({
        resumeId: source.agentSessionId,
        fork: true,
        resumeAt: "sdk-anchor",
        sessionId: "fork-session",
      });
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("records a mode only once the live session takes it", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const fake = yield* FakeAgentControl;
      const { thread, session } = yield* createRunning();
      yield* fake.setRefusedModes(["bypassPermissions"]);

      const refused = yield* Effect.flip(runtimes.setMode(thread.id, "bypassPermissions"));
      expect(refused).toBeInstanceOf(InvalidState);
      expect(refused.message).toContain("bypassPermissions is disabled");
      expect((yield* store.getThread(thread.id)).mode).toBe(thread.mode);

      yield* runtimes.setMode(thread.id, "acceptEdits");
      expect(session.modes).toEqual(["acceptEdits"]);
      expect((yield* store.getThread(thread.id)).mode).toBe("acceptEdits");
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("applies two quick mode picks in order, agent and store alike", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const fake = yield* FakeAgentControl;
      const { thread, session } = yield* createRunning();
      yield* fake.setModeDelay("plan", "1 second");

      const slow = yield* Effect.forkScoped(runtimes.setMode(thread.id, "plan"));
      for (let i = 0; i < 50; i++) yield* Effect.yieldNow;
      const quick = yield* Effect.forkScoped(runtimes.setMode(thread.id, "acceptEdits"));
      for (let i = 0; i < 50; i++) yield* Effect.yieldNow;
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(slow);
      yield* Fiber.join(quick);

      expect(session.modes).toEqual(["plan", "acceptEdits"]);
      expect((yield* store.getThread(thread.id)).mode).toBe("acceptEdits");
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("opens an evicted session in the mode picked while it was cold", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      const { thread, session } = yield* createRunning();
      yield* session.completeTurn();
      yield* waitStatus(thread.id, "idle");
      yield* TestClock.adjust("15 minutes");
      yield* waitStatus(thread.id, "cold");

      yield* runtimes.setMode(thread.id, "bypassPermissions");
      yield* runtimes.send(thread.id, { text: "again" });
      const resumed = yield* waitFor(
        "the resumed session",
        Effect.sync(() => fake.sessions.length === 2 && fake.sessions[1]),
      );
      expect(resumed.options.permissionMode).toBe("bypassPermissions");
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("never evicts a pinned thread", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const { thread, session } = yield* createRunning();
      yield* runtimes.updateThread(thread.id, (t) => ({ ...t, pinned: true }));
      yield* session.completeTurn();
      yield* waitStatus(thread.id, "idle");

      yield* TestClock.adjust("2 hours");
      for (let i = 0; i < 50; i++) yield* Effect.yieldNow;
      expect(session.closed).toBe(false);
      expect(yield* runtimes.status(thread.id)).toBe("idle");
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("tells the user when a thread with a conversation continues in a fresh session", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      yield* fake.setResumeNeedsTranscript(true);
      const notices = yield* collectNotices;
      const { thread, session } = yield* createRunning();
      yield* session.completeTurn();
      yield* waitStatus(thread.id, "idle");
      yield* TestClock.adjust("15 minutes");
      yield* waitStatus(thread.id, "cold");

      // As when Claude Code cleans up an old transcript.
      yield* fake.forgetTranscript(session.agentSessionId);
      yield* runtimes.send(thread.id, { text: "again" });
      const fresh = yield* waitFor(
        "the fresh session's send",
        Effect.sync(
          () =>
            fake.sessions.length === 2 && fake.sessions[1]!.sent.length === 1 && fake.sessions[1],
        ),
      );
      expect(fresh.options.resumeId).toBeUndefined();
      expect(fresh.options.sessionId).toBe(session.agentSessionId);
      yield* waitFor(
        "the notice",
        Effect.sync(() => notices.length > 0),
      );
      expect(notices).toEqual([
        {
          type: "notify",
          kind: "info",
          title:
            "The previous Claude conversation couldn't be found, so this thread continues in a fresh session.",
          threadId: thread.id,
        },
      ]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("doesn't retry a session that fails to open for another reason", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const fake = yield* FakeAgentControl;
      const { thread, session } = yield* createRunning();
      yield* session.completeTurn();
      yield* waitStatus(thread.id, "idle");
      yield* TestClock.adjust("15 minutes");
      yield* waitStatus(thread.id, "cold");

      yield* fake.setUnavailable("Claude Code didn't start");
      yield* runtimes.send(thread.id, { text: "again" });
      yield* waitStatus(thread.id, "error");
      expect(fake.sessions).toHaveLength(1);
      expect((yield* store.getThread(thread.id)).agentSessionUnused).toBeUndefined();
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("between turns, Stop reaches the background tasks an interrupt can't", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const { thread, session } = yield* createRunning();

      // A turn is running: that is an interrupt, which already takes its background tasks with it.
      yield* runtimes.interrupt(thread.id);
      yield* waitStatus(thread.id, "idle");
      expect(session.interrupts).toBe(1);
      expect(session.backgroundStops).toBe(0);

      // No turn now, so there is nothing to interrupt, but a background subagent may be working.
      yield* runtimes.interrupt(thread.id);
      expect(session.interrupts).toBe(1);
      expect(session.backgroundStops).toBe(1);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("interrupts a running turn without recovery when the agent complies", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const fake = yield* FakeAgentControl;
      const { thread, session } = yield* createRunning();

      yield* runtimes.interrupt(thread.id);
      yield* waitStatus(thread.id, "idle");
      expect(session.interrupts).toBe(1);
      expect(fake.sessions).toHaveLength(1);
      expect(yield* store.listTurns(thread.id)).toMatchObject([{ reason: "interrupted" }]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("recovers a hung interrupt after 5 s by closing and resuming the session", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const fake = yield* FakeAgentControl;
      yield* fake.setInterruptBehavior("hang");
      const { thread, session } = yield* createRunning();

      const interrupting = yield* Effect.forkScoped(runtimes.interrupt(thread.id));
      yield* waitFor(
        "the interrupt call",
        Effect.sync(() => session.interrupts === 1),
      );
      yield* TestClock.adjust("4 seconds");
      for (let i = 0; i < 50; i++) yield* Effect.yieldNow;
      expect(fake.sessions).toHaveLength(1);

      yield* TestClock.adjust("1 second");
      yield* Fiber.join(interrupting);
      expect(session.closed).toBe(true);
      const resumed = yield* waitFor(
        "the resumed session",
        Effect.sync(() => fake.sessions.length === 2 && fake.sessions[1]),
      );
      expect(resumed.options.resumeId).toBe(session.agentSessionId);
      yield* waitStatus(thread.id, "idle");
      expect(yield* store.listTurns(thread.id)).toMatchObject([{ reason: "interrupted" }]);

      // The resumed session takes the next prompt.
      yield* runtimes.send(thread.id, { text: "carry on" });
      yield* waitFor(
        "the send after recovery",
        Effect.sync(() => resumed.sent.length === 1),
      );
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("finishes a recovery whose caller went away while the session closed", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      yield* fake.setInterruptBehavior("hang");
      yield* fake.setCloseDelay("1 second");
      const { thread, session } = yield* createRunning();
      yield* fake.setCloseDelay(undefined);

      const interrupting = yield* Effect.forkScoped(runtimes.interrupt(thread.id));
      yield* waitFor(
        "the interrupt call",
        Effect.sync(() => session.interrupts === 1),
      );
      yield* TestClock.adjust("5 seconds");
      yield* waitFor(
        "the session to start closing",
        Effect.sync(() => session.closing),
      );
      // The RPC fiber goes, as when the client disconnects.
      yield* Fiber.interrupt(interrupting);
      yield* TestClock.adjust("1 second");

      const resumed = yield* waitFor(
        "the resumed session",
        Effect.sync(() => fake.sessions.length === 2 && fake.sessions[1]),
      );
      yield* waitStatus(thread.id, "idle");
      yield* runtimes.send(thread.id, { text: "carry on" });
      yield* waitFor(
        "the send after recovery",
        Effect.sync(() => resumed.sent.length === 1),
      );
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect(
    "refuses a close only at rest for a working thread, stopping nothing, and not an idle one",
    () =>
      Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const store = yield* ThreadStore;
        const { thread, session } = yield* createRunning();
        const refused = yield* runtimes.close(thread.id, { onlyAtRest: true }).pipe(Effect.flip);
        expect(refused).toMatchObject({ _tag: "InvalidState" });
        expect(session.closing).toBe(false);
        expect(yield* runtimes.status(thread.id)).toBe("running");
        // Not left marked as closing: it still takes messages.
        expect((yield* runtimes.send(thread.id, { text: "two" })).queued).toBe(true);

        const idle = yield* runtimes.create({
          projectRoot: "/work/repo",
          checkout: { kind: "main", path: "/work/other" },
        });
        yield* waitStatus(idle.id, "idle");
        // A terminal running a command, or terminals nobody could read, hold it open too. The
        // terminal gate is held around every attempt and let go whether it closed or not.
        const gated: string[] = [];
        const gate = {
          hold: (threadId: ThreadId) =>
            Effect.sync(() => {
              gated.push(`hold ${threadId}`);
              return Effect.sync(() => void gated.push(`release ${threadId}`));
            }),
        };
        for (const busy of [[idle.id], undefined]) {
          const held = yield* closeAtRest(runtimes, ports(busy), gate, idle.id).pipe(Effect.flip);
          expect(held).toMatchObject({ _tag: "InvalidState" });
        }
        expect(yield* runtimes.status(idle.id)).toBe("idle");
        yield* closeAtRest(runtimes, ports([thread.id]), gate, idle.id);
        expect(gated).toEqual(
          Array.from({ length: 3 }, () => [`hold ${idle.id}`, `release ${idle.id}`]).flat(),
        );
        expect(yield* store.getThread(idle.id).pipe(Effect.flip)).toMatchObject({
          _tag: "ThreadNotFound",
        });
      }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect(
    "runs work reserved on a cold thread, turning sends away until it ends, and only then",
    () =>
      Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const { thread } = yield* createRunning();
        const busy = yield* runtimes.whileAtRest(thread.id, Effect.void).pipe(Effect.flip);
        expect(busy).toMatchObject({ _tag: "InvalidState" });

        // Idle with a live session is an agent that could start something itself: only cold will do.
        const idle = yield* runtimes.create({
          projectRoot: "/work/repo",
          checkout: { kind: "main", path: "/work/other" },
        });
        yield* waitStatus(idle.id, "idle");
        const live = yield* runtimes.whileAtRest(idle.id, Effect.void).pipe(Effect.flip);
        expect(live).toMatchObject({ _tag: "InvalidState" });

        const cold = yield* runtimes.create({
          projectRoot: "/work/repo",
          checkout: { kind: "main", path: "/work/cold" },
          deferOpen: true,
        });
        const during = yield* runtimes.whileAtRest(
          cold.id,
          Effect.all([
            runtimes.send(cold.id, { text: "now?" }).pipe(Effect.flip),
            // A rewind would reopen the session under the work: refused before any files move.
            runtimes.rewindTarget(cold.id, "m-1").pipe(Effect.flip),
          ]),
        );
        expect(during).toMatchObject([{ _tag: "InvalidState" }, { _tag: "InvalidState" }]);
        expect(yield* runtimes.status(cold.id)).toBe("cold");
        yield* runtimes.send(cold.id, { text: "now" });
      }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect(
    "refuses a close or reserved work once the thread left the checked checkout or changed",
    () =>
      Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const store = yield* ThreadStore;
        const idle = yield* runtimes.create({
          projectRoot: "/work/repo",
          checkout: { kind: "main", path: "/work/other" },
        });
        yield* waitStatus(idle.id, "idle");
        const moved = yield* runtimes
          .close(idle.id, { expectedCheckout: "/work/elsewhere" })
          .pipe(Effect.flip);
        expect(moved).toMatchObject({ _tag: "InvalidState" });
        expect((yield* store.getThread(idle.id)).id).toBe(idle.id);
        const cold = yield* runtimes.create({
          projectRoot: "/work/repo",
          checkout: { kind: "main", path: "/work/cold" },
          deferOpen: true,
        });
        const reserved = yield* runtimes
          .whileAtRest(cold.id, Effect.succeed("ran"), { expectedCheckout: "/work/elsewhere" })
          .pipe(Effect.flip);
        expect(reserved).toMatchObject({ _tag: "InvalidState" });
        const unchanged = yield* runtimes
          .close(idle.id, { expectedCheckout: "/work/other", stillHolds: () => false })
          .pipe(Effect.flip);
        expect(unchanged).toMatchObject({ _tag: "InvalidState" });
        expect(
          yield* runtimes.whileAtRest(cold.id, Effect.succeed("ran"), {
            expectedCheckout: "/work/cold",
            stillHolds: (now) => now.id === cold.id,
          }),
        ).toBe("ran");
        yield* runtimes.close(idle.id, { expectedCheckout: "/work/other" });
      }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("never reopens a session for a thread closed while it recovered", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      yield* fake.setInterruptBehavior("hang");
      yield* fake.setCloseDelay("1 second");
      const { thread, session } = yield* createRunning();
      yield* fake.setCloseDelay(undefined);

      const interrupting = yield* Effect.forkScoped(runtimes.interrupt(thread.id));
      yield* waitFor(
        "the interrupt call",
        Effect.sync(() => session.interrupts === 1),
      );
      yield* TestClock.adjust("5 seconds");
      yield* waitFor(
        "the session to start closing",
        Effect.sync(() => session.closing),
      );
      const closing = yield* Effect.forkScoped(runtimes.close(thread.id));
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(closing);
      yield* Fiber.join(interrupting);
      for (let i = 0; i < 50; i++) yield* Effect.yieldNow;
      expect(fake.sessions).toHaveLength(1);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("never reopens a session when the watchdog fires while the thread closes", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      yield* fake.setInterruptBehavior("hang");
      yield* fake.setCloseDelay("2 seconds");
      const { thread, session } = yield* createRunning();
      yield* fake.setCloseDelay(undefined);

      const interrupting = yield* Effect.forkScoped(runtimes.interrupt(thread.id));
      yield* waitFor(
        "the interrupt call",
        Effect.sync(() => session.interrupts === 1),
      );
      yield* TestClock.adjust("4 seconds");
      const closing = yield* Effect.forkScoped(runtimes.close(thread.id));
      yield* waitFor(
        "the session to start closing",
        Effect.sync(() => session.closing),
      );
      yield* TestClock.adjust("1 second");
      for (let i = 0; i < 50; i++) yield* Effect.yieldNow;
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(closing);
      yield* Fiber.join(interrupting);
      for (let i = 0; i < 50; i++) yield* Effect.yieldNow;
      expect(fake.sessions).toHaveLength(1);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("opens one session for two interrupts that both hang", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      yield* fake.setInterruptBehavior("hang");
      const { thread, session } = yield* createRunning();

      const first = yield* Effect.forkScoped(runtimes.interrupt(thread.id));
      const second = yield* Effect.forkScoped(runtimes.interrupt(thread.id));
      yield* waitFor(
        "both interrupt calls",
        Effect.sync(() => session.interrupts === 2),
      );
      yield* TestClock.adjust("5 seconds");
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      yield* waitStatus(thread.id, "idle");
      for (let i = 0; i < 50; i++) yield* Effect.yieldNow;
      expect(fake.sessions.map((s) => s.closed)).toEqual([true, false]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("persists pending approvals and forwards the answer", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const { thread, session } = yield* createRunning();
      const requestId = "req-1" as RequestId;
      yield* session.emit({
        type: "request",
        request: {
          kind: "approval",
          id: requestId,
          toolName: "Bash",
          displayName: "Bash",
          input: { command: "git push" },
          suggestions: [],
        },
      });
      yield* waitStatus(thread.id, "needsApproval");
      expect((yield* store.listRequests(thread.id)).map((r) => r.id)).toEqual([requestId]);
      const [summary] = yield* runtimes.snapshot;
      expect(summary?.pendingRequests).toHaveLength(1);
      // The turn is still open while it waits, so a quit would cut it off.
      expect(yield* runtimes.working).toHaveLength(1);

      const missing = yield* runtimes
        .respond(thread.id, "nope" as RequestId, {
          kind: "approval",
          decision: "deny",
          scope: "once",
        })
        .pipe(Effect.flip);
      expect(missing).toBeInstanceOf(RequestNotFound);

      yield* runtimes.respond(thread.id, requestId, {
        kind: "approval",
        decision: "allow",
        scope: "once",
      });
      expect(session.responses.map((r) => r.requestId)).toEqual([requestId]);
      expect(yield* store.listRequests(thread.id)).toEqual([]);
      expect(yield* runtimes.status(thread.id)).toBe("running");
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("answers several requests in one call, each failure in its own row", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const first = yield* createRunning();
      const second = yield* createRunning();
      yield* first.session.emit(pushApproval("req-a"));
      yield* second.session.emit(pushApproval("req-b"));
      yield* waitStatus(first.thread.id, "needsApproval");
      yield* waitStatus(second.thread.id, "needsApproval");
      const allow = { kind: "approval", decision: "allow", scope: "once" } as const;

      const results = yield* runtimes.respondMany([
        { threadId: first.thread.id, requestId: "req-a" as RequestId, answer: allow },
        { threadId: first.thread.id, requestId: "req-a" as RequestId, answer: allow },
        { threadId: "gone" as ThreadId, requestId: "req-x" as RequestId, answer: allow },
        { threadId: second.thread.id, requestId: "req-b" as RequestId, answer: allow },
      ]);
      expect(results).toEqual([
        { threadId: first.thread.id, requestId: "req-a", ok: true },
        {
          threadId: first.thread.id,
          requestId: "req-a",
          ok: false,
          error: "That request has already been answered.",
        },
        { threadId: "gone", requestId: "req-x", ok: false, error: "That thread is closed." },
        { threadId: second.thread.id, requestId: "req-b", ok: true },
      ]);
      // In order, and the failures in between stopped nothing.
      expect(first.session.responses.map((r) => r.requestId)).toEqual(["req-a"]);
      expect(second.session.responses.map((r) => r.requestId)).toEqual(["req-b"]);
      expect(yield* store.listRequests(second.thread.id)).toEqual([]);
      expect(yield* runtimes.respondMany([])).toEqual([]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("excludes the in-flight message from stored messages on replay", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const { thread, session } = yield* createRunning();
      const messageId = "reply" as MessageId;
      yield* session.emit(
        { type: "chunk", messageId, chunk: { type: "text-start", id: "t" } },
        { type: "chunk", messageId, chunk: { type: "text-delta", id: "t", delta: "par" } },
        { type: "chunk", messageId, chunk: { type: "text-end", id: "t" } },
        { type: "chunk", messageId, chunk: { type: "text-start", id: "u" } },
      );
      const replay = yield* waitFor(
        "the in-flight chunks",
        runtimes.replay(thread.id).pipe(Effect.map((r) => r.inFlight.length === 4 && r)),
      );
      // The completed text part was persisted, but it's replayed as chunks, not as a message.
      expect(replay.messages.map((m) => m.role)).toEqual(["user"]);
      // The user message took seq 1.
      expect(replay.lastSeq).toBe(5);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("marks the thread errored when the agent is unavailable, and logs only that", () => {
    const logged: Array<Record<string, unknown>> = [];
    const capture = Logger.make(({ message, fiber }) => {
      logged.push({ message, ...fiber.getRef(References.CurrentLogAnnotations) });
    });
    return Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      // A turn's error is the agent's own text: shown on the thread, and only its kind logged.
      const running = yield* createRunning();
      yield* running.session.emit({
        type: "turnEnd",
        reason: "error",
        error: "echo of what the user typed",
      });
      yield* waitStatus(running.thread.id, "error");
      expect(logged).toEqual([
        {
          message: ["turn failed"],
          threadId: running.thread.id,
          agent: "claude",
          kind: "unknown",
          httpStatus: "",
          code: "",
          retryable: true,
        },
      ]);
      logged.length = 0;

      yield* fake.setUnavailable("claude is not logged in");
      const thread = yield* runtimes.create({
        projectRoot: "/work/repo",
        checkout: { kind: "main", path: "/work/repo" },
      });
      yield* waitStatus(thread.id, "error");
      expect(logged).toEqual([
        {
          message: ["agent unavailable"],
          threadId: thread.id,
          agent: "claude",
          reason: "",
          unavailable: "claude is not logged in",
        },
      ]);
    }).pipe(Effect.provide(Layer.provideMerge(RuntimeTestLayer, Logger.layer([capture]))));
  });

  it.effect(
    "keeps a failed turn's error on the thread and in its reply, until a turn completes",
    () =>
      Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const store = yield* ThreadStore;
        const fake = yield* FakeAgentControl;
        const { thread, session } = yield* createRunning();
        const reply = "reply-failed" as MessageId;
        yield* session.emit(
          {
            type: "chunk",
            messageId: reply,
            chunk: {
              type: "start",
              messageId: reply,
              messageMetadata: { agentMessageIds: ["turn-a"] },
            },
          },
          { type: "chunk", messageId: reply, chunk: { type: "finish" } },
          {
            type: "turnEnd",
            reason: "error",
            error: "exceeded retry limit, last status: 429 Too Many Requests",
            failure: {
              kind: "gatewayRefused",
              httpStatus: 429,
              code: "responseTooManyFailedAttempts",
              retryable: false,
            },
          },
        );
        yield* waitStatus(thread.id, "error");
        const failed = yield* store.getThread(thread.id);
        const text =
          "Gateway refused the request: no deployment supports this request (HTTP 429). Sending it again won't help; try another model.";
        expect(failed.lastError).toMatchObject({
          kind: "gatewayRefused",
          httpStatus: 429,
          code: "responseTooManyFailedAttempts",
          retryable: false,
          text,
        });
        expect(failed.lastError?.turnId).toBeDefined();
        // In the turn's own reply, which keeps the anchor a fork or a rewind resolves against.
        const messages = yield* store.listMessages(thread.id);
        expect(messages.at(-1)).toMatchObject({
          id: reply,
          metadata: { agentMessageIds: ["turn-a"] },
          parts: [{ type: "data-agent-error", data: { kind: "gatewayRefused", text } }],
        });
        expect(yield* runtimes.forkTarget(thread.id, undefined)).toMatchObject({
          messageId: reply,
        });

        // The session ending after that turn, as Codex's does once it flushed it, keeps its error.
        yield* session.end({ type: "ended", reason: "exited" });
        yield* waitFor(
          "the session's end",
          store.getThread(thread.id).pipe(
            Effect.andThen(runtimes.status(thread.id)),
            Effect.map((s) => s === "error"),
          ),
        );
        for (let i = 0; i < 50; i++) yield* Effect.yieldNow;
        expect((yield* store.getThread(thread.id)).lastError).toMatchObject({
          kind: "gatewayRefused",
          at: failed.lastError!.at,
        });

        yield* runtimes.send(thread.id, { text: "again" });
        const next = yield* waitFor(
          "the reopened session",
          fake.latest(thread.id).pipe(Effect.map((s) => s !== session && s.sent.length === 1 && s)),
        );
        yield* waitStatus(thread.id, "running");
        yield* next.completeTurn();
        yield* waitStatus(thread.id, "idle");
        expect((yield* store.getThread(thread.id)).lastError).toBeUndefined();
      }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("says a refused sign-in or key was refused, with its HTTP status", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const { thread, session } = yield* createRunning();
      yield* session.emit({
        type: "turnEnd",
        reason: "error",
        error: "401 invalid x-api-key",
        failure: { kind: "auth", httpStatus: 401, retryable: false },
      });
      yield* waitStatus(thread.id, "error");
      expect((yield* store.getThread(thread.id)).lastError?.text).toBe(
        "The agent's sign-in or key was refused (HTTP 401).",
      );
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("attributes authentication refusals to the selected provider or explicit gateway", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      yield* store.upsertProfile({ ...EXAMPLE_GATEWAY, keyRef: "profile:example", models: [] });
      // What Codex says when it went to OpenAI with no key: the request's URL rides on the message.
      const openai =
        "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses";
      const refused = (profileId: ProfileId | undefined, error: string) =>
        Effect.gen(function* () {
          const model: ModelRef = { agent: "codex", model: "gpt-6.1-sol" };
          const thread = yield* runtimes.create({
            projectRoot: "/work/repo",
            checkout: { kind: "main", path: "/work/repo" },
            model: profileId === undefined ? model : { ...model, profileId },
            input: { text: "one" },
          });
          const session = yield* waitFor(
            "the first send",
            fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
          );
          yield* waitStatus(thread.id, "running");
          yield* session.emit({
            type: "turnEnd",
            reason: "error",
            error,
            failure: { kind: "auth", httpStatus: 401, retryable: false },
          });
          yield* waitStatus(thread.id, "error");
          return (yield* store.getThread(thread.id)).lastError?.text ?? "";
        });
      const unbound = yield* refused(undefined, openai);
      expect(unbound).toBe("The agent's sign-in or key was refused (HTTP 401).");
      const misrouted = yield* refused(EXAMPLE_GATEWAY.id, openai);
      expect(misrouted).toContain(
        "Codex ran without the gateway: its request went to api.openai.com, not the thread's gateway",
      );
      // A refusal from the explicitly selected gateway directs the user to its own settings.
      const gatewayURL = `${EXAMPLE_GATEWAY.baseURL}/responses`;
      expect(yield* refused(EXAMPLE_GATEWAY.id, `unexpected status 401, url: ${gatewayURL}`)).toBe(
        "The gateway didn't accept the key (HTTP 401). Check it in Settings → Gateways.",
      );
      // A host matching a known gateway does not turn an unbound subscription thread into one.
      expect(yield* refused(undefined, `unexpected status 401, url: ${gatewayURL}`)).toBe(
        "The agent's sign-in or key was refused (HTTP 401).",
      );
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it("names the host a refused request went to, and nothing more of its URL", () => {
    expect(requestHost("401 Unauthorized, url: https://api.openai.com/v1/responses?key=x")).toBe(
      "api.openai.com",
    );
    expect(requestHost("url: https://user:secret@Gateway.Example:8443/v1")).toBe(
      "gateway.example:8443",
    );
    expect(requestHost("401 invalid x-api-key")).toBeUndefined();
    expect(requestHost("url: https://")).toBeUndefined();
    // On the desktop, a Codex thread with no profile runs on its own login: no gateway to blame.
    const failure = { kind: "auth", httpStatus: 401, retryable: false } as const;
    expect(
      failureText(failure, "url: https://api.openai.com/v1", { agent: "codex", gateway: false }),
    ).toBe("The agent's sign-in or key was refused (HTTP 401).");
  });

  it("keeps subscription login advice and startup error classification", () => {
    const signedOut = new AgentUnavailable({
      agent: "claude",
      reason: "not-logged-in",
      message: "Claude Code isn't logged in. Run `claude /login`.",
    });
    expect(unavailableError(signedOut, 1).text).toBe(
      "Claude couldn't start: Claude Code isn't logged in. Run `claude /login`.",
    );
    expect(unavailableError(signedOut, 1)).toMatchObject({ kind: "auth", retryable: false });
    const apiKey = new AgentUnavailable({
      agent: "claude",
      reason: "api-key-auth",
      message: "Claude Code is using API-key auth; Gram requires your subscription login.",
    });
    expect(unavailableError(apiKey, 1).text).toBe(`Claude couldn't start: ${apiKey.message}`);
    const missing = new AgentUnavailable({ agent: "codex", message: "codex isn't installed." });
    expect(unavailableError(missing, 1).text).toBe("Codex couldn't start: codex isn't installed.");
  });

  it.effect("records a session that ends mid-turn as that turn's failure", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const { thread, session } = yield* createRunning();
      yield* session.end({ type: "ended", reason: "exited" });
      yield* waitStatus(thread.id, "error");
      expect((yield* store.getThread(thread.id)).lastError).toMatchObject({
        kind: "unknown",
        text: "The turn failed: agent session ended: exited",
      });
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("shuts down keeping what streamed, the turn left open, and refuses sends", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const runtimes = yield* ThreadRuntimes;
      const { thread, session } = yield* createRunning();
      const messageId = "reply-cut" as MessageId;
      // Mid-part: a delta alone marks nothing unsaved, so only closing the message stores it.
      yield* session.emit(
        { type: "chunk", messageId, chunk: { type: "start", messageId } },
        { type: "chunk", messageId, chunk: { type: "text-start", id: "t" } },
        { type: "chunk", messageId, chunk: { type: "text-delta", id: "t", delta: "half a re" } },
      );
      yield* waitFor(
        "the delta",
        runtimes.liveMessages(thread.id).pipe(Effect.map((live) => live.length === 1)),
      );
      expect(yield* runtimes.openSessions).toBe(1);
      yield* runtimes.shutdown;
      expect(yield* runtimes.openSessions).toBe(0);
      // Open, as a kill leaves it, so the next boot records it interrupted rather than failed.
      expect(yield* store.listTurns(thread.id)).toMatchObject([
        { endedAt: undefined, reason: undefined },
      ]);
      expect((yield* store.getThread(thread.id)).lastError).toBeUndefined();
      const stored = yield* store.listMessages(thread.id);
      expect(stored.at(-1)?.parts).toMatchObject([{ type: "text", text: "half a re" }]);
      const refused = yield* runtimes.send(thread.id, { text: "again" }).pipe(Effect.flip);
      expect(refused).toMatchObject({ message: "Gram is quitting" });
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("opens a plain session when nothing sets a session policy", () =>
    Effect.gen(function* () {
      const { session } = yield* createRunning();
      expect(session.options).toMatchObject({ audience: "plain" });
      expect("outwardGate" in session.options).toBe(false);
      expect("instructions" in session.options).toBe(false);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("passes the thread's session policy at every open", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      yield* fake.setInterruptBehavior("hang");
      const asked: Array<string> = [];
      yield* runtimes.setSessionPolicy({
        forThread: (thread) =>
          Effect.sync(() => {
            asked.push(thread.checkout.path);
            return {
              audience: "orchestrator" as const,
              instructions: `role prompt in ${thread.checkout.path}`,
              outwardGate: "irreversible" as const,
              mcpAllowlist: ["teams", "https://mcp.example.test/notes"],
              mcpNoneWithoutToolSearch: true,
            };
          }),
      });
      const opened = (count: number) =>
        waitFor(
          `session ${count}`,
          Effect.sync(() => fake.sessions.length === count && fake.sessions[count - 1]),
        );

      const { thread, session: fresh } = yield* createRunning();
      expect(fresh.options).toMatchObject(policy("/work/repo"));
      expect(yield* runtimes.audienceOf(thread.id)).toBe("orchestrator");

      // The interrupt watchdog closes the session and resumes it.
      const interrupting = yield* Effect.forkScoped(runtimes.interrupt(thread.id));
      yield* waitFor(
        "the interrupt call",
        Effect.sync(() => fresh.interrupts === 1),
      );
      yield* TestClock.adjust("5 seconds");
      yield* Fiber.join(interrupting);
      const recovered = yield* opened(2);
      expect(recovered.options).toMatchObject(policy("/work/repo"));
      yield* waitStatus(thread.id, "idle");

      // Evicted, then resumed by the next send.
      yield* TestClock.adjust("15 minutes");
      yield* waitStatus(thread.id, "cold");
      yield* runtimes.send(thread.id, { text: "again" });
      const resumed = yield* opened(3);
      expect(resumed.options).toMatchObject({
        ...policy("/work/repo"),
        resumeId: fresh.agentSessionId,
      });
      yield* waitFor(
        "the resumed send",
        Effect.sync(() => resumed.sent.length === 1),
      );
      yield* resumed.completeTurn();
      yield* waitStatus(thread.id, "idle");

      // A moved checkout reopens the session once it's idle, under the policy of where it is now.
      yield* runtimes.moveCheckout(thread.id, { kind: "worktree", path: "/work/moved" });
      const moved = yield* opened(4);
      expect(moved.options).toMatchObject({ ...policy("/work/moved"), cwd: "/work/moved" });
      yield* waitStatus(thread.id, "idle");

      const rewindTo = yield* runtimes.rewindTarget(
        thread.id,
        (yield* (yield* ThreadStore).listMessages(thread.id)).at(-1)!.id,
      );
      yield* runtimes.rewind(thread.id, rewindTo);
      const rewound = yield* opened(5);
      expect(rewound.options).toMatchObject({
        ...policy("/work/moved"),
        resumeAt: rewindTo.resumeAt,
      });
      yield* waitStatus(thread.id, "idle");

      const fork = yield* runtimes.fork(yield* runtimes.forkTarget(thread.id, undefined), {
        checkout: { kind: "worktree", path: "/work/fork" },
      });
      yield* runtimes.send(fork.id, { text: "carry on" });
      const forked = yield* opened(6);
      expect(forked.options).toMatchObject({ ...policy("/work/fork"), fork: true });
      expect(asked).toEqual([
        "/work/repo",
        "/work/repo",
        "/work/repo",
        "/work/repo",
        "/work/moved",
        "/work/moved",
        "/work/fork",
      ]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("a session policy that dies costs the role, never the outward gate", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      yield* runtimes.setSessionPolicy({ forThread: () => Effect.die(new Error("no workspace")) });
      const { thread, session } = yield* createRunning();
      expect(session.options).toMatchObject({ audience: "plain", outwardGate: "all" });
      expect(yield* runtimes.audienceOf(thread.id)).toBe("plain");
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("holds retrying only until the agent shows progress or the turn ends", () => {
    const logged: Array<Record<string, unknown>> = [];
    const capture = Logger.make(({ message, fiber }) => {
      logged.push({ message, ...fiber.getRef(References.CurrentLogAnnotations) });
    });
    return Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const seen: Array<boolean> = [];
      yield* runtimes.observe({ onRetrying: (_, on) => Effect.sync(() => void seen.push(on)) });
      const { thread, session } = yield* createRunning();
      const saw = (label: string, expected: ReadonlyArray<boolean>) =>
        waitFor(
          label,
          Effect.sync(() => seen.length === expected.length),
        ).pipe(Effect.andThen(Effect.sync(() => expect(seen).toEqual(expected))));

      // Output after a retry is the recovery, though the adapter never says `running`.
      yield* session.emit({
        type: "status",
        status: "retrying",
        detail: "API retry 1/10 (HTTP 529)",
      });
      yield* saw("the retry", [true]);
      // A background subagent streams on whatever its parent is doing, so it says nothing.
      const subagent = "subagent" as MessageId;
      yield* session.emit(
        {
          type: "chunk",
          messageId: subagent,
          chunk: {
            type: "start",
            messageId: subagent,
            messageMetadata: { agent: "claude", parentToolUseId: "bg1" },
          },
        },
        { type: "chunk", messageId: subagent, chunk: { type: "text-start", id: "s" } },
      );
      for (let i = 0; i < 50; i++) yield* Effect.yieldNow;
      expect(seen).toEqual([true]);
      const messageId = "reply" as MessageId;
      yield* session.emit(
        { type: "chunk", messageId, chunk: { type: "start" } },
        { type: "chunk", messageId, chunk: { type: "text-start", id: "t" } },
      );
      yield* saw("the recovery", [true, false]);

      // A turn that ends while retrying takes it along. The API's own error text stays out of the
      // log, which reads only the prefix this agent's adapter writes, never another's.
      yield* session.emit({
        type: "status",
        status: "retrying",
        detail: "Retry 123: 429 for 'secret plan', attempt 1234567890123456",
      });
      yield* saw("the second retry", [true, false, true]);
      yield* session.completeTurn();
      yield* waitStatus(thread.id, "idle");
      yield* saw("the turn end", [true, false, true, false]);

      // A retry trailing in after the turn has nothing to end it, so it doesn't count.
      yield* session.emit({ type: "status", status: "retrying" });
      for (let i = 0; i < 50; i++) yield* Effect.yieldNow;
      expect(seen).toEqual([true, false, true, false]);
      expect(yield* runtimes.status(thread.id)).toBe("idle");

      const lines = logged.filter((l) => String(l["message"]).includes("retrying"));
      expect(lines[0]).toEqual({
        message: ["thread started retrying"],
        threadId: thread.id,
        agent: "claude",
        attempt: "1/10",
        httpStatus: 529,
      });
      expect(lines[2]).toEqual({
        message: ["thread started retrying"],
        threadId: thread.id,
        agent: "claude",
      });
      expect(JSON.stringify(logged)).not.toContain("secret plan");
      expect(JSON.stringify(logged)).not.toContain("1234567890123456");
      expect(lines.map((l) => l["message"])).toEqual([
        ["thread started retrying"],
        ["thread stopped retrying"],
        ["thread started retrying"],
        ["thread stopped retrying"],
      ]);
    }).pipe(Effect.provide(Layer.provideMerge(RuntimeTestLayer, Logger.layer([capture]))));
  });

  it.effect("stops a turn whose agent is still retrying at the deadline, and says so", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const seen: Array<boolean> = [];
      yield* runtimes.observe({ onRetrying: (_, on) => Effect.sync(() => void seen.push(on)) });
      const { thread, session } = yield* createRunning();
      yield* session.emit({ type: "status", status: "retrying", detail: "Reconnecting... 1/5" });
      yield* waitFor(
        "the retry",
        Effect.sync(() => seen.length === 1),
      );
      // Codex's line changes while it waits, which is no progress.
      yield* session.emit({
        type: "status",
        status: "retrying",
        detail: "Reconnecting... waiting for network",
      });
      yield* TestClock.adjust(Duration.subtract(RETRY_DEADLINE, Duration.seconds(1)));
      expect(session.interrupts).toBe(0);
      yield* TestClock.adjust(Duration.seconds(2));
      yield* waitFor(
        "the interrupt",
        Effect.sync(() => session.interrupts === 1),
      );
      yield* waitStatus(thread.id, "error");
      expect(seen).toEqual([true, false]);
      expect((yield* store.getThread(thread.id)).lastError).toMatchObject({
        kind: "network",
        code: "retriesExhausted",
        retryable: true,
      });
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect(
    "finishes a deadline's stop through a retry reported meanwhile and a hung interrupt",
    () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const fake = yield* FakeAgentControl;
        const { thread, session } = yield* createRunning();
        yield* fake.setInterruptBehavior("hang");
        yield* session.emit({ type: "status", status: "retrying", detail: "Reconnecting... 1/5" });
        yield* TestClock.adjust(Duration.sum(RETRY_DEADLINE, Duration.seconds(1)));
        yield* waitFor(
          "the interrupt",
          Effect.sync(() => session.interrupts === 1),
        );
        // Codex goes on reporting while it ignores the interrupt; that must not restart the clock.
        yield* session.emit({
          type: "status",
          status: "retrying",
          detail: "Reconnecting... waiting for network",
        });
        yield* TestClock.adjust(Duration.seconds(6));
        yield* waitFor(
          "the watchdog's fresh session",
          fake.latest(thread.id).pipe(Effect.map((latest) => latest !== session)),
        );
        expect((yield* store.getThread(thread.id)).lastError).toMatchObject({
          code: "retriesExhausted",
        });
        expect(session.interrupts).toBe(1);
      }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("leaves a watchdog's starting session alone once a deadline's stop ends", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const fake = yield* FakeAgentControl;
      const runtimes = yield* ThreadRuntimes;
      const { thread, session } = yield* createRunning();
      const messageId = "reply" as MessageId;
      yield* session.emit(
        { type: "chunk", messageId, chunk: { type: "start" } },
        { type: "chunk", messageId, chunk: { type: "text-start", id: "t" } },
      );
      yield* fake.setInterruptBehavior("hang");
      yield* session.emit({ type: "status", status: "retrying", detail: "Reconnecting... 1/5" });
      yield* TestClock.adjust(Duration.sum(RETRY_DEADLINE, Duration.seconds(1)));
      yield* waitFor(
        "the interrupt",
        Effect.sync(() => session.interrupts === 1),
      );
      // The watchdog's fresh session is still starting when the stop publishes its card.
      yield* fake.setOpenDelay(Duration.minutes(1));
      yield* TestClock.adjust(Duration.seconds(6));
      yield* waitFor(
        "the failure card",
        store
          .getMessage(thread.id, messageId)
          .pipe(
            Effect.map(
              (stored) => stored?.parts.some((part) => part.type === "data-agent-error") === true,
            ),
          ),
      );
      for (let i = 0; i < 50; i++) yield* Effect.yieldNow;
      expect(yield* runtimes.status(thread.id)).toBe("starting");
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("cancels the retry deadline once the agent gets through", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const { thread, session } = yield* createRunning();
      yield* session.emit({ type: "status", status: "retrying", detail: "Reconnecting... 1/5" });
      yield* session.emit({ type: "status", status: "running" });
      yield* TestClock.adjust(Duration.sum(RETRY_DEADLINE, Duration.minutes(1)));
      for (let i = 0; i < 50; i++) yield* Effect.yieldNow;
      expect(session.interrupts).toBe(0);
      expect(yield* runtimes.status(thread.id)).toBe("running");
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect(
    "stores a big streaming reply less often than its parts complete, and whole at its end",
    () =>
      Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const store = yield* ThreadStore;
        const { thread, session } = yield* createRunning();
        const messageId = "big" as MessageId;
        const before = (yield* store.feedRevision(thread.id))!.rev;
        const parts = 20;
        const chunk = yield* bigReply(session, messageId, parts);
        yield* waitFor(
          "every part",
          runtimes
            .liveMessages(thread.id)
            .pipe(Effect.map((live) => live[0]?.parts.length === parts + 1)),
        );
        // The text part and every tool output completed a part: one save each without spacing.
        const saves = (yield* store.feedRevision(thread.id))!.rev - before;
        expect(saves).toBeLessThan(parts);
        yield* session.emit(chunk({ type: "finish" }));
        yield* waitFor(
          "the finished reply stored",
          store
            .getMessage(thread.id, messageId)
            .pipe(Effect.map((stored) => stored?.parts.length === parts + 1)),
        );
      }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("stores a background transcript's held parts when its session ends between turns", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const { thread, session } = yield* createRunning();
      yield* session.completeTurn();
      yield* waitStatus(thread.id, "idle");
      const lane = "lane" as MessageId;
      const parts = 20;
      yield* bigReply(session, lane, parts, { agent: "claude", parentToolUseId: "bg1" });
      yield* session.end();
      yield* waitFor(
        "the lane stored whole",
        store
          .getMessage(thread.id, lane)
          .pipe(Effect.map((stored) => stored?.parts.length === parts + 1)),
      );
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it("reads Codex's retry attempt and status from its adapter's line, and nothing else", () => {
    expect(retryFacts("codex", "Reconnecting... 1/2 (HTTP 403)")).toEqual({
      attempt: "1/2",
      httpStatus: 403,
    });
    expect(retryFacts("codex", "Reconnecting... 2/5")).toEqual({ attempt: "2/5" });
    expect(retryFacts("codex", "unexpected status 403 Forbidden: API key is disabled")).toEqual({});
  });

  it.effect("keeps a resumed session cold until the first send", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      const thread = yield* runtimes.create({
        projectRoot: "/work/repo",
        checkout: { kind: "main", path: "/work/repo" },
        resumeSessionId: "past-session-1",
      });
      for (let i = 0; i < 50; i++) yield* Effect.yieldNow;
      expect(fake.sessions.filter((s) => s.options.threadId === thread.id)).toHaveLength(0);
      const [summary] = yield* runtimes.snapshot;
      expect(summary?.status).toBe("cold");
      expect(summary?.capabilities).toBeDefined();

      yield* runtimes.send(thread.id, { text: "carry on" });
      const session = yield* waitFor(
        "the first send",
        fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
      );
      expect(session.options.resumeId).toBe("past-session-1");
      // A session from history has a transcript, so it's never marked unused.
      const store = yield* ThreadStore;
      expect((yield* store.getThread(thread.id)).agentSessionUnused).toBeUndefined();
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );
});
