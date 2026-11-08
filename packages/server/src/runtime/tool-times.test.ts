import { describe, expect, it } from "@effect/vitest";
import { type MessageId, type ThreadFeedEvent, type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { EventHub } from "../events/event-hub.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentControl } from "./fake-agent.ts";
import { RuntimeTestLayer, waitFor } from "./test-harness.ts";
import { ThreadRuntimes } from "./thread-runtimes.ts";

const warmThreadWithFeed = Effect.gen(function* () {
  const runtimes = yield* ThreadRuntimes;
  const hub = yield* EventHub;
  const thread = yield* runtimes.create({
    projectRoot: "/work/repo",
    checkout: { kind: "main", path: "/work/repo" },
  });
  yield* waitFor("idle", runtimes.status(thread.id).pipe(Effect.map((s) => s === "idle")));
  const feed: Array<ThreadFeedEvent> = [];
  yield* Effect.forkScoped(
    Stream.runForEach(hub.threadFeed(thread.id, runtimes.replay(thread.id)), (e) =>
      Effect.sync(() => void feed.push(e)),
    ),
  );
  yield* waitFor(
    "caught up",
    Effect.sync(() => feed.some((e) => e.type === "caughtUp")),
  );
  return { thread, feed };
});

const turnEnded = (threadId: ThreadId, count: number) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const runtimes = yield* ThreadRuntimes;
    yield* waitFor(
      "the turn to end",
      store
        .listTurns(threadId)
        .pipe(
          Effect.map((t) => t.length === count && t.every((turn) => turn.endedAt !== undefined)),
        ),
    );
    yield* waitFor("idle", runtimes.status(threadId).pipe(Effect.map((s) => s === "idle")));
  });

const sessionOf = (threadId: ThreadId, sends: number) =>
  Effect.gen(function* () {
    const fake = yield* FakeAgentControl;
    return yield* waitFor(
      "the send",
      fake.latest(threadId).pipe(Effect.map((s) => s.sent.length === sends && s)),
    );
  });

const openReply = (messageId: MessageId, text: string) => [
  { type: "chunk", messageId, chunk: { type: "start", messageId } },
  { type: "chunk", messageId, chunk: { type: "text-start", id: "t" } },
  { type: "chunk", messageId, chunk: { type: "text-delta", id: "t", delta: text } },
  { type: "chunk", messageId, chunk: { type: "text-end", id: "t" } },
];

describe("tool times", () => {
  it.effect("stamps when each tool call started and ended on the message it streams in", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const { thread, feed } = yield* warmThreadWithFeed;

      yield* runtimes.send(thread.id, { text: "hello" });
      const session = yield* sessionOf(thread.id, 1);
      const messageId = "reply" as MessageId;
      const tool = (chunk: object) => ({ type: "chunk", messageId, chunk });
      yield* session.emit(
        ...(openReply(messageId, "looking") as never[]),
        tool({ type: "tool-input-start", toolCallId: "c1", toolName: "Bash" }) as never,
        tool({
          type: "tool-input-available",
          toolCallId: "c1",
          toolName: "Bash",
          input: { command: "ls" },
        }) as never,
        tool({
          type: "tool-output-available",
          toolCallId: "c1",
          output: "a",
          preliminary: true,
        }) as never,
        tool({ type: "tool-output-available", toolCallId: "c1", output: "a\nb" }) as never,
        tool({ type: "tool-input-start", toolCallId: "c2", toolName: "Read" }) as never,
        tool({ type: "tool-output-error", toolCallId: "c2", errorText: "missing" }) as never,
        { type: "chunk", messageId, chunk: { type: "finish" } },
        { type: "turnEnd", reason: "completed" },
        { type: "status", status: "idle" },
      );
      yield* turnEnded(thread.id, 1);

      const reply = yield* store.getMessage(thread.id, messageId);
      const times = reply?.metadata?.toolTimes;
      expect(Object.keys(times ?? {})).toEqual(["c1", "c2"]);
      for (const time of Object.values(times ?? {})) {
        expect(time.endedAt).toBeGreaterThanOrEqual(time.startedAt);
      }
      // Live subscribers hear each change as metadata, never as a part.
      const stamps = feed.filter(
        (e) =>
          e.type === "chunk" &&
          e.messageId === messageId &&
          e.chunk.type === "message-metadata" &&
          e.chunk.messageMetadata?.toolTimes !== undefined,
      );
      expect(stamps).toHaveLength(4);
      expect(reply?.parts.some((part) => part.type.startsWith("data-"))).toBe(false);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );
});
