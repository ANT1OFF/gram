import { describe, expect, it } from "@effect/vitest";
import type {
  AgentEvent,
  BackgroundTask,
  MessageId,
  ServerEvent,
  GramUIMessage,
  GramUIMessageChunk,
  ThreadId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type { ServerConfig } from "../config.ts";
import { EventHub } from "../events/event-hub.ts";
import type { ServerLogShape } from "../logging/service.ts";
import { makeDiagnostics } from "../rpc/handlers/app.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentControl, type FakeSession } from "./fake-agent.ts";
import { MessageAccumulator } from "./message-accumulator.ts";
import { RuntimeTestLayer, waitFor } from "./test-harness.ts";
import { BACKGROUND_OUTPUT_CHARS, ThreadRuntimes } from "./thread-runtimes.ts";

const waitStatus = (threadId: ThreadId, status: string) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    return yield* waitFor(
      `status ${status}`,
      runtimes.status(threadId).pipe(Effect.map((s) => s === status)),
    );
  });

const createRunning = Effect.gen(function* () {
  const runtimes = yield* ThreadRuntimes;
  const fake = yield* FakeAgentControl;
  const thread = yield* runtimes.create({
    projectRoot: "/work/repo",
    checkout: { kind: "main", path: "/work/repo" },
    input: { text: "explore in the background" },
  });
  const session = yield* waitFor(
    "the first send",
    fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
  );
  yield* waitStatus(thread.id, "running");
  return { thread, session };
});

const PARENT = "m-parent" as MessageId;
const SUBAGENT = "m-sub" as MessageId;

const chunk = (messageId: MessageId, c: GramUIMessageChunk): AgentEvent => ({
  type: "chunk",
  messageId,
  chunk: c,
});

/** What the adapter read back of a background shell. */
const backgroundOutput = (taskId: string, tail: string): AgentEvent => ({
  type: "backgroundOutput",
  taskId,
  toolCallId: "t-bash",
  output: tail,
});

const text = (messageId: MessageId, id: string, value: string): Array<AgentEvent> => [
  chunk(messageId, { type: "text-start", id }),
  chunk(messageId, { type: "text-delta", id, delta: value }),
  chunk(messageId, { type: "text-end", id }),
];

const startParent = (messageId: MessageId) =>
  chunk(messageId, { type: "start", messageId, messageMetadata: { agent: "claude" } });

const startSubagent = chunk(SUBAGENT, {
  type: "start",
  messageId: SUBAGENT,
  messageMetadata: { agent: "claude", parentToolUseId: "bg1" },
});

const finish = (messageId: MessageId): Array<AgentEvent> => [
  chunk(messageId, { type: "finish-step" }),
  chunk(messageId, { type: "finish" }),
];

const texts = (message: GramUIMessage | undefined) =>
  (message?.parts ?? []).flatMap((p) => (p.type === "text" ? [p.text] : []));

const byId = (messages: ReadonlyArray<GramUIMessage>, id: MessageId) =>
  messages.find((m) => m.id === id);

const storedTexts = (threadId: ThreadId, id: MessageId) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    return texts(byId(yield* store.listMessages(threadId), id));
  });

