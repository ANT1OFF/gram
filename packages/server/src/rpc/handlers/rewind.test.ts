import { describe, expect, it } from "@effect/vitest";
import type { MessageId, ThreadFeedEvent, ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { EventHub } from "../../events/event-hub.ts";
import { gitPlatformTest } from "../../git/platform.ts";
// Real git runs inside the turn hooks, so these tests poll on wall-clock time, not scheduler yields.
import { eventually, hasGit, makeRepo, removeDir, tempDir } from "../../git/test-repo.ts";
import { GitTurnHooksLive } from "../../git/turn-hooks.ts";
import { ThreadStore } from "../../persistence/thread-store.ts";
import { FakeAgentControl } from "../../runtime/fake-agent.ts";
import { makeRuntimeTestLayer } from "../../runtime/test-harness.ts";
import { ThreadRuntimes } from "../../runtime/thread-runtimes.ts";
import { threadHandlers } from "./threads.ts";

const platform = gitPlatformTest();
const TestLayer = Layer.merge(
  makeRuntimeTestLayer(GitTurnHooksLive.pipe(Layer.provide(platform))),
  platform,
);

const waitIdle = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    yield* eventually("idle", runtimes.status(threadId).pipe(Effect.map((s) => s === "idle")));
  });

/** A thread with two finished turns, each of which rewrote `notes.txt`. */
const twoTurns = (agent: "claude" | "codex" = "claude") =>
  Effect.gen(function* () {
    const dir = tempDir();
    yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dir)));
    const repo = makeRepo(dir);
    const file = nodePath.join(repo, "notes.txt");
    const runtimes = yield* ThreadRuntimes;
    const store = yield* ThreadStore;
    const fake = yield* FakeAgentControl;

    const thread = yield* runtimes.create({
      projectRoot: repo,
      checkout: { kind: "main", path: repo },
      model: { agent, model: "invented-local" },
      input: { text: "one" },
    });
    const session = yield* eventually(
      "the first send",
      fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
    );
    fs.writeFileSync(file, "after turn one\n");
    yield* session.completeTurn("first");
    yield* waitIdle(thread.id);

    yield* runtimes.send(thread.id, { text: "two" });
    yield* eventually(
      "the second send",
      Effect.sync(() => session.sent.length === 2),
    );
    fs.writeFileSync(file, "after turn two\n");
    yield* session.completeTurn("second");
    yield* waitIdle(thread.id);

    const messages = yield* store.listMessages(thread.id);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    return { thread, session, file, messages };
  });

const resumedSession = Effect.gen(function* () {
  const fake = yield* FakeAgentControl;
  return yield* eventually(
    "the resumed session",
    Effect.sync(() => fake.sessions.length === 2 && fake.sessions[1]),
  );
});

