import { describe, expect, it } from "@effect/vitest";
import {
  FEED_WINDOW_TURNS,
  type GramUIMessage,
  type MessageId,
  type ServerEvent,
  type ThreadFeedEvent,
  type ThreadId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { EventHub } from "../events/event-hub.ts";
import type { ThreadFeedItem } from "../events/event-hub.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentControl } from "./fake-agent.ts";
import { makeFeedWriter } from "./feed-writer.ts";
import type { Runtime } from "./runtime-state.ts";
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

const stored = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const { messages } = yield* store.recentMessages(threadId, FEED_WINDOW_TURNS);
    return messages;
  });

const ids = (messages: ReadonlyArray<GramUIMessage>) => messages.map((message) => message.id);

describe("turn end stamp", () => {
  it.effect("stamps the reply with a whole-message write after its finish", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const { thread, feed } = yield* warmThreadWithFeed;

      yield* runtimes.send(thread.id, { text: "hello" });
      const session = yield* sessionOf(thread.id, 1);
      const messageId = "reply" as MessageId;
      yield* session.emit(
        ...(openReply(messageId, "done") as never[]),
        { type: "chunk", messageId, chunk: { type: "finish" } },
        { type: "turnEnd", reason: "completed" },
        { type: "status", status: "idle" },
      );
      yield* turnEnded(thread.id, 1);

      const turns = yield* store.listTurns(thread.id);
      const reply = yield* store.getMessage(thread.id, messageId);
      expect(reply?.metadata?.turnEnd).toEqual({ at: turns[0]!.endedAt, reason: "completed" });

      const finish = feed.findIndex(
        (e) => e.type === "chunk" && e.messageId === messageId && e.chunk.type === "finish",
      );
      const after = feed
        .slice(finish + 1)
        .filter((e) => e.type === "chunk" || e.type === "message");
      // A chunk after `finish` would tell clients the reply is streaming again.
      expect(after.map((e) => e.type)).toEqual(["message"]);
      expect(after[0]).toMatchObject({ message: { id: messageId } });
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("says a stopped turn was interrupted", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const { thread } = yield* warmThreadWithFeed;

      yield* runtimes.send(thread.id, { text: "hello" });
      const session = yield* sessionOf(thread.id, 1);
      const messageId = "reply" as MessageId;
      yield* session.emit(...(openReply(messageId, "partial") as never[]));
      yield* runtimes.interrupt(thread.id);
      yield* turnEnded(thread.id, 1);

      const reply = yield* store.getMessage(thread.id, messageId);
      expect(reply?.metadata?.turnEnd?.reason).toBe("interrupted");
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("keeps the stamp under a failed turn's error card", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const { thread } = yield* warmThreadWithFeed;

      yield* runtimes.send(thread.id, { text: "hello" });
      const session = yield* sessionOf(thread.id, 1);
      const messageId = "reply" as MessageId;
      yield* session.emit(...(openReply(messageId, "partial") as never[]), {
        type: "turnEnd",
        reason: "error",
        error: "boom",
      });
      yield* waitFor(
        "the error card",
        store
          .getMessage(thread.id, messageId)
          .pipe(
            Effect.map(
              (reply) => reply?.parts.some((part) => part.type === "data-agent-error") === true,
            ),
          ),
      );

      const reply = yield* store.getMessage(thread.id, messageId);
      expect(reply?.metadata?.turnEnd?.reason).toBe("error");
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("survives a held reply's late tool output", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const { thread } = yield* warmThreadWithFeed;

      yield* runtimes.send(thread.id, { text: "hello" });
      const session = yield* sessionOf(thread.id, 1);
      const messageId = "reply" as MessageId;
      const tool = { toolCallId: "exec-1", dynamic: true } as const;
      yield* session.emit(
        { type: "chunk", messageId, chunk: { type: "start", messageId } },
        {
          type: "chunk",
          messageId,
          chunk: { type: "tool-input-available", ...tool, toolName: "exec", input: {} },
        },
        {
          type: "chunk",
          messageId,
          chunk: { type: "tool-output-available", ...tool, output: "…", preliminary: true },
        },
        { type: "chunk", messageId, chunk: { type: "finish" } },
        { type: "turnEnd", reason: "completed" },
        { type: "status", status: "idle" },
      );
      yield* turnEnded(thread.id, 1);
      yield* session.emit({
        type: "chunk",
        messageId,
        chunk: { type: "tool-output-available", ...tool, output: "all of it" },
      });
      yield* waitFor(
        "the late output",
        store
          .getMessage(thread.id, messageId)
          .pipe(
            Effect.map(
              (reply) =>
                JSON.stringify(reply?.parts).includes("all of it") &&
                reply?.metadata?.turnEnd !== undefined,
            ),
          ),
      );
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("moves nothing but the reply's own row, and tells only the transcript", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const hub = yield* EventHub;
      const { thread } = yield* warmThreadWithFeed;

      yield* runtimes.send(thread.id, { text: "one" });
      const session = yield* sessionOf(thread.id, 1);
      const first = "first" as MessageId;
      yield* session.emit(
        ...(openReply(first, "one") as never[]),
        { type: "chunk", messageId: first, chunk: { type: "finish" } },
        { type: "turnEnd", reason: "completed" },
        { type: "status", status: "idle" },
      );
      yield* turnEnded(thread.id, 1);
      yield* runtimes.send(thread.id, { text: "two" });
      const later = yield* sessionOf(thread.id, 2);
      const second = "second" as MessageId;
      yield* later.emit(
        ...(openReply(second, "two") as never[]),
        { type: "chunk", messageId: second, chunk: { type: "finish" } },
        { type: "turnEnd", reason: "completed" },
        { type: "status", status: "idle" },
      );
      yield* turnEnded(thread.id, 2);

      const events: Array<ServerEvent> = [];
      const items: Array<ThreadFeedItem> = [];
      let observed = 0;
      const { stampTurnEnd } = makeFeedWriter({
        store,
        hub: {
          ...hub,
          publish: (event) => Effect.sync(() => void events.push(event)),
          publishFeed: (item) => Effect.sync(() => void items.push(item)),
        },
        notifyObservers: () => Effect.sync(() => void observed++),
        searchRefreshes: yield* FiberMap.make<string>(),
      });
      const rt = {
        threadId: thread.id,
        feedLock: yield* Semaphore.make(1),
        open: new Map(),
        seq: 0,
      } as unknown as Runtime;
      const before = yield* stored(thread.id);
      const threadBefore = yield* store.getThread(thread.id);

      yield* stampTurnEnd(rt, first, { at: 1, reason: "maxTurns" });

      const after = yield* stored(thread.id);
      expect(ids(after)).toEqual(ids(before));
      expect(after.find((m) => m.id === first)?.metadata?.turnEnd?.reason).toBe("maxTurns");
      expect(after.filter((m) => m.id !== first)).toEqual(before.filter((m) => m.id !== first));
      // Unread, attention and notifications come from server events and observers, never the feed.
      expect(events).toEqual([]);
      expect(observed).toBe(0);
      expect(items.map((item) => item.event.type)).toEqual(["message"]);
      expect(yield* store.getThread(thread.id)).toEqual(threadBefore);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );
});
