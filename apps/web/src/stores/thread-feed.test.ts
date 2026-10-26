import type {
  MessageId,
  GramUIMessage,
  GramUIMessageChunk,
  ThreadFeedEvent,
} from "@gram/contracts";
import { readUIMessageStream } from "ai";
import { describe, expect, it } from "vitest";

import { createMessageFold } from "./message-fold";
import { createThreadFeed, type Scheduler } from "./thread-feed";

function manualScheduler() {
  const frames: (() => void)[] = [];
  const scheduler: Scheduler = (cb) => {
    frames.push(cb);
    return () => frames.splice(frames.indexOf(cb), 1);
  };
  return {
    scheduler,
    get pending() {
      return frames.length;
    },
    run() {
      for (const cb of frames.splice(0)) cb();
    },
  };
}

const chunk = (messageId: string, c: GramUIMessageChunk): ThreadFeedEvent => ({
  type: "chunk",
  messageId: messageId as MessageId,
  chunk: c,
});

const textTurn = (id: string, words: string[]): ThreadFeedEvent[] => [
  chunk(id, { type: "start", messageId: id }),
  chunk(id, { type: "text-start", id: "t" }),
  ...words.map((delta) => chunk(id, { type: "text-delta", id: "t", delta })),
  chunk(id, { type: "text-end", id: "t" }),
  chunk(id, { type: "finish" }),
];

const textMessage = (id: string, role: "user" | "assistant") => ({
  id,
  role,
  parts: [{ type: "text" as const, text: id }],
});

/** Assistant message `a1` streaming its text as `deltas`, from its first chunk. */
const inflight = (deltas: string[]) => [
  chunk("a1", { type: "start", messageId: "a1" }),
  chunk("a1", { type: "text-start", id: "t" }),
  ...deltas.map((delta) => chunk("a1", { type: "text-delta", id: "t", delta })),
];