describe.skipIf(!hasGit)("thread.rewind", () => {
  it.live("Codex keeps supported checkpoint restore and session resume", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const handlers = yield* threadHandlers;
      const { thread, session, file, messages } = yield* twoTurns("codex");
      yield* handlers["thread.rewind"]({
        threadId: thread.id,
        toMessageId: messages[1]!.id as MessageId,
        files: true,
      });
      expect(fs.readFileSync(file, "utf8")).toBe("after turn one\n");
      expect(yield* store.listMessages(thread.id)).toEqual(messages.slice(0, 2));
      const resumed = yield* resumedSession;
      expect(resumed.options).toMatchObject({
        model: { agent: "codex" },
        resumeId: session.agentSessionId,
        resumeAt: `sdk-${messages[1]!.id}`,
      });
      yield* waitIdle(thread.id);
    }).pipe(Effect.provide(TestLayer)),
  );
  it.live("to an assistant message keeps it, restores the turn's end and resumes at it", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const hub = yield* EventHub;
      const runtimes = yield* ThreadRuntimes;
      const handlers = yield* threadHandlers;
      const { thread, session, file, messages } = yield* twoTurns();
      const [user1, reply1] = messages;

      const feed: Array<ThreadFeedEvent> = [];
      yield* Effect.forkScoped(
        Stream.runForEach(hub.threadFeed(thread.id, runtimes.replay(thread.id)), (e) =>
          Effect.sync(() => void feed.push(e)),
        ),
      );
      yield* eventually(
        "caught up",
        Effect.sync(() => feed.some((e) => e.type === "caughtUp")),
      );

      yield* handlers["thread.rewind"]({
        threadId: thread.id,
        toMessageId: reply1!.id as MessageId,
        files: true,
      });

      expect(fs.readFileSync(file, "utf8")).toBe("after turn one\n");
      const kept = [user1!.id, reply1!.id];
      expect((yield* store.listMessages(thread.id)).map((m) => m.id)).toEqual(kept);
      const replacedAt = feed.findLastIndex((e) => e.type === "messages");
      const replaced = feed[replacedAt];
      expect(replaced?.type === "messages" ? replaced.messages.map((m) => m.id) : []).toEqual(kept);
      // Like a fresh subscribe: the replacement is followed by `caughtUp`.
      expect(feed[replacedAt + 1]).toEqual({ type: "caughtUp", rev: expect.any(Number) });

      const resumed = yield* resumedSession;
      expect(session.closed).toBe(true);
      expect(resumed.options).toMatchObject({
        resumeId: session.agentSessionId,
        resumeAt: `sdk-${reply1!.id}`,
      });
      yield* waitIdle(thread.id);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.live("to a user message drops it, restores the turn's start and resumes before it", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const handlers = yield* threadHandlers;
      const { thread, session, file, messages } = yield* twoTurns();
      const [user1, reply1, user2] = messages;
      expect(user2!.metadata?.agentMessageIds).toEqual([user2!.id]);

      yield* handlers["thread.rewind"]({
        threadId: thread.id,
        toMessageId: user2!.id as MessageId,
        files: true,
      });

      expect(fs.readFileSync(file, "utf8")).toBe("after turn one\n");
      expect((yield* store.listMessages(thread.id)).map((m) => m.id)).toEqual([
        user1!.id,
        reply1!.id,
      ]);
      const resumed = yield* resumedSession;
      expect(resumed.options).toMatchObject({
        resumeId: session.agentSessionId,
        resumeAt: `sdk-${reply1!.id}`,
      });
    }).pipe(Effect.provide(TestLayer)),
  );

  it.live("to the first user message starts a fresh agent session", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const handlers = yield* threadHandlers;
      const { thread, messages } = yield* twoTurns();

      yield* handlers["thread.rewind"]({
        threadId: thread.id,
        toMessageId: messages[0]!.id as MessageId,
        files: false,
      });

      expect(yield* store.listMessages(thread.id)).toEqual([]);
      const resumed = yield* resumedSession;
      expect(resumed.options.resumeId).toBeUndefined();
      expect(resumed.options.resumeAt).toBeUndefined();
      yield* waitIdle(thread.id);
      expect((yield* store.getThread(thread.id)).agentSessionId).toBe(resumed.agentSessionId);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.live("refuses to rewind while a turn is running", () =>
    Effect.gen(function* () {
      const dir = tempDir();
      yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dir)));
      const repo = makeRepo(dir);
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const fake = yield* FakeAgentControl;
      const handlers = yield* threadHandlers;
      const thread = yield* runtimes.create({
        projectRoot: repo,
        checkout: { kind: "main", path: repo },
        input: { text: "one" },
      });
      yield* eventually(
        "the first send",
        fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1)),
      );
      const [user] = yield* store.listMessages(thread.id);
      const error = yield* handlers["thread.rewind"]({
        threadId: thread.id,
        toMessageId: user!.id as MessageId,
        files: false,
      }).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "InvalidState" });
    }).pipe(Effect.provide(TestLayer)),
  );
});
