import { describe, expect, it } from "@effect/vitest";
import type { MessageId, ThreadFeedEvent, ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { AppToolRegistry } from "../app-tools/registry.ts";
import { ServerConfig } from "../config.ts";
import { EventHub } from "../events/event-hub.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentControl, makeFakeAgentAdapter } from "./fake-agent.ts";
import { CheckoutService, TurnHooks } from "./hooks.ts";
import { RuntimeTestLayer, TEST_CONFIG, waitFor } from "./test-harness.ts";
import { ThreadRuntimes } from "./thread-runtimes.ts";

const EchoLayer = AppToolRegistry.layer.pipe(
  Layer.provideMerge(ThreadRuntimes.layer),
  Layer.provideMerge(EventHub.layer),
  Layer.provideMerge(ThreadStore.layerSqlite(":memory:")),
  Layer.provideMerge(makeFakeAgentAdapter({ reply: "echo" })),
  Layer.provideMerge(TurnHooks.layerNoop),
  Layer.provideMerge(CheckoutService.layerNoGit),
  Layer.provideMerge(ServerConfig.layer(TEST_CONFIG)),
  Layer.orDie,
);

/** A warm thread (session open and idle) with its feed collected from `caughtUp` on. */
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

/** The chunk types the feed published for each message id, in order. */
const chunksByMessage = (feed: ReadonlyArray<ThreadFeedEvent>) => {
  const byId = new Map<string, Array<string>>();
  for (const e of feed) {
    if (e.type !== "chunk") continue;
    byId.set(e.messageId, [...(byId.get(e.messageId) ?? []), e.chunk.type]);
  }
  return byId;
};

const waitIdleAfterTurn = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const runtimes = yield* ThreadRuntimes;
    yield* waitFor(
      "the turn to end",
      // TestClock time starts at 0, so an ended turn can have `endedAt: 0`.
      store
        .listTurns(threadId)
        .pipe(Effect.map((t) => t.length > 0 && t.every((x) => x.endedAt !== undefined))),
    );
    yield* waitFor("idle", runtimes.status(threadId).pipe(Effect.map((s) => s === "idle")));
  });

describe("thread feed finish chunks", () => {
  it.effect("publishes exactly one start and one finish per reply, with finish last", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const { thread, feed } = yield* warmThreadWithFeed;

      yield* runtimes.send(thread.id, { text: "hello" });
      yield* waitIdleAfterTurn(thread.id);

      const replies = [...chunksByMessage(feed).values()];
      expect(replies).toHaveLength(1);
      for (const types of replies) {
        expect(types[0]).toBe("start");
        expect(types.at(-1)).toBe("finish");
        expect(types.filter((t) => t === "start")).toHaveLength(1);
        expect(types.filter((t) => t === "finish")).toHaveLength(1);
      }
    }).pipe(Effect.provide(EchoLayer)),
  );

  it.effect("finishes a reply the agent left open when the turn ends", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const fake = yield* FakeAgentControl;
      const { thread, feed } = yield* warmThreadWithFeed;

      yield* runtimes.send(thread.id, { text: "one" });
      const session = yield* waitFor(
        "the send",
        fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
      );
      const messageId = "open-reply" as MessageId;
      yield* session.emit(
        { type: "chunk", messageId, chunk: { type: "start", messageId } },
        { type: "chunk", messageId, chunk: { type: "text-start", id: "t" } },
        { type: "chunk", messageId, chunk: { type: "text-delta", id: "t", delta: "partial" } },
        { type: "usage", tokens: { inputTokens: 1, outputTokens: 1 } },
        { type: "turnEnd", reason: "completed" },
        { type: "status", status: "idle" },
      );
      yield* waitIdleAfterTurn(thread.id);

      const types = chunksByMessage(feed).get(messageId) ?? [];
      expect(types[0]).toBe("start");
      expect(types.at(-1)).toBe("finish");
      // Usage rides `thread.usage` alone; nothing about it reaches the reply's chunks.
      expect(types).not.toContain("data-usage");
      const stored = yield* store.getMessage(thread.id, messageId);
      expect(stored?.parts.map((p) => p.type)).toEqual(["text"]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );
});