describe("createThreadFeed", () => {
  it("publishes nothing until caughtUp, then the replayed state at once", async () => {
    const frames = manualScheduler();
    const feed = createThreadFeed({ scheduler: frames.scheduler });

    feed.apply({
      type: "messages",
      messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }],
    });
    for (const e of textTurn("a1", ["Hel", "lo"])) feed.apply(e);
    await feed.whenSettled();

    expect(frames.pending).toBe(0);
    expect(feed.store.getState()).toMatchObject({ phase: "loading", messages: [] });

    feed.apply({ type: "caughtUp", rev: 0 });
    frames.run();

    const { phase, messages } = feed.store.getState();
    expect(phase).toBe("live");
    expect(messages.map((m) => m.id)).toEqual(["u1", "a1"]);
    expect(messages[1]!.parts).toContainEqual(
      expect.objectContaining({ type: "text", text: "Hello" }),
    );
  });

  it("coalesces many chunks into one store update per frame", async () => {
    const frames = manualScheduler();
    const feed = createThreadFeed({ scheduler: frames.scheduler });
    feed.apply({ type: "messages", messages: [] });
    feed.apply({ type: "caughtUp", rev: 0 });
    frames.run();

    let updates = 0;
    feed.store.subscribe(() => updates++);
    for (const e of textTurn("a1", ["a", "b", "c", "d", "e"])) feed.apply(e);
    await feed.whenSettled();

    expect(frames.pending).toBe(1);
    frames.run();
    expect(updates).toBe(1);
    expect(feed.store.getState().messages[0]!.parts).toContainEqual(
      expect.objectContaining({ type: "text", text: "abcde" }),
    );
  });

  it("applies tool and data parts", async () => {
    const frames = manualScheduler();
    const feed = createThreadFeed({ scheduler: frames.scheduler });
    feed.apply({ type: "caughtUp", rev: 0 });
    for (const e of [
      chunk("a1", { type: "start", messageId: "a1" }),
      chunk("a1", {
        type: "tool-input-available",
        toolCallId: "c1",
        toolName: "Bash",
        input: { command: "ls" },
        providerExecuted: true,
      }),
      chunk("a1", {
        type: "tool-output-available",
        toolCallId: "c1",
        output: { stdout: "a\nb", stderr: "", interrupted: false },
        providerExecuted: true,
      }),
      chunk("a1", { type: "data-chapter", id: "ch", data: { id: "ch", title: "Fix" } }),
      chunk("a1", {
        type: "data-subagent-usage",
        id: "c1",
        data: { toolCallId: "c1", status: "running", totalTokens: 900 },
      }),
      chunk("a1", { type: "finish" }),
    ]) {
      feed.apply(e);
    }
    await feed.whenSettled();
    frames.run();

    const [message] = feed.store.getState().messages;
    expect(message!.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool-Bash",
          state: "output-available",
          input: { command: "ls" },
        }),
        expect.objectContaining({ type: "data-chapter", data: { id: "ch", title: "Fix" } }),
        expect.objectContaining({
          type: "data-subagent-usage",
          data: { toolCallId: "c1", status: "running", totalTokens: 900 },
        }),
      ]),
    );
    expect(feed.store.getState().streamingMessageIds).toEqual([]);
  });

  it("folds interleaved parent and subagent streams independently", async () => {
    const frames = manualScheduler();
    const feed = createThreadFeed({ scheduler: frames.scheduler });
    feed.apply({ type: "caughtUp", rev: 0 });
    feed.apply(chunk("a1", { type: "start", messageId: "a1" }));
    feed.apply(chunk("a1", { type: "text-start", id: "t" }));
    feed.apply(chunk("a1", { type: "text-delta", id: "t", delta: "parent " }));
    feed.apply(
      chunk("s1", { type: "start", messageId: "s1", messageMetadata: { parentToolUseId: "task" } }),
    );
    feed.apply(chunk("s1", { type: "text-start", id: "t" }));
    feed.apply(chunk("s1", { type: "text-delta", id: "t", delta: "child" }));
    feed.apply(chunk("a1", { type: "text-delta", id: "t", delta: "text" }));
    await feed.whenSettled();
    frames.run();

    const state = feed.store.getState();
    expect(state.streamingMessageIds).toEqual(["a1", "s1"]);
    const text = (id: string) =>
      state.messages.find((m) => m.id === id)!.parts.find((p) => p.type === "text");
    expect(text("a1")).toMatchObject({ text: "parent text" });
    expect(text("s1")).toMatchObject({ text: "child" });
    expect(state.messages.find((m) => m.id === "s1")!.metadata).toEqual({
      parentToolUseId: "task",
    });
  });

  it("keeps the streaming ids' array while the same messages stream", async () => {
    const frames = manualScheduler();
    const feed = createThreadFeed({ scheduler: frames.scheduler });
    feed.apply({ type: "caughtUp", rev: 0 });
    feed.apply(chunk("a1", { type: "start", messageId: "a1" }));
    feed.apply(chunk("a1", { type: "text-start", id: "t" }));
    frames.run();
    const streaming = feed.store.getState().streamingMessageIds;
    expect(streaming).toEqual(["a1"]);

    // Each frame grows the reply; which messages stream stays the same.
    for (let frame = 0; frame < 5; frame++) {
      feed.apply(chunk("a1", { type: "text-delta", id: "t", delta: `word${frame} ` }));
      frames.run();
      expect(feed.store.getState().streamingMessageIds).toBe(streaming);
    }
    expect(feed.store.getState().messages[0]!.parts).toContainEqual(
      expect.objectContaining({ type: "text", text: "word0 word1 word2 word3 word4 " }),
    );

    feed.apply(
      chunk("s1", { type: "start", messageId: "s1", messageMetadata: { parentToolUseId: "task" } }),
    );
    frames.run();
    expect(feed.store.getState().streamingMessageIds).toEqual(["a1", "s1"]);
    feed.apply(chunk("a1", { type: "finish" }));
    frames.run();
    expect(feed.store.getState().streamingMessageIds).toEqual(["s1"]);
  });

  it("upserts user messages between chunks", async () => {
    const frames = manualScheduler();
    const feed = createThreadFeed({ scheduler: frames.scheduler });
    feed.apply({ type: "messages", messages: [] });
    feed.apply({ type: "caughtUp", rev: 0 });
    feed.apply({
      type: "message",
      message: { id: "u1", role: "user", parts: [{ type: "text", text: "go" }] },
      rev: 1,
    });
    for (const e of textTurn("a1", ["ok"])) feed.apply(e);
    await feed.whenSettled();
    frames.run();

    expect(feed.store.getState().messages.map((m) => m.id)).toEqual(["u1", "a1"]);
  });

  it("publishes a live replace-all at once, as the server sends after a rewind", async () => {
    const frames = manualScheduler();
    const feed = createThreadFeed({ scheduler: frames.scheduler });
    feed.apply({ type: "subscribed" });
    feed.apply({
      type: "messages",
      messages: [
        textMessage("u1", "user"),
        textMessage("a1", "assistant"),
        textMessage("u2", "user"),
      ],
    });
    feed.apply({ type: "caughtUp", rev: 0 });
    frames.run();

    // It's published before its `caughtUp` arrives.
    feed.apply({
      type: "messages",
      messages: [textMessage("u1", "user"), textMessage("a1", "assistant")],
    });
    frames.run();
    expect(feed.store.getState().messages.map((m) => m.id)).toEqual(["u1", "a1"]);

    feed.apply({ type: "message", message: textMessage("u3", "user"), rev: 2 });
    frames.run();
    expect(feed.store.getState().messages.map((m) => m.id)).toEqual(["u1", "a1", "u3"]);
  });

  it("resubscribes without duplicating the replayed in-flight message", async () => {
    const frames = manualScheduler();
    const feed = createThreadFeed({ scheduler: frames.scheduler });
    const user = {
      id: "u1",
      role: "user" as const,
      parts: [{ type: "text" as const, text: "go" }],
    };
    const text = () =>
      feed.store
        .getState()
        .messages.find((m) => m.id === "a1")
        ?.parts.find((p) => p.type === "text");

    feed.apply({ type: "messages", messages: [user] });
    for (const e of inflight(["Hel"])) feed.apply(e);
    feed.apply({ type: "caughtUp", rev: 0 });
    await feed.whenSettled();
    frames.run();
    expect(text()).toMatchObject({ text: "Hel" });

    // The connection drops; the new subscription replays the in-flight message from its first chunk.
    feed.apply({ type: "subscribed" });
    feed.apply({ type: "messages", messages: [user] });
    for (const e of inflight(["Hel", "lo"])) feed.apply(e);
    await feed.whenSettled();
    frames.run();
    expect(frames.pending).toBe(0);
    expect(text()).toMatchObject({ text: "Hel" });

    feed.apply({ type: "caughtUp", rev: 0 });
    await feed.whenSettled();
    frames.run();
    expect(feed.store.getState().messages.map((m) => m.id)).toEqual(["u1", "a1"]);
    expect(text()).toMatchObject({ text: "Hello" });
    expect(feed.store.getState().streamingMessageIds).toEqual(["a1"]);
  });

  it("resumes from the last revision, updating in place what changed", async () => {
    const frames = manualScheduler();
    const feed = createThreadFeed({ scheduler: frames.scheduler });
    expect(feed.resume()?.afterRev).toBeUndefined();
    feed.apply({ type: "subscribed" });
    feed.apply({
      type: "messages",
      messages: [textMessage("u1", "user"), textMessage("a1", "assistant")],
    });
    feed.apply({ type: "caughtUp", rev: 4 });
    feed.apply({ type: "message", message: textMessage("u2", "user"), rev: 6 });
    frames.run();
    expect(feed.resume()?.afterRev).toBe(6);

    feed.apply({ type: "subscribed" });
    const edited = {
      ...textMessage("a1", "assistant"),
      parts: [{ type: "text" as const, text: "new" }],
    };
    feed.apply({ type: "resumed", messages: [edited, textMessage("a2", "assistant")] });
    feed.apply({ type: "caughtUp", rev: 9 });
    frames.run();
    const { messages } = feed.store.getState();
    expect(messages.map((m) => m.id)).toEqual(["u1", "a1", "u2", "a2"]);
    expect(messages[1]).toEqual(edited);
    expect(feed.resume()?.afterRev).toBe(9);
  });

  it("resumes from below a streaming message, and drops it if the server never stored it", async () => {
    const frames = manualScheduler();
    const feed = createThreadFeed({ scheduler: frames.scheduler });
    feed.apply({ type: "subscribed" });
    feed.apply({ type: "messages", messages: [textMessage("u1", "user")] });
    feed.apply({ type: "caughtUp", rev: 4 });
    for (const e of inflight(["Hel"])) feed.apply(e);
    // A message after the stream began moves the revision past the streaming message's rows.
    feed.apply({ type: "message", message: textMessage("u2", "user"), rev: 7 });
    frames.run();
    expect(feed.resume()?.afterRev).toBe(4);

    // The server restarted and has no `a1`: the resumed head neither stores nor replays it.
    feed.apply({ type: "subscribed" });
    feed.apply({ type: "resumed", messages: [] });
    frames.run();
    expect(feed.store.getState().messages.map((m) => m.id)).toEqual(["u1", "a1", "u2"]);
    feed.apply({ type: "caughtUp", rev: 7 });
    frames.run();
    expect(feed.store.getState()).toMatchObject({ streamingMessageIds: [] });
    expect(feed.store.getState().messages.map((m) => m.id)).toEqual(["u1", "u2"]);
    expect(feed.resume()?.afterRev).toBe(7);
  });

  it("replays a streaming message into a resumed head without doubling it", async () => {
    const frames = manualScheduler();
    const feed = createThreadFeed({ scheduler: frames.scheduler });
    const text = () =>
      feed.store
        .getState()
        .messages.find((m) => m.id === "a1")
        ?.parts.filter((p) => p.type === "text");
    feed.apply({ type: "subscribed" });
    feed.apply({ type: "messages", messages: [textMessage("u1", "user")] });
    feed.apply({ type: "caughtUp", rev: 4 });
    for (const e of inflight(["Hel"])) feed.apply(e);
    frames.run();

    feed.apply({ type: "subscribed" });
    feed.apply({ type: "resumed", messages: [] });
    for (const e of inflight(["Hel", "lo"])) feed.apply(e);
    feed.apply({ type: "caughtUp", rev: 5 });
    await feed.whenSettled();
    frames.run();
    expect(feed.store.getState().messages.map((m) => m.id)).toEqual(["u1", "a1"]);
    expect(text()).toEqual([expect.objectContaining({ text: "Hello" })]);
    // Still streaming, with the bound it was resumed with.
    expect(feed.resume()?.afterRev).toBe(4);
  });

  it("pages older history in above what it holds, until a message is there", async () => {
    const frames = manualScheduler();
    const all = Array.from({ length: 6 }, (_, i) =>
      textMessage(`m${i}`, i % 2 ? "assistant" : "user"),
    );
    const asked: string[] = [];
    const feed = createThreadFeed({
      scheduler: frames.scheduler,
      history: async (before) => {
        asked.push(before);
        const end = all.findIndex((m) => m.id === before);
        return { messages: all.slice(Math.max(0, end - 2), end), earlier: end - 2 > 0 };
      },
    });
    feed.apply({ type: "subscribed" });
    feed.apply({ type: "messages", messages: all.slice(4), earlier: true });
    feed.apply({ type: "caughtUp", rev: 1 });
    frames.run();
    expect(feed.store.getState()).toMatchObject({ earlier: true, loadingEarlier: false });

    await feed.loadEarlier();
    frames.run();
    expect(feed.store.getState().messages.map((m) => m.id)).toEqual(["m2", "m3", "m4", "m5"]);
    expect(feed.resume()).toEqual({ afterRev: 1, from: "m2" });

    await feed.loadEarlier({ until: "m0" });
    frames.run();
    expect(asked).toEqual(["m4", "m2"]);
    expect(feed.store.getState()).toMatchObject({ earlier: false, loadingEarlier: false });
    expect(feed.store.getState().messages).toEqual(all);
    // Nothing more to page in.
    await feed.loadEarlier();
    expect(asked).toHaveLength(2);
  });

  it("takes a target given while a page is on its way on past that page", async () => {
    const frames = manualScheduler();
    const all = Array.from({ length: 6 }, (_, i) =>
      textMessage(`m${i}`, i % 2 ? "assistant" : "user"),
    );
    const feed = createThreadFeed({
      scheduler: frames.scheduler,
      history: async (before) => {
        const end = all.findIndex((m) => m.id === before);
        return { messages: all.slice(Math.max(0, end - 2), end), earlier: end - 2 > 0 };
      },
    });
    feed.apply({ type: "subscribed" });
    feed.apply({ type: "messages", messages: all.slice(4), earlier: true });
    feed.apply({ type: "caughtUp", rev: 1 });
    const scrolled = feed.loadEarlier();
    const found = feed.loadEarlier({ until: "m0" });
    await Promise.all([scrolled, found]);
    frames.run();
    expect(feed.store.getState().messages).toEqual(all);
  });

  it("finds an older message by paging it in, retrying a failed page, before any frame", async () => {
    const frames = manualScheduler();
    const all = Array.from({ length: 6 }, (_, i) =>
      textMessage(`m${i}`, i % 2 ? "assistant" : "user"),
    );
    let fail = true;
    const feed = createThreadFeed({
      scheduler: frames.scheduler,
      history: async (before) => {
        if (fail) {
          fail = false;
          throw new Error("offline");
        }
        const end = all.findIndex((m) => m.id === before);
        return { messages: all.slice(Math.max(0, end - 2), end), earlier: end - 2 > 0 };
      },
    });
    feed.apply({ type: "subscribed" });
    feed.apply({ type: "messages", messages: all.slice(4), earlier: true });
    feed.apply({ type: "caughtUp", rev: 1 });
    frames.run();
    await expect(feed.find("m1")).rejects.toThrow("offline");
    // The next ask is a retry, and answers before the page is published.
    expect(await feed.find("m1")).toEqual(all[1]);
    expect(feed.store.getState().messages.some((m) => m.id === "m1")).toBe(false);
    frames.run();
    // Only a history paged in to its start says the message isn't there.
    expect(await feed.find("gone")).toBeUndefined();
    expect(await feed.find("m5")).toEqual(all[5]);
  });

  it("waits for the first catch-up before it says a message isn't there", async () => {
    const feed = createThreadFeed({
      scheduler: manualScheduler().scheduler,
      history: async () => ({ messages: [textMessage("m0", "user")], earlier: false }),
    });
    feed.apply({ type: "subscribed" });
    let settled = false;
    const found = feed.find("m0").finally(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    feed.apply({ type: "messages", messages: [textMessage("m1", "assistant")], earlier: true });
    feed.apply({ type: "caughtUp", rev: 1 });
    expect(await found).toEqual(textMessage("m0", "user"));

    // A reply replayed unfinished is found from its chunks, before a frame collects them.
    const replayed = createThreadFeed({ scheduler: manualScheduler().scheduler });
    replayed.apply({ type: "subscribed" });
    replayed.apply({ type: "messages", messages: [] });
    const streaming = replayed.find("a1");
    for (const event of textTurn("a1", ["Hi ", "Kari"]).slice(0, -1)) replayed.apply(event);
    replayed.apply({ type: "caughtUp", rev: 1 });
    expect((await streaming)?.parts).toMatchObject([{ type: "text", text: "Hi Kari" }]);

    // Revived from cold, it answers from the new subscription, not from what it held.
    const revived = createThreadFeed({ scheduler: manualScheduler().scheduler });
    revived.apply({ type: "subscribed" });
    revived.apply({ type: "messages", messages: [textMessage("a1", "assistant")] });
    revived.apply({ type: "caughtUp", rev: 1 });
    revived.resubscribing();
    const fresh = revived.find("a1");
    const revised = {
      ...textMessage("a1", "assistant"),
      parts: [{ type: "text" as const, text: "v2" }],
    };
    revived.apply({ type: "subscribed" });
    revived.apply({ type: "resumed", messages: [revised] });
    revived.apply({ type: "caughtUp", rev: 2 });
    expect((await fresh)?.parts).toEqual([{ type: "text", text: "v2" }]);

    const waiting = createThreadFeed({ scheduler: manualScheduler().scheduler });
    const lost = waiting.find("m0");
    waiting.gone();
    await expect(lost).rejects.toThrow("the thread is gone");
  });

  it("asks again after a failed page only when retried, resubscribed or replaced", async () => {
    const frames = manualScheduler();
    let calls = 0;
    const feed = createThreadFeed({
      scheduler: frames.scheduler,
      history: async () => {
        calls++;
        if (calls <= 2) throw new Error("offline");
        return { messages: [textMessage("u1", "user")], earlier: false };
      },
    });
    feed.apply({ type: "subscribed" });
    feed.apply({ type: "messages", messages: [textMessage("u2", "user")], earlier: true });
    feed.apply({ type: "caughtUp", rev: 1 });
    await expect(feed.loadEarlier()).rejects.toThrow("offline");
    expect(feed.store.getState()).toMatchObject({ earlierFailed: true, loadingEarlier: false });
    await feed.loadEarlier();
    await feed.loadEarlier({ until: "u1" });
    expect(calls).toBe(1);

    // A rewind's new history pages on its own again; its failure waits for a retry in turn.
    feed.apply({ type: "messages", messages: [textMessage("u2", "user")], earlier: true });
    feed.apply({ type: "caughtUp", rev: 2 });
    expect(feed.store.getState().earlierFailed).toBe(false);
    await expect(feed.loadEarlier()).rejects.toThrow("offline");
    await feed.loadEarlier();
    expect(calls).toBe(2);

    await feed.loadEarlier({ retry: true });
    frames.run();
    expect(calls).toBe(3);
    expect(feed.store.getState()).toMatchObject({ earlierFailed: false, earlier: false });
    expect(feed.store.getState().messages.map((m) => m.id)).toEqual(["u1", "u2"]);
  });

  it("ignores the failure of a page asked for before the feed resubscribed", async () => {
    const frames = manualScheduler();
    const page = Promise.withResolvers<{ messages: GramUIMessage[]; earlier: boolean }>();
    const feed = createThreadFeed({ scheduler: frames.scheduler, history: () => page.promise });
    feed.apply({ type: "subscribed" });
    feed.apply({ type: "messages", messages: [textMessage("u2", "user")], earlier: true });
    feed.apply({ type: "caughtUp", rev: 1 });
    const paging = feed.loadEarlier();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(feed.store.getState().loadingEarlier).toBe(true);
    // The connection drops and comes back while the page is on its way, and then it fails.
    feed.apply({ type: "subscribed" });
    feed.apply({ type: "resumed", messages: [] });
    feed.apply({ type: "caughtUp", rev: 1 });
    page.reject(new Error("socket closed"));
    await paging;
    expect(feed.store.getState().earlierFailed).toBe(false);
  });

  it("drops a page read before the history was replaced", async () => {
    const frames = manualScheduler();
    const page = Promise.withResolvers<{ messages: GramUIMessage[]; earlier: boolean }>();
    const feed = createThreadFeed({ scheduler: frames.scheduler, history: () => page.promise });
    feed.apply({ type: "subscribed" });
    feed.apply({ type: "messages", messages: [textMessage("u2", "user")], earlier: true });
    feed.apply({ type: "caughtUp", rev: 1 });
    const paging = feed.loadEarlier();
    // A rewind replaces the history while the page is on its way.
    feed.apply({ type: "messages", messages: [textMessage("u1", "user")] });
    feed.apply({ type: "caughtUp", rev: 2 });
    page.resolve({ messages: [textMessage("u0", "user")], earlier: false });
    await paging;
    frames.run();
    expect(feed.store.getState().messages.map((m) => m.id)).toEqual(["u1"]);
    expect(feed.store.getState().earlier).toBe(false);
  });

  it("forgets its revision when the thread is gone", () => {
    const feed = createThreadFeed({ scheduler: manualScheduler().scheduler });
    feed.apply({ type: "subscribed" });
    feed.apply({ type: "messages", messages: [] });
    feed.apply({ type: "caughtUp", rev: 3 });
    feed.gone();
    expect(feed.resume()?.afterRev).toBeUndefined();
  });
});

