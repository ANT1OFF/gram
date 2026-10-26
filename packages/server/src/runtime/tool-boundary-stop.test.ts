import { describe, expect, it } from "@effect/vitest";
import type { AgentEvent, MessageId, RequestId, ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentControl } from "./fake-agent.ts";
import { RuntimeTestLayer, waitFor } from "./test-harness.ts";
import { PAUSE_STOP_TEXT, ThreadRuntimes } from "./thread-runtimes.ts";

// `stopAtToolBoundary`, which the user's pause of a workspace stops its turns with. It never
// interrupts: the tool gate closes, so every call from then on is refused with `PAUSE_STOP_TEXT`,
// one already running finishes, and the agent ends its turn itself. The fake keeps the gate as
// Claude's adapter does (`makeToolGate`): a call is admitted as its input starts and refused there
// once the gate is closed, and its turn's end opens it.

const createRunning = Effect.gen(function* () {
  const runtimes = yield* ThreadRuntimes;
  const fake = yield* FakeAgentControl;
  const thread = yield* runtimes.create({
    projectRoot: "/work/repo",
    checkout: { kind: "main", path: "/work/repo" },
    input: { text: "one" },
  });
  const session = yield* waitFor(
    "the first send",
    fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
  );
  return { thread, session };
});

const MESSAGE = "m-release" as MessageId;

const chunk = (value: unknown): AgentEvent =>
  ({ type: "chunk", messageId: MESSAGE, chunk: value }) as AgentEvent;

const toolStarts = (toolCallId: string, command: string) =>
  chunk({ type: "tool-input-available", toolCallId, toolName: "Bash", input: { command } });

const toolEnds = (toolCallId: string) =>
  chunk({ type: "tool-output-available", toolCallId, output: "" });

const statusOf = (threadId: ThreadId) =>
  Effect.gen(function* () {
    return yield* (yield* ThreadRuntimes).status(threadId);
  });

/** Waits until the runtime has taken in the running command: its activity line names it. */
const toolSeen = (threadId: ThreadId, command: string) =>
  waitFor(
    `the activity of ${command}`,
    Effect.gen(function* () {
      const line = yield* (yield* ThreadRuntimes).activity(threadId);
      return line?.includes(command) === true;
    }),
  );

