import { describe, expect, it } from "@effect/vitest";
import type { RequestId, ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { FakeAgentControl } from "./fake-agent.ts";
import { steerOrSend } from "./steer-or-send.ts";
import { RuntimeTestLayer, waitFor } from "./test-harness.ts";
import { ThreadRuntimes } from "./thread-runtimes.ts";

const waitStatus = (threadId: ThreadId, status: string) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    yield* waitFor(status, runtimes.status(threadId).pipe(Effect.map((s) => s === status)));
  });

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
  yield* waitStatus(thread.id, "running");
  return { thread, session };
});

const queueOf = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    const summary = (yield* runtimes.snapshot).find((s) => s.thread.id === threadId);
    return (summary?.queue ?? []).map((q) => q.input.text);
  });

describe("steerOrSend", () => {
  it.effect("steers into a running turn, cutting nothing off", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const { thread, session } = yield* createRunning;
      expect(yield* steerOrSend(runtimes, thread.id, { text: "two" })).toBe("steered");
      expect(session.steered.map((input) => input.text)).toEqual(["two"]);
      expect(session.steeredInterrupt).toEqual([false]);
      expect(yield* queueOf(thread.id)).toEqual([]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("sends to a thread at rest as a turn of its own", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const { thread, session } = yield* createRunning;
      yield* session.completeTurn();
      yield* waitStatus(thread.id, "idle");
      expect(yield* steerOrSend(runtimes, thread.id, { text: "two" })).toBe("sent");
      expect(session.sent.map((input) => input.text)).toEqual(["one", "two"]);
      expect(session.steered).toEqual([]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("queues behind a turn waiting on an approval", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const { thread, session } = yield* createRunning;
      yield* session.emit({
        type: "request",
        request: {
          kind: "approval",
          id: "req-1" as RequestId,
          toolName: "Bash",
          displayName: "Bash",
          input: { command: "git push" },
          suggestions: [],
        },
      });
      yield* waitStatus(thread.id, "needsApproval");
      expect(yield* steerOrSend(runtimes, thread.id, { text: "two" })).toBe("queued");
      expect(session.steered).toEqual([]);
      expect(yield* queueOf(thread.id)).toEqual(["two"]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("queues what the agent refused mid-turn, once", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      const { thread, session } = yield* createRunning;
      yield* fake.setSteerFails(true);
      expect(yield* steerOrSend(runtimes, thread.id, { text: "two" })).toBe("queued");
      expect(session.steered).toEqual([]);
      expect(yield* queueOf(thread.id)).toEqual(["two"]);
      yield* fake.setSteerFails(false);
      yield* session.completeTurn();
      yield* waitFor(
        "the queued send",
        Effect.sync(() => session.sent.length === 2),
      );
      expect(session.sent.map((input) => input.text)).toEqual(["one", "two"]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("goes through the caller's own fallback", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const { thread, session } = yield* createRunning;
      yield* session.completeTurn();
      yield* waitStatus(thread.id, "idle");
      let used = 0;
      const fallback = Effect.sync(() => {
        used++;
        return { queued: true };
      });
      expect(yield* steerOrSend(runtimes, thread.id, { text: "two" }, fallback)).toBe("queued");
      expect(used).toBe(1);
      expect(session.sent).toHaveLength(1);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );
});