/** Every kind of chunk the adapters emit, in the order a turn would. */
const EVERYTHING = [
  { type: "start", messageId: "m1", messageMetadata: { createdAt: 1, agentMessageIds: ["a"] } },
  { type: "start-step" },
  { type: "reasoning-start", id: "r" },
  { type: "reasoning-delta", id: "r", delta: "hm" },
  { type: "reasoning-end", id: "r" },
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: "Looking " },
  { type: "text-delta", id: "t", delta: "now." },
  { type: "text-end", id: "t" },
  { type: "tool-input-start", toolCallId: "c1", toolName: "Bash" },
  { type: "tool-input-delta", toolCallId: "c1", inputTextDelta: '{"command":"ls' },
  { type: "tool-input-delta", toolCallId: "c1", inputTextDelta: ' -la"}' },
  {
    type: "tool-input-available",
    toolCallId: "c1",
    toolName: "Bash",
    input: { command: "ls -la" },
  },
  { type: "tool-output-available", toolCallId: "c1", output: "a\nb", preliminary: true },
  { type: "tool-output-available", toolCallId: "c1", output: "a\nb\nc" },
  { type: "data-tool-image", data: { toolCallId: "c1", mediaType: "image/png", size: 3 } },
  { type: "finish-step" },
  { type: "start-step" },
  { type: "tool-input-start", toolCallId: "c2", toolName: "mcp__x__y", dynamic: true, title: "Y" },
  {
    type: "tool-input-available",
    toolCallId: "c2",
    toolName: "mcp__x__y",
    dynamic: true,
    input: {},
  },
  { type: "tool-approval-request", toolCallId: "c2", approvalId: "ap", reason: "outward" },
  { type: "tool-approval-response", approvalId: "ap", approved: false, reason: "no" },
  { type: "tool-output-denied", toolCallId: "c2" },
  { type: "tool-input-start", toolCallId: "c3", toolName: "Edit" },
  { type: "tool-input-error", toolCallId: "c3", toolName: "Edit", input: "{", errorText: "bad" },
  { type: "tool-input-available", toolCallId: "c4", toolName: "Read", input: { file_path: "/x" } },
  { type: "tool-output-error", toolCallId: "c4", errorText: "gone" },
  { type: "data-task-chip", id: "chip", data: { title: "one" } },
  { type: "data-task-chip", id: "chip", data: { title: "two" } },
  { type: "data-subagent-usage", data: { tokens: 1 }, transient: true },
  { type: "file", mediaType: "text/plain", url: "file:///tmp/a.txt" },
  {
    type: "source-url",
    sourceId: "s",
    url: "https://organization.example.invalid",
    title: "Example",
  },
  { type: "message-metadata", messageMetadata: { agentMessageIds: ["b"], usage: { in: 1 } } },
  { type: "start-step" },
  { type: "text-start", id: "t2" },
  { type: "text-delta", id: "t2", delta: "discarded" },
  { type: "reset-step" },
  { type: "text-start", id: "t3" },
  { type: "text-delta", id: "t3", delta: "Done." },
  { type: "text-end", id: "t3" },
  { type: "finish", messageMetadata: { usage: { out: 2 } } },
] as unknown as GramUIMessageChunk[];

