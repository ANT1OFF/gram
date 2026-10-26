import { describe, expect, it } from "@effect/vitest";
import {
  FEED_WINDOW_TURNS,
  FeedCursor,
  recentTurns,
  type MessageId,
  type GramUIMessage,
  type ThreadFeedEvent,
  type ThreadId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AppToolRegistry } from "../app-tools/registry.ts";
import { ServerConfig } from "../config.ts";
import { EventHub } from "../events/event-hub.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { SqlClient } from "../platform/unstable.ts";
import { FakeAgentAdapter, FakeAgentControl } from "./fake-agent.ts";
import { CheckoutService, TurnHooks } from "./hooks.ts";
import { MessageAccumulator } from "./message-accumulator.ts";
import { RuntimeTestLayer, TEST_CONFIG, waitFor } from "./test-harness.ts";
import { RESUME_MAX_MESSAGES, ThreadRuntimes } from "./thread-runtimes.ts";

const layerAt = (file: string) =>
  AppToolRegistry.layer.pipe(
    Layer.provideMerge(ThreadRuntimes.layer),
    Layer.provideMerge(EventHub.layer),
    Layer.provideMerge(ThreadStore.layerSqlite(file)),
    Layer.provideMerge(FakeAgentAdapter),
    Layer.provideMerge(TurnHooks.layerNoop),
    Layer.provideMerge(CheckoutService.layerNoGit),
    Layer.provideMerge(ServerConfig.layer(TEST_CONFIG)),
    Layer.orDie,
  );

/**
 * A renderer's feed as far as resuming goes: the rules of `apps/web`'s feed store, driven by the
 * same `FeedCursor`, folding with the server's own accumulator.
 */
class Client {
  readonly cursor = new FeedCursor();
  messages: Array<GramUIMessage> = [];
  readonly folds = new Map<string, MessageAccumulator>();
  /** Every head this client was sent, by type: `messages` or `resumed`. */
  readonly heads: Array<{ type: string; ids: ReadonlyArray<string> }> = [];
  caughtUps = 0;

  #upsert(message: GramUIMessage) {
    const index = this.messages.findIndex((m) => m.id === message.id);
    this.messages = index === -1 ? [...this.messages, message] : this.messages.with(index, message);
  }

  subscribed() {
    this.cursor.subscribed();
    this.folds.clear();
  }

  apply(event: ThreadFeedEvent) {
    switch (event.type) {
      case "messages":
        this.cursor.replaced();
        this.folds.clear();
        this.messages = [...event.messages];
        this.heads.push({ type: "messages", ids: event.messages.map((m) => m.id) });
        return;
      case "resumed":
        this.cursor.resumed(event.messages.map((m) => m.id));
        for (const message of event.messages) this.#upsert(message);
        this.heads.push({ type: "resumed", ids: event.messages.map((m) => m.id) });
        return;
      case "message":
        this.#upsert(event.message);
        this.cursor.message(event.rev);
        return;
      case "chunk": {
        let fold = this.folds.get(event.messageId);
        if (fold === undefined) {
          const held = this.messages.some((m) => m.id === event.messageId);
          // Nothing here continues a stored message, which the accumulator can't start from.
          expect(this.cursor.opened(event.messageId, held)).toBe(false);
          fold = new MessageAccumulator(event.messageId);
          this.folds.set(event.messageId, fold);
        }
        fold.apply(event.chunk);
        this.#upsert(fold.snapshot());
        if (event.chunk.type === "finish" || event.chunk.type === "abort") {
          this.folds.delete(event.messageId);
          this.cursor.closed(event.messageId);
        }
        return;
      }
      case "caughtUp": {
        const lost = this.cursor.caughtUp(event.rev);
        this.messages = this.messages.filter((m) => !lost.includes(m.id));
        this.caughtUps++;
        return;
      }
    }
  }
}

/** Subscribes `client` as the web api does, from its cursor; interrupt the fiber to disconnect. */
const connect = (client: Client, threadId: ThreadId) =>
  Effect.gen(function* () {
    const hub = yield* EventHub;
    const runtimes = yield* ThreadRuntimes;
    const afterRev = client.cursor.resumeRev();
    const before = client.caughtUps;
    let first = true;
    const fiber = yield* Effect.forkScoped(
      Stream.runForEach(
        hub.threadFeed(threadId, runtimes.replay(threadId, afterRev), runtimes.replay(threadId)),
        (event) =>
          Effect.sync(() => {
            if (first) client.subscribed();
            first = false;
            client.apply(event);
          }),
      ),
    );
    yield* waitFor(
      "caughtUp",
      Effect.sync(() => client.caughtUps > before),
    );
    return { fiber, afterRev };
  });