describe("background subagents", () => {
  it.effect(
    "keeps interleaved messages whole and the subagent's transcript open past the turn",
    () =>
      Effect.gen(function* () {
        const { thread, session } = yield* createRunning;

        yield* session.emit(
          startParent(PARENT),
          chunk(PARENT, { type: "start-step" }),
          ...text(PARENT, "t1", "launching"),
          startSubagent,
          chunk(SUBAGENT, { type: "start-step" }),
          ...text(SUBAGENT, "s1", "looking"),
          ...text(PARENT, "t2", "it runs in the background"),
          ...finish(PARENT),
          { type: "turnEnd", reason: "completed" },
        );
        yield* waitStatus(thread.id, "idle");
        expect(yield* storedTexts(thread.id, PARENT)).toEqual([
          "launching",
          "it runs in the background",
        ]);
        expect(yield* storedTexts(thread.id, SUBAGENT)).toEqual(["looking"]);

        // The subagent streams on while the thread is idle, then reports done.
        yield* session.emit(...text(SUBAGENT, "s2", "found three files"), ...finish(SUBAGENT));
        yield* waitFor(
          "the finished subagent transcript",
          storedTexts(thread.id, SUBAGENT).pipe(Effect.map((t) => t.length === 2)),
        );
        expect(yield* storedTexts(thread.id, SUBAGENT)).toEqual(["looking", "found three files"]);
        expect(yield* (yield* ThreadRuntimes).status(thread.id)).toBe("idle");
      }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("ends a background subagent's transcript when a restart stops its session", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      const { thread, session } = yield* createRunning;
      yield* session.emit(
        startParent(PARENT),
        ...text(PARENT, "t1", "launching"),
        startSubagent,
        ...text(SUBAGENT, "s1", "looking"),
        ...finish(PARENT),
        { type: "turnEnd", reason: "completed" },
        { type: "status", status: "idle" },
      );
      yield* waitStatus(thread.id, "idle");
      expect((yield* runtimes.liveMessages(thread.id)).map((m) => m.id)).toEqual([SUBAGENT]);

      expect(yield* runtimes.restartSession(thread.id, "interrupt")).toBe("restarting");
      yield* waitFor(
        "the restarted session",
        Effect.sync(() => fake.sessions.length === 2),
      );
      yield* waitStatus(thread.id, "idle");
      // What it streamed is kept, and nothing of it streams on into the new session.
      expect(yield* storedTexts(thread.id, SUBAGENT)).toEqual(["looking"]);
      expect(yield* runtimes.liveMessages(thread.id)).toEqual([]);
      const summary = (yield* runtimes.snapshot).find((s) => s.thread.id === thread.id);
      expect(summary?.activity).toBeUndefined();
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("stores a subagent's partial transcript at a shutdown while the parent is idle", () =>
    Effect.gen(function* () {
      const { thread, session } = yield* createRunning;
      yield* session.emit(
        startParent(PARENT),
        ...text(PARENT, "t1", "launching"),
        startSubagent,
        ...text(SUBAGENT, "s1", "looking"),
        ...finish(PARENT),
        { type: "turnEnd", reason: "completed" },
      );
      yield* waitStatus(thread.id, "idle");
      // Mid-part, which marks nothing unsaved: only the shutdown's flush stores it.
      yield* session.emit(
        chunk(SUBAGENT, { type: "text-start", id: "s2" }),
        chunk(SUBAGENT, { type: "text-delta", id: "s2", delta: "found th" }),
      );
      const runtimes = yield* ThreadRuntimes;
      yield* waitFor(
        "the delta",
        runtimes
          .liveMessages(thread.id)
          .pipe(Effect.map((live) => texts(byId(live, SUBAGENT)).includes("found th"))),
      );
      yield* runtimes.shutdown;
      expect(yield* storedTexts(thread.id, SUBAGENT)).toEqual(["looking", "found th"]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("gives a late subscriber every interleaved message whole", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const { thread, session } = yield* createRunning;
      yield* session.emit(
        startParent(PARENT),
        chunk(PARENT, { type: "start-step" }),
        ...text(PARENT, "t1", "launching"),
        startSubagent,
        chunk(SUBAGENT, { type: "start-step" }),
        ...text(SUBAGENT, "s1", "looking"),
        ...text(PARENT, "t2", "it runs in the background"),
      );

      // What `thread.subscribe` sends first: stored messages, then the open messages' chunks.
      const replay = yield* waitFor(
        "both open messages in the replay",
        runtimes.replay(thread.id).pipe(Effect.map((r) => r.inFlight.length === 13 && r)),
      );
      expect(replay.messages.map((m) => m.id)).not.toContain(PARENT);
      const folded = new Map<string, MessageAccumulator>();
      for (const { event } of replay.inFlight) {
        if (event.type !== "chunk") continue;
        const accumulator = folded.get(event.messageId) ?? new MessageAccumulator(event.messageId);
        accumulator.apply(event.chunk);
        folded.set(event.messageId, accumulator);
      }
      expect(texts(folded.get(PARENT)?.snapshot())).toEqual([
        "launching",
        "it runs in the background",
      ]);
      expect(texts(folded.get(SUBAGENT)?.snapshot())).toEqual(["looking"]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("keeps the subagent's transcript when the user sends a message meanwhile", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const { thread, session } = yield* createRunning;
      yield* session.emit(
        startParent(PARENT),
        ...text(PARENT, "t1", "launching"),
        startSubagent,
        ...text(SUBAGENT, "s1", "looking"),
        ...finish(PARENT),
        { type: "turnEnd", reason: "completed" },
      );
      yield* waitStatus(thread.id, "idle");

      yield* runtimes.send(thread.id, { text: "Reply OK." });
      yield* waitFor(
        "the second send",
        Effect.sync(() => session.sent.length === 2),
      );
      const REPLY = "m-reply" as MessageId;
      yield* session.emit(
        startParent(REPLY),
        ...text(REPLY, "r1", "OK"),
        ...text(SUBAGENT, "s2", "found three files"),
        ...finish(REPLY),
        { type: "turnEnd", reason: "completed" },
      );
      yield* waitStatus(thread.id, "idle");
      expect(yield* storedTexts(thread.id, REPLY)).toEqual(["OK"]);
      expect(yield* storedTexts(thread.id, SUBAGENT)).toEqual(["looking", "found three files"]);

      yield* session.emit(...text(SUBAGENT, "s3", "done"), ...finish(SUBAGENT));
      yield* waitFor(
        "the finished subagent transcript",
        storedTexts(thread.id, SUBAGENT).pipe(Effect.map((t) => t.length === 3)),
      );
      expect(yield* storedTexts(thread.id, PARENT)).toEqual(["launching"]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("puts a terminal usage snapshot on the run's own transcript, not a stray message", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const { thread, session } = yield* createRunning;
      yield* session.emit(
        startParent(PARENT),
        ...text(PARENT, "t1", "launching"),
        startSubagent,
        ...text(SUBAGENT, "s1", "looking"),
        ...finish(PARENT),
        { type: "turnEnd", reason: "completed" },
      );
      yield* waitStatus(thread.id, "idle");

      const usage = {
        toolCallId: "bg1",
        status: "completed" as const,
        totalTokens: 5_380,
        toolUses: 2,
        durationMs: 8_200,
      };
      yield* session.emit({ type: "subagentUsage", usage }, ...finish(SUBAGENT));
      yield* waitFor(
        "the snapshot on the subagent's transcript",
        store
          .listMessages(thread.id)
          .pipe(
            Effect.map((messages) =>
              byId(messages, SUBAGENT)?.parts.some((p) => p.type === "data-subagent-usage"),
            ),
          ),
      );

      const messages = yield* store.listMessages(thread.id);
      expect(messages.map((m) => m.id).filter((id) => id.startsWith("app-"))).toEqual([]);
      expect(
        byId(messages, SUBAGENT)?.parts.filter((p) => p.type === "data-subagent-usage"),
      ).toEqual([{ type: "data-subagent-usage", id: "bg1", data: usage }]);
      expect(byId(messages, PARENT)?.parts.map((p) => p.type)).toEqual(["text"]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("keeps a running snapshot with its lane while the reply streams on", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const { thread, session } = yield* createRunning;
      yield* session.emit(
        startParent(PARENT),
        ...text(PARENT, "t1", "launching"),
        startSubagent,
        ...text(SUBAGENT, "s1", "looking"),
        {
          type: "subagentUsage",
          usage: { toolCallId: "bg1", status: "running", totalTokens: 900, lastToolName: "Glob" },
        },
        {
          type: "subagentUsage",
          usage: { toolCallId: "bg1", status: "running", totalTokens: 2_140, lastToolName: "Grep" },
        },
        ...finish(PARENT),
        { type: "turnEnd", reason: "completed" },
      );
      yield* waitStatus(thread.id, "idle");

      const messages = yield* store.listMessages(thread.id);
      // Snapshots share one id, so the lane carries the latest rather than one part per report.
      expect(
        byId(messages, SUBAGENT)?.parts.filter((p) => p.type === "data-subagent-usage"),
      ).toEqual([
        {
          type: "data-subagent-usage",
          id: "bg1",
          data: {
            toolCallId: "bg1",
            status: "running",
            totalTokens: 2_140,
            lastToolName: "Grep",
          },
        },
      ]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("drops a snapshot for a run whose lane and reply are both closed", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const { thread, session } = yield* createRunning;
      yield* session.emit(
        startParent(PARENT),
        ...text(PARENT, "t1", "launching"),
        ...finish(PARENT),
        { type: "turnEnd", reason: "completed" },
      );
      yield* waitStatus(thread.id, "idle");
      const before = (yield* store.listMessages(thread.id)).length;

      // The stray reply that follows is the ordering marker: once it's stored, the snapshot before
      // it has been handled, and it added nothing.
      const LATER = "m-later" as MessageId;
      yield* session.emit(
        {
          type: "subagentUsage",
          usage: { toolCallId: "gone", status: "completed", totalTokens: 10 },
        },
        startParent(LATER),
        ...text(LATER, "x1", "late tail"),
        ...finish(LATER),
      );
      yield* waitFor(
        "the later reply",
        storedTexts(thread.id, LATER).pipe(Effect.map((t) => t.length === 1)),
      );
      expect(yield* store.listMessages(thread.id)).toHaveLength(before + 1);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("runs a turn the agent starts on its own and records it", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const { thread, session } = yield* createRunning;
      yield* session.completeTurn();
      yield* waitStatus(thread.id, "idle");

      const STRAY = "m-stray" as MessageId;
      yield* session.emit(startParent(STRAY), ...text(STRAY, "x1", "late tail"), ...finish(STRAY));
      yield* waitFor(
        "the stray reply",
        storedTexts(thread.id, STRAY).pipe(Effect.map((t) => t.length === 1)),
      );
      // A reply the agent didn't say it started doesn't flip an idle thread or open a turn.
      expect(yield* (yield* ThreadRuntimes).status(thread.id)).toBe("idle");
      expect(yield* store.listTurns(thread.id)).toHaveLength(1);

      const FOLLOW_UP = "m-follow-up" as MessageId;
      yield* session.emit(
        chunk(FOLLOW_UP, {
          type: "start",
          messageId: FOLLOW_UP,
          messageMetadata: { agent: "claude", initiator: "agent" },
        }),
      );
      yield* waitStatus(thread.id, "running");
      yield* session.emit(
        chunk(FOLLOW_UP, { type: "start-step" }),
        ...text(FOLLOW_UP, "d1", "DONE"),
        ...finish(FOLLOW_UP),
        { type: "turnEnd", reason: "completed" },
      );
      yield* waitStatus(thread.id, "idle");

      expect(yield* store.listTurns(thread.id)).toHaveLength(2);
      expect(yield* storedTexts(thread.id, FOLLOW_UP)).toEqual(["DONE"]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("keeps the session past the idle timeout while a background subagent runs", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const { thread, session } = yield* createRunning;
      yield* session.emit(
        startParent(PARENT),
        ...text(PARENT, "t1", "launching"),
        startSubagent,
        ...text(SUBAGENT, "s1", "looking"),
        ...finish(PARENT),
        { type: "turnEnd", reason: "completed" },
      );
      yield* waitStatus(thread.id, "idle");
      // Idle, with its subagent still at work: busy, as a turn is.
      expect(yield* runtimes.working).toEqual([thread.id]);

      yield* TestClock.adjust("30 minutes");
      for (let i = 0; i < 50; i++) yield* Effect.yieldNow;
      expect(session.closed).toBe(false);

      // Idle starts counting when the last subagent is done.
      yield* session.emit(...finish(SUBAGENT));
      yield* waitFor(
        "the finished subagent transcript",
        storedTexts(thread.id, SUBAGENT).pipe(Effect.map((t) => t.length === 1)),
      );
      yield* waitFor(
        "no subagent at work",
        runtimes.working.pipe(Effect.map((working) => working.length === 0)),
      );
      yield* TestClock.adjust("14 minutes");
      for (let i = 0; i < 50; i++) yield* Effect.yieldNow;
      expect(session.closed).toBe(false);
      expect(yield* runtimes.status(thread.id)).toBe("idle");

      yield* TestClock.adjust("1 minute");
      yield* waitStatus(thread.id, "cold");
      expect(session.closed).toBe(true);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("evicts a thread parked while its background subagent runs once it goes idle", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const { thread, session } = yield* createRunning;
      yield* session.emit(
        startParent(PARENT),
        ...text(PARENT, "t1", "launching"),
        startSubagent,
        ...text(SUBAGENT, "s1", "looking"),
        ...finish(PARENT),
        { type: "turnEnd", reason: "completed" },
      );
      yield* waitStatus(thread.id, "idle");

      yield* runtimes.updateThread(thread.id, (t) => ({ ...t, parked: true }));
      for (let i = 0; i < 50; i++) yield* Effect.yieldNow;
      expect(session.closed).toBe(false);

      yield* session.emit(...text(SUBAGENT, "s2", "found three files"), ...finish(SUBAGENT));
      yield* waitFor(
        "the finished subagent transcript",
        storedTexts(thread.id, SUBAGENT).pipe(Effect.map((t) => t.length === 2)),
      );
      // The agent reports the result back in a turn of its own.
      const REPORT = "m-report" as MessageId;
      yield* session.emit(
        chunk(REPORT, {
          type: "start",
          messageId: REPORT,
          messageMetadata: { agent: "claude", initiator: "agent" },
        }),
        ...text(REPORT, "r1", "three files"),
        ...finish(REPORT),
        { type: "turnEnd", reason: "completed" },
      );
      yield* waitFor(
        "the report",
        storedTexts(thread.id, REPORT).pipe(Effect.map((t) => t.length === 1)),
      );
      yield* waitStatus(thread.id, "idle");
      expect(session.closed).toBe(false);

      yield* TestClock.adjust("15 minutes");
      yield* waitStatus(thread.id, "cold");
      expect(session.closed).toBe(true);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  const settle = Effect.gen(function* () {
    for (let i = 0; i < 50; i++) yield* Effect.yieldNow;
  });

  const SHELL: BackgroundTask = {
    taskId: "b1",
    kind: "shell",
    description: "Run the checks",
    command: "pnpm check",
    toolCallId: "t-bash",
    startedAt: 1_758_800_000_000,
  };

  const shellLeftRunning = (session: FakeSession) =>
    session.emit(
      startParent(PARENT),
      ...text(PARENT, "t1", "running the checks in the background"),
      { type: "backgroundTasks", tasks: [SHELL] },
      ...finish(PARENT),
      { type: "turnEnd", reason: "completed" },
    );

  it.effect("keeps the session past the idle timeout while a background shell runs", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const { thread, session } = yield* createRunning;
      // A command in the thread's terminal is work a quit cuts off too; it counts a thread once.
      const diagnostics = (terminal: "idle" | "busy" | "unknown") =>
        makeDiagnostics({
          runtimes,
          config: { dataDir: "/data" } as ServerConfig["Service"],
          log: {} as ServerLogShape,
          ports: {
            busyTerminalsNow: Effect.succeed(
              terminal === "unknown" ? undefined : terminal === "busy" ? [thread.id] : [],
            ),
          },
        }).pipe(Effect.map((info) => info.threads.working));
      expect(yield* runtimes.working).toHaveLength(1);
      expect(yield* diagnostics("busy")).toBe(1);
      yield* shellLeftRunning(session);
      yield* waitStatus(thread.id, "idle");
      // Idle, but a quit would still kill the shell.
      expect(yield* runtimes.working).toHaveLength(1);

      yield* TestClock.adjust("30 minutes");
      yield* settle;
      expect(session.closed).toBe(false);

      // Idle starts counting when the last task is done.
      yield* session.emit({ type: "backgroundTasks", tasks: [] });
      yield* settle;
      expect(yield* runtimes.working).toHaveLength(0);
      expect(yield* diagnostics("idle")).toBe(0);
      expect(yield* diagnostics("busy")).toBe(1);
      // A failed scan rules nothing out, so the count is left out rather than read as 0.
      expect(yield* diagnostics("unknown")).toBeUndefined();
      yield* TestClock.adjust("14 minutes");
      yield* settle;
      expect(session.closed).toBe(false);
      expect(yield* runtimes.status(thread.id)).toBe("idle");

      yield* TestClock.adjust("1 minute");
      yield* waitStatus(thread.id, "cold");
      expect(session.closed).toBe(true);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("evicts a session whose background shell runs an hour past the idle timeout", () =>
    Effect.gen(function* () {
      const { thread, session } = yield* createRunning;
      yield* shellLeftRunning(session);
      yield* waitStatus(thread.id, "idle");

      yield* TestClock.adjust("74 minutes");
      yield* settle;
      expect(session.closed).toBe(false);

      yield* TestClock.adjust("1 minute");
      yield* waitStatus(thread.id, "cold");
      expect(session.closed).toBe(true);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("keeps a thread parked while its background shell runs until it goes idle", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const { thread, session } = yield* createRunning;
      yield* shellLeftRunning(session);
      yield* waitStatus(thread.id, "idle");

      yield* runtimes.updateThread(thread.id, (t) => ({ ...t, parked: true }));
      yield* settle;
      expect(session.closed).toBe(false);

      yield* session.emit({ type: "backgroundTasks", tasks: [] });
      yield* settle;
      yield* TestClock.adjust("15 minutes");
      yield* waitStatus(thread.id, "cold");
      expect(session.closed).toBe(true);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );
  it.effect(
    "publishes the background tasks, stops one by id, and clears them with the session",
    () =>
      Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const hub = yield* EventHub;
        const published: Array<ServerEvent> = [];
        yield* Effect.forkScoped(
          Stream.runForEach(
            hub.serverEvents(
              Effect.succeed<ServerEvent>({ type: "threads.snapshot", threads: [] }),
            ),
            (event) => Effect.sync(() => void published.push(event)),
          ),
        );
        const { thread, session } = yield* createRunning;
        const background = () =>
          published.flatMap((e) => (e.type === "thread.background" ? [e.tasks] : []));
        const summary = runtimes.snapshot.pipe(
          Effect.map((all) => all.find((s) => s.thread.id === thread.id)),
        );
        yield* shellLeftRunning(session);
        yield* waitStatus(thread.id, "idle");
        yield* waitFor(
          "the published task",
          Effect.sync(() => background().length === 1),
        );
        expect(background()).toEqual([[SHELL]]);
        expect((yield* summary)?.background).toEqual([SHELL]);

        yield* runtimes.stopTask(thread.id, "b1");
        expect(session.taskStops).toEqual(["b1"]);
        const missing = yield* Effect.flip(runtimes.stopTask(thread.id, "b2"));
        expect(missing).toMatchObject({ _tag: "NotFound", entity: "backgroundTask", id: "b2" });
        expect(session.taskStops).toEqual(["b1"]);

        // The session's end takes its tasks with it, as a closed Claude CLI does its shells.
        yield* TestClock.adjust("75 minutes");
        yield* waitStatus(thread.id, "cold");
        yield* waitFor(
          "the cleared tasks",
          Effect.sync(() => background().length === 2),
        );
        expect(background()[1]).toEqual([]);
        expect((yield* summary)?.background).toBeUndefined();
      }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect(
    "publishes a background shell's output while it runs, keeps the latest, and drops it at its end",
    () =>
      Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const hub = yield* EventHub;
        const published: Array<ServerEvent> = [];
        yield* Effect.forkScoped(
          Stream.runForEach(
            hub.serverEvents(
              Effect.succeed<ServerEvent>({ type: "threads.snapshot", threads: [] }),
            ),
            (event) => Effect.sync(() => void published.push(event)),
          ),
        );
        const { thread, session } = yield* createRunning;
        const outputs = () =>
          published.flatMap((e) => (e.type === "thread.backgroundOutput" ? [e] : []));
        const summary = runtimes.snapshot.pipe(
          Effect.map((all) => all.find((s) => s.thread.id === thread.id)),
        );
        // Before its task is listed, there is nothing to put it on.
        yield* session.emit(backgroundOutput("b1", "early\n"));
        yield* shellLeftRunning(session);
        yield* waitStatus(thread.id, "idle");
        yield* session.emit(
          backgroundOutput("b1", "ready\n"),
          // The same tail again, and a task that isn't running: neither is sent.
          backgroundOutput("b1", "ready\n"),
          backgroundOutput("b9", "stray\n"),
        );
        yield* waitFor(
          "the published output",
          Effect.sync(() => outputs().length === 1),
        );
        yield* session.emit(backgroundOutput("b1", `${"x".repeat(10_000)}\nlistening\n`));
        yield* waitFor(
          "the second output",
          Effect.sync(() => outputs().length === 2),
        );
        expect(outputs()[0]).toEqual({
          type: "thread.backgroundOutput",
          threadId: thread.id,
          taskId: "b1",
          toolCallId: "t-bash",
          output: "ready\n",
        });
        // Kept to the last 8 KiB a read returns.
        const kept = outputs()[1]!.output;
        expect(kept).toHaveLength(BACKGROUND_OUTPUT_CHARS);
        expect(kept.endsWith("x\nlistening\n")).toBe(true);
        // A client that comes in now finds the latest in the thread's summary.
        expect((yield* summary)?.backgroundOutput).toEqual([
          { taskId: "b1", toolCallId: "t-bash", output: kept },
        ]);
        // Nothing of it is part of the transcript, and it doesn't wake the thread.
        expect(yield* runtimes.status(thread.id)).toBe("idle");

        // The task ends: its output goes with it.
        yield* session.emit({ type: "backgroundTasks", tasks: [] });
        yield* settle;
        expect((yield* summary)?.backgroundOutput).toBeUndefined();
        yield* session.emit(backgroundOutput("b1", "late\n"));
        yield* settle;
        expect(outputs()).toHaveLength(2);
      }).pipe(Effect.provide(RuntimeTestLayer)),
  );
});