describe("stopAtToolBoundary", () => {
  it.effect("lets a running command finish and the agent end its turn, interrupting nothing", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const { thread, session } = yield* createRunning;
      yield* session.emit(
        chunk({ type: "start", messageId: MESSAGE }),
        toolStarts("c1", "gh release create v1.2.0"),
      );
      yield* toolSeen(thread.id, "gh release");
      expect(yield* runtimes.stopAtToolBoundary(thread.id)).toBe(true);
      expect(session.gateCloses).toBe(1);
      // The release runs to its end; the next call is refused, and the agent ends its turn.
      yield* session.emit(toolEnds("c1"), toolStarts("c2", "git push"));
      yield* session.completeTurn();
      yield* waitFor("idle", statusOf(thread.id).pipe(Effect.map((s) => s === "idle")));
      expect(session.refusedTools).toEqual(["c2"]);
      expect(session.interrupts).toBe(0);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("never interrupts a call admitted after a held turn rolls over to the next", () =>
    Effect.gen(function* () {
      // The reviewer's reproduction: c1 runs, the stop is asked for, c1's turn ends, and a turn the
      // agent opens by itself starts c2 as the gate has opened again. c2 must run to its end.
      const runtimes = yield* ThreadRuntimes;
      const { thread, session } = yield* createRunning;
      let holding = true;
      yield* runtimes.holdAgentTurns(() => Effect.succeed(holding));
      yield* session.emit(
        chunk({ type: "start", messageId: MESSAGE }),
        toolStarts("c1", "gh release create v1"),
      );
      yield* toolSeen(thread.id, "gh release");
      expect(yield* runtimes.stopAtToolBoundary(thread.id)).toBe(true);
      yield* session.emit(toolEnds("c1"));
      yield* session.completeTurn();
      yield* waitFor("idle", statusOf(thread.id).pipe(Effect.map((s) => s === "idle")));
      const next = "m-next" as MessageId;
      yield* session.emit(
        {
          type: "chunk",
          messageId: next,
          chunk: {
            type: "start",
            messageId: next,
            messageMetadata: { agent: "claude", initiator: "agent" },
          },
        } as AgentEvent,
        {
          type: "chunk",
          messageId: next,
          chunk: {
            type: "tool-input-available",
            toolCallId: "c2",
            toolName: "Bash",
            input: { command: "git push origin main" },
          },
        } as AgentEvent,
      );
      yield* waitFor(
        "the held turn's gate",
        Effect.sync(() => session.gateCloses === 2),
      );
      for (let i = 0; i < 200; i++) yield* Effect.yieldNow;
      yield* session.emit({
        type: "chunk",
        messageId: next,
        chunk: { type: "tool-output-available", toolCallId: "c2", output: "" },
      } as AgentEvent);
      yield* session.completeTurn();
      yield* waitFor("idle", statusOf(thread.id).pipe(Effect.map((s) => s === "idle")));
      holding = false;
      expect(session.interrupts).toBe(0);
      expect(session.runningAtInterrupt).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(RuntimeTestLayer)),
  );

  it.effect("lets every call running at once finish, and interrupts none of them", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const { thread, session } = yield* createRunning;
      yield* session.emit(
        chunk({ type: "start", messageId: MESSAGE }),
        toolStarts("c1", "bun run build"),
        toolStarts("c2", "npm publish"),
      );
      yield* toolSeen(thread.id, "npm publish");
      expect(yield* runtimes.stopAtToolBoundary(thread.id)).toBe(true);
      yield* session.emit(toolEnds("c1"), toolEnds("c2"), toolStarts("c3", "git tag v1"));
      yield* session.completeTurn();
      yield* waitFor("idle", statusOf(thread.id).pipe(Effect.map((s) => s === "idle")));
      expect(session.refusedTools).toEqual(["c3"]);
      expect(session.interrupts).toBe(0);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("asks an agent with no tool gate to end its turn, and never interrupts it", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      yield* fake.setToolGate(false);
      const { thread, session } = yield* createRunning;
      yield* session.emit(
        chunk({ type: "start", messageId: MESSAGE }),
        toolStarts("c1", "cargo test"),
      );
      yield* toolSeen(thread.id, "cargo test");
      expect(yield* runtimes.stopAtToolBoundary(thread.id)).toBe(true);
      yield* waitFor(
        "the stop request",
        Effect.sync(() => session.steered.some((input) => input.text === PAUSE_STOP_TEXT)),
      );
      yield* session.emit(toolEnds("c1"));
      for (let i = 0; i < 200; i++) yield* Effect.yieldNow;
      expect(session.interrupts).toBe(0);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("does nothing at rest, and leaves background tasks running", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const { thread, session } = yield* createRunning;
      yield* session.completeTurn();
      yield* waitFor("idle", statusOf(thread.id).pipe(Effect.map((s) => s === "idle")));
      expect(yield* runtimes.stopAtToolBoundary(thread.id)).toBe(false);
      expect(session.gateCloses).toBe(0);
      expect(session.interrupts).toBe(0);
      expect(session.taskStops).toEqual([]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("leaves a card waiting on the user theirs to answer", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const { thread, session } = yield* createRunning;
      yield* session.emit({
        type: "request",
        request: {
          kind: "question",
          id: "q-port" as RequestId,
          questions: [{ question: "Which port?", header: "Port", options: [], multiSelect: false }],
        },
      } as AgentEvent);
      yield* waitFor(
        "the card",
        store.listRequests(thread.id).pipe(Effect.map((all) => all.length === 1)),
      );
      expect(yield* runtimes.stopAtToolBoundary(thread.id)).toBe(true);
      for (let i = 0; i < 200; i++) yield* Effect.yieldNow;
      expect(session.interrupts).toBe(0);
      expect(yield* store.listRequests(thread.id)).toHaveLength(1);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("closes the gate on a turn the agent opens by itself while a hold holds it", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const { thread, session } = yield* createRunning;
      yield* session.completeTurn();
      yield* waitFor("idle", statusOf(thread.id).pipe(Effect.map((s) => s === "idle")));
      let holding = true;
      yield* runtimes.holdAgentTurns(() => Effect.succeed(holding));
      const own = "m-own" as MessageId;
      yield* session.emit({
        type: "chunk",
        messageId: own,
        chunk: {
          type: "start",
          messageId: own,
          messageMetadata: { agent: "claude", initiator: "agent" },
        },
      } as AgentEvent);
      yield* waitFor(
        "the held turn's gate",
        Effect.sync(() => session.gateCloses === 1),
      );
      yield* session.completeTurn();
      yield* waitFor("idle", statusOf(thread.id).pipe(Effect.map((s) => s === "idle")));
      // Let go, the next one runs with its gate open.
      holding = false;
      const next = "m-next" as MessageId;
      yield* session.emit({
        type: "chunk",
        messageId: next,
        chunk: {
          type: "start",
          messageId: next,
          messageMetadata: { agent: "claude", initiator: "agent" },
        },
      } as AgentEvent);
      yield* waitFor("running", statusOf(thread.id).pipe(Effect.map((s) => s === "running")));
      for (let i = 0; i < 200; i++) yield* Effect.yieldNow;
      expect(session.gateCloses).toBe(1);
      expect(session.interrupts).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(RuntimeTestLayer)),
  );
});