/** What a client that subscribes now for the first time holds once caught up. */
const fresh = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const client = new Client();
    const { fiber } = yield* connect(client, threadId);
    yield* Fiber.interrupt(fiber);
    return client.messages;
  });

const idsOf = (messages: ReadonlyArray<GramUIMessage>) => messages.map((m) => m.id);

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
    yield* waitFor("running", runtimes.status(thread.id).pipe(Effect.map((s) => s === "running")));
    return { thread, session };
  });

const waitIdle = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    yield* waitFor("idle", runtimes.status(threadId).pipe(Effect.map((s) => s === "idle")));
  });

const text = (messageId: MessageId, id: string, delta: string) =>
  [
    { type: "chunk", messageId, chunk: { type: "text-start", id } },
    { type: "chunk", messageId, chunk: { type: "text-delta", id, delta } },
    { type: "chunk", messageId, chunk: { type: "text-end", id } },
  ] as const;

describe("feed resume", () => {
  it.effect("an idle thread resumes with only what changed", () =>
    Effect.gen(function* () {
      const { thread, session } = yield* createRunning();
      yield* session.completeTurn("first");
      yield* waitIdle(thread.id);

      const client = new Client();
      const first = yield* connect(client, thread.id);
      yield* Fiber.interrupt(first.fiber);
      const runtimes = yield* ThreadRuntimes;
      const before = idsOf(client.messages);

      yield* runtimes.send(thread.id, { text: "two" });
      yield* waitFor(
        "the second send",
        Effect.sync(() => session.sent.length === 2),
      );
      yield* session.completeTurn("second");
      yield* waitIdle(thread.id);

      const second = yield* connect(client, thread.id);
      expect(second.afterRev).toBeGreaterThan(0);
      const head = client.heads.at(-1)!;
      expect(head.type).toBe("resumed");
      // Only the new prompt and its reply: nothing the client already held is sent again.
      expect(head.ids.filter((id) => before.includes(id))).toEqual([]);
      expect(head.ids).toHaveLength(2);
      expect(client.messages).toEqual(yield* fresh(thread.id));

      // With nothing new since, the head is empty.
      yield* Fiber.interrupt(second.fiber);
      yield* connect(client, thread.id);
      expect(client.heads.at(-1)).toEqual({ type: "resumed", ids: [] });
    }).pipe(Effect.scoped, Effect.provide(RuntimeTestLayer)),
  );

  it.effect("nothing is lost or doubled across a disconnect mid-turn", () =>
    Effect.gen(function* () {
      const { thread, session } = yield* createRunning();
      const reply = "reply" as MessageId;
      const client = new Client();
      const first = yield* connect(client, thread.id);

      yield* session.emit(
        { type: "chunk", messageId: reply, chunk: { type: "start", messageId: reply } },
        ...text(reply, "a", "before the drop"),
        { type: "chunk", messageId: reply, chunk: { type: "text-start", id: "b" } },
        { type: "chunk", messageId: reply, chunk: { type: "text-delta", id: "b", delta: "half" } },
      );
      yield* waitFor(
        "the streamed text",
        Effect.sync(() => JSON.stringify(client.messages).includes("half")),
      );
      yield* Fiber.interrupt(first.fiber);

      // Written while the client is away: the rest of this reply, and a second message.
      const other = "other" as MessageId;
      yield* session.emit(
        { type: "chunk", messageId: reply, chunk: { type: "text-delta", id: "b", delta: " more" } },
        { type: "chunk", messageId: reply, chunk: { type: "text-end", id: "b" } },
        { type: "chunk", messageId: reply, chunk: { type: "finish" } },
        { type: "chunk", messageId: other, chunk: { type: "start", messageId: other } },
        ...text(other, "c", "while away"),
      );

      // Resumed while the turn is still open: the finished reply is replayed, not stored twice.
      const runtimes = yield* ThreadRuntimes;
      yield* waitFor(
        "the away chunks",
        runtimes.replay(thread.id).pipe(Effect.map((r) => r.inFlight.length >= 10)),
      );
      const second = yield* connect(client, thread.id);
      expect(second.afterRev).toBeDefined();
      expect(client.heads.at(-1)!.type).toBe("resumed");
      expect(client.messages).toEqual(yield* fresh(thread.id));

      // Dropped again after the turn ends, then resumed.
      yield* Fiber.interrupt(second.fiber);
      yield* session.emit(
        { type: "chunk", messageId: other, chunk: { type: "finish" } },
        { type: "turnEnd", reason: "completed" },
        { type: "status", status: "idle" },
      );
      yield* waitIdle(thread.id);
      yield* connect(client, thread.id);
      expect(client.heads.at(-1)!.type).toBe("resumed");
      const expected = yield* fresh(thread.id);
      expect(client.messages).toEqual(expected);
      expect(idsOf(expected)).toEqual([expect.any(String), reply, other]);
      expect(JSON.stringify(expected)).toContain("half more");
    }).pipe(Effect.scoped, Effect.provide(RuntimeTestLayer)),
  );

  it.effect("a server restart mid-turn leaves the client with what was stored", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "gram-feed-resume-"));
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(dir, { recursive: true })));
      const file = join(dir, "gram.db");
      const client = new Client();
      const stored = "stored" as MessageId;
      const unstored = "unstored" as MessageId;

      const { threadId, crashed } = yield* Effect.gen(function* () {
        const { thread, session } = yield* createRunning();
        yield* connect(client, thread.id);
        yield* session.emit(
          { type: "chunk", messageId: stored, chunk: { type: "start", messageId: stored } },
          ...text(stored, "a", "kept"),
          { type: "chunk", messageId: stored, chunk: { type: "text-start", id: "b" } },
          {
            type: "chunk",
            messageId: stored,
            chunk: { type: "text-delta", id: "b", delta: "lost" },
          },
          // No part of this one ever completes, so it is never stored.
          { type: "chunk", messageId: unstored, chunk: { type: "start", messageId: unstored } },
          { type: "chunk", messageId: unstored, chunk: { type: "text-start", id: "c" } },
          {
            type: "chunk",
            messageId: unstored,
            chunk: { type: "text-delta", id: "c", delta: "x" },
          },
        );
        yield* waitFor(
          "the streamed text",
          Effect.sync(() => client.messages.some((m) => m.id === unstored)),
        );
        // A steer's message moves the client's revision past `stored`'s last write.
        const runtimes = yield* ThreadRuntimes;
        yield* runtimes.steer(thread.id, { text: "and also" });
        yield* waitFor(
          "the steer",
          Effect.sync(() => JSON.stringify(client.messages).includes("and also")),
        );
        const store = yield* ThreadStore;
        const sql = yield* SqlClient.SqlClient;
        const [row] = yield* sql<{ rev: number }>`SELECT rev FROM messages WHERE id = ${stored}`;
        const atCrash = {
          message: (yield* store.getMessage(thread.id, stored))!,
          rowRev: Number(row!.rev),
          rev: (yield* store.feedRevision(thread.id))!.rev,
        };
        expect(atCrash.rowRev).toBeLessThan(atCrash.rev);
        return { threadId: thread.id, crashed: atCrash };
      }).pipe(Effect.scoped, Effect.provide(layerAt(file)));

      // A clean shutdown stores what was streaming; a crash leaves the rows as they were, which
      // is put back here: `stored` as far as its first part, and no `unstored` at all.
      const db = new DatabaseSync(file);
      db.prepare("UPDATE messages SET message = ?, rev = ? WHERE id = ?").run(
        JSON.stringify(crashed.message),
        crashed.rowRev,
        stored,
      );
      db.prepare("DELETE FROM messages WHERE id = ?").run(unstored);
      db.prepare("UPDATE threads SET feed_rev = ? WHERE id = ?").run(crashed.rev, threadId);
      db.close();

      yield* Effect.gen(function* () {
        const { afterRev } = yield* connect(client, threadId);
        expect(afterRev).toBeDefined();
        expect(client.heads.at(-1)!.type).toBe("resumed");
        const expected = yield* fresh(threadId);
        expect(client.messages).toEqual(expected);
        expect(idsOf(expected)).not.toContain(unstored);
        expect(JSON.stringify(expected)).toContain("kept");
        expect(JSON.stringify(expected)).not.toContain("lost");
      }).pipe(Effect.scoped, Effect.provide(layerAt(file)));
    }).pipe(Effect.scoped),
  );

  it.effect("an unknown, future or pre-rewind revision gets the full history", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const { thread, session } = yield* createRunning();
      yield* session.completeTurn("first");
      yield* waitIdle(thread.id);
      const { rev } = (yield* store.feedRevision(thread.id))!;

      expect((yield* runtimes.replay(thread.id, rev)).resumed).toBe(true);
      expect((yield* runtimes.replay(thread.id, rev + 1_000)).resumed).toBeUndefined();

      const [user] = yield* store.listMessages(thread.id);
      yield* store.truncateMessagesAfter(thread.id, user!.id);
      const after = yield* runtimes.replay(thread.id, rev);
      expect(after.resumed).toBeUndefined();
      expect(idsOf(after.messages)).toEqual([user!.id]);
      expect(after.rev).toBeGreaterThan(rev);
      expect((yield* runtimes.replay(thread.id, after.rev)).resumed).toBe(true);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("a resume too far behind gets the full history", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const { thread, session } = yield* createRunning();
      yield* session.completeTurn("first");
      yield* waitIdle(thread.id);
      const { rev } = (yield* store.feedRevision(thread.id))!;
      for (let i = 0; i < RESUME_MAX_MESSAGES; i++) {
        yield* store.upsertMessage(thread.id, {
          id: `note-${i}`,
          role: "assistant",
          parts: [{ type: "text", text: String(i) }],
        });
      }
      expect((yield* runtimes.replay(thread.id, rev)).resumed).toBe(true);
      yield* store.upsertMessage(thread.id, {
        id: "one-too-many",
        role: "assistant",
        parts: [{ type: "text", text: "!" }],
      });
      const full = yield* runtimes.replay(thread.id, rev);
      expect(full.resumed).toBeUndefined();
      expect(full.messages).toHaveLength(RESUME_MAX_MESSAGES + 3);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("opens on the recent turns, and pages back to the start without gaps", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const { thread, session } = yield* createRunning();
      yield* session.completeTurn("first");
      yield* waitIdle(thread.id);
      // Turns of a prompt, a reply and a note between, so a window starts on a user message.
      const turns = FEED_WINDOW_TURNS * 2 + 5;
      for (let i = 0; i < turns; i++) {
        for (const [id, role] of [
          [`u${i}`, "user"],
          [`a${i}`, "assistant"],
          [`n${i}`, "assistant"],
        ] as const) {
          yield* store.upsertMessage(thread.id, { id, role, parts: [{ type: "text", text: id }] });
        }
      }
      const all = yield* store.listMessages(thread.id);

      const head = yield* runtimes.replay(thread.id);
      expect(head.earlier).toBe(true);
      expect(head.messages).toEqual(recentTurns(all, FEED_WINDOW_TURNS).messages);
      expect(head.messages[0]!.role).toBe("user");
      expect(head.messages.filter((m) => m.role === "user")).toHaveLength(FEED_WINDOW_TURNS);

      let held = [...head.messages];
      let earlier = head.earlier === true;
      let pages = 0;
      while (earlier) {
        const page = yield* runtimes.history(thread.id, held[0]!.id);
        held = [...page.messages, ...held];
        earlier = page.earlier;
        pages++;
      }
      expect(held).toEqual(all);
      // The first turn ("one") and the generated ones, a window at a time.
      expect(pages).toBe(Math.ceil((turns + 1) / FEED_WINDOW_TURNS) - 1);
      expect(yield* runtimes.history(thread.id, "gone")).toEqual({ messages: [], earlier: false });

      // A resume leaves out changes to what the client doesn't hold.
      const { rev } = (yield* store.feedRevision(thread.id))!;
      yield* store.upsertMessage(thread.id, { ...all[1]!, parts: [{ type: "text", text: "old" }] });
      yield* store.upsertMessage(thread.id, {
        ...head.messages[1]!,
        parts: [{ type: "text", text: "new" }],
      });
      const resumed = yield* runtimes.replay(thread.id, rev, head.messages[0]!.id);
      expect(resumed.resumed).toBe(true);
      expect(idsOf(resumed.messages)).toEqual([head.messages[1]!.id]);
      expect((yield* runtimes.replay(thread.id, rev)).messages).toHaveLength(2);
      expect((yield* runtimes.replay(thread.id, rev, "gone")).resumed).toBeUndefined();
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );
});