/** A message as it is stored and sent: what survives JSON. */
const stored = (message: unknown) => JSON.parse(JSON.stringify(message)) as GramUIMessage;

async function sdkFold(chunks: readonly GramUIMessageChunk[], base?: GramUIMessage) {
  const stream = new ReadableStream<GramUIMessageChunk>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
  let last: GramUIMessage | undefined;
  for await (const snapshot of readUIMessageStream<GramUIMessage>({
    stream,
    ...(base ? { message: base } : {}),
  })) {
    last = snapshot;
  }
  return last;
}

describe("createMessageFold", () => {
  it("folds every prefix of a turn to what the AI SDK's readUIMessageStream folds", async () => {
    for (let length = 1; length <= EVERYTHING.length; length++) {
      const prefix = EVERYTHING.slice(0, length);
      // The SDK publishes a step's marker with the step's first part, so its last snapshot lags here.
      if (prefix.at(-1)?.type === "start-step") continue;
      const fold = createMessageFold("m1");
      for (const c of prefix) fold.apply(c);
      await fold.parsePartialInputs();
      const expected = stored(await sdkFold(prefix));
      // The SDK replaces agent message ids; the fold accumulates them, as the server stores them.
      const ids = prefix.flatMap(
        (c) =>
          (c as { messageMetadata?: { agentMessageIds?: string[] } }).messageMetadata
            ?.agentMessageIds ?? [],
      );
      if (expected.metadata) expected.metadata = { ...expected.metadata, agentMessageIds: ids };
      expect(stored(fold.snapshot()), `after ${length} chunks`).toEqual(expected);
    }
  });

  it("continues a stored message the way the SDK does", async () => {
    const base = stored(await sdkFold(EVERYTHING.slice(0, 13)));
    const rest = EVERYTHING.slice(13, 17);
    const fold = createMessageFold("m1", { base });
    for (const c of rest) fold.apply(c);
    expect(stored(fold.snapshot())).toEqual(stored(await sdkFold(rest, base)));
  });

  it("keeps the identity of every part a chunk didn't touch", () => {
    const fold = createMessageFold("m1");
    for (const c of EVERYTHING.slice(0, 15)) fold.apply(c);
    const before = fold.snapshot();
    expect(fold.snapshot()).toBe(before);
    fold.apply({ type: "text-start", id: "late" });
    fold.apply({ type: "text-delta", id: "late", delta: "more" });
    const after = fold.snapshot();
    expect(after).not.toBe(before);
    expect(after.parts.length).toBe(before.parts.length + 1);
    before.parts.forEach((part, index) => expect(after.parts[index]).toBe(part));
  });

  it("reports a chunk with nothing to apply to and carries on", () => {
    const errors: unknown[] = [];
    const fold = createMessageFold("m1", { onError: (error) => errors.push(error) });
    fold.apply({ type: "text-delta", id: "missing", delta: "x" });
    fold.apply({ type: "tool-output-available", toolCallId: "missing", output: 1 });
    fold.apply({ type: "text-start", id: "t" });
    fold.apply({ type: "text-delta", id: "t", delta: "ok" });
    expect(errors).toHaveLength(2);
    expect(fold.snapshot().parts).toEqual([{ type: "text", text: "ok", state: "streaming" }]);
  });
});
