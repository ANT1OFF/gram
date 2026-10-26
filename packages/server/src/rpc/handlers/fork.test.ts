import { describe, expect, it } from "@effect/vitest";
import type { MessageId, GramUIMessage, Thread, ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { ServerConfig } from "../../config.ts";
import { gitPlatformTest } from "../../git/platform.ts";
// Real git runs inside the turn hooks, so these tests poll on wall-clock time, not scheduler yields.
import { eventually, hasGit, makeRepo, removeDir, tempDir } from "../../git/test-repo.ts";
import { GitTurnHooksLive } from "../../git/turn-hooks.ts";
import { ServerCore } from "../../http/server.ts";
import { ThreadStore } from "../../persistence/thread-store.ts";
import { FakeAgentAdapter, FakeAgentControl } from "../../runtime/fake-agent.ts";
import { TEST_CONFIG } from "../../runtime/test-harness.ts";
import { ThreadRuntimes } from "../../runtime/thread-runtimes.ts";
import { threadHandlers } from "./threads.ts";

const TestLayer = ServerCore.pipe(
  Layer.provideMerge(FakeAgentAdapter),
  Layer.provideMerge(GitTurnHooksLive),
  Layer.provideMerge(gitPlatformTest()),
  Layer.provideMerge(ServerConfig.layer(TEST_CONFIG)),
  Layer.orDie,
);

const tempRepo = Effect.gen(function* () {
  const dir = tempDir();
  yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dir)));
  return makeRepo(dir);
});

const message = (
  id: string,
  role: "user" | "assistant",
  text: string,
  agentMessageIds?: ReadonlyArray<string>,
): GramUIMessage => ({
  id,
  role,
  parts: [{ type: "text", text }],
  ...(agentMessageIds === undefined
    ? {}
    : { metadata: { createdAt: 0, agentMessageIds: [...agentMessageIds] } }),
});

/** A stored conversation with no open session, as after a restart or an idle eviction. */
const coldSource = (repo: string) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const project = yield* store.ensureProject({ root: repo, name: "repo" });
    const source: Thread = {
      id: randomUUID() as ThreadId,
      projectId: project.id,
      title: "Source",
      userNamed: true,
      model: { agent: "claude", model: "haiku" },
      mode: "acceptEdits",
      checkout: { kind: "main", path: repo, branch: "main" },
      agentSessionId: "source-session",
      codexHome: "gateway",
      labels: [],
      pinned: false,
      parked: false,
      unread: false,
      createdAt: 0,
      lastActivityAt: 0,
    };
    yield* store.insertThread(source);
    const messages = [
      message("u1", "user", "one", ["u1"]),
      message("a1", "assistant", "first", ["sdk-a1a", "sdk-a1b"]),
      message("u2", "user", "two", ["u2"]),
      message("a2", "assistant", "second", ["sdk-a2"]),
    ];
    for (const m of messages) yield* store.upsertMessage(source.id, m);
    return { source, messages };
  });

/** A live thread with two finished turns, each of which rewrote `notes.txt`. */
const twoTurns = (repo: string) =>
  Effect.gen(function* () {
    const file = nodePath.join(repo, "notes.txt");
    const runtimes = yield* ThreadRuntimes;
    const store = yield* ThreadStore;
    const fake = yield* FakeAgentControl;

    const thread = yield* runtimes.create({
      projectRoot: repo,
      checkout: { kind: "main", path: repo },
      input: { text: "one" },
    });
    const session = yield* eventually(
      "the first send",
      fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
    );
    fs.writeFileSync(file, "after turn one\n");
    yield* session.completeTurn("first");
    yield* eventually("idle", runtimes.status(thread.id).pipe(Effect.map((s) => s === "idle")));

    yield* runtimes.send(thread.id, { text: "two" });
    yield* eventually(
      "the second send",
      Effect.sync(() => session.sent.length === 2),
    );
    fs.writeFileSync(file, "after turn two\n");
    yield* session.completeTurn("second");
    yield* eventually("idle", runtimes.status(thread.id).pipe(Effect.map((s) => s === "idle")));
    return { thread, file, messages: yield* store.listMessages(thread.id) };
  });

/** The fork's first session, once a send reached it. */
const forkSession = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const fake = yield* FakeAgentControl;
    return yield* eventually(
      "the fork's session",
      Effect.sync(() =>
        fake.sessions.find((s) => s.options.threadId === threadId && s.sent.length),
      ),
    );
  });

describe.skipIf(!hasGit)("thread.fork", () => {
  it.live("forks at the latest message into the source checkout and forks the session lazily", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      const handlers = yield* threadHandlers;
      const repo = yield* tempRepo;
      const { source, messages } = yield* coldSource(repo);

      const fork = yield* handlers["thread.fork"]({ threadId: source.id });
      expect(fork).toMatchObject({
        title: "Fork of Source",
        userNamed: false,
        model: source.model,
        mode: source.mode,
        checkout: source.checkout,
        forkedFrom: { threadId: source.id, agentSessionId: "source-session", codexHome: "gateway" },
      });
      expect(fork.agentSessionId).toBeUndefined();
      const copied = yield* store.listMessages(fork.id);
      expect(copied.map((m) => [m.role, m.parts, m.metadata?.agentMessageIds])).toEqual(
        messages.map((m) => [m.role, m.parts, m.metadata?.agentMessageIds]),
      );
      expect(copied.filter((m) => messages.some((o) => o.id === m.id))).toEqual([]);
      expect((yield* store.listMessages(source.id)).map((m) => m.id)).toEqual(
        messages.map((m) => m.id),
      );
      expect(fake.sessions).toEqual([]);

      yield* runtimes.send(fork.id, { text: "three" });
      const session = yield* forkSession(fork.id);
      // The fork runs in its source session's Codex home.
      expect(session.options).toMatchObject({
        resumeId: "source-session",
        fork: true,
        resumeAt: "sdk-a2",
        codexHome: "gateway",
      });
      expect(session.agentSessionId).not.toBe("source-session");
      yield* eventually(
        "the fork's own agent session id",
        store
          .getThread(fork.id)
          .pipe(Effect.map((t) => t.agentSessionId === session.agentSessionId)),
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.live("forks at a mid message and refuses a message the agent can't resume at", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const runtimes = yield* ThreadRuntimes;
      const handlers = yield* threadHandlers;
      const repo = yield* tempRepo;
      const { source, messages } = yield* coldSource(repo);

      const fork = yield* handlers["thread.fork"]({
        threadId: source.id,
        fromMessageId: "a1" as MessageId,
        title: "Try again",
      });
      expect(fork).toMatchObject({ title: "Try again", userNamed: true });
      expect((yield* store.listMessages(fork.id)).map((m) => m.parts)).toEqual(
        messages.slice(0, 2).map((m) => m.parts),
      );
      yield* runtimes.send(fork.id, { text: "again" });
      expect((yield* forkSession(fork.id)).options).toMatchObject({
        resumeId: "source-session",
        fork: true,
        resumeAt: "sdk-a1b",
      });

      yield* store.upsertMessage(source.id, message("a3", "assistant", "no agent ids"));
      const error = yield* handlers["thread.fork"]({ threadId: source.id }).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "InvalidState",
        message: "the agent can't resume at that message",
      });
    }).pipe(Effect.provide(TestLayer)),
  );

  it.live("forks into a new worktree with the fork point's files", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const handlers = yield* threadHandlers;
      const repo = yield* tempRepo;
      const { thread, file, messages } = yield* twoTurns(repo);

      const fork = yield* handlers["thread.fork"]({
        threadId: thread.id,
        fromMessageId: messages[1]!.id as MessageId,
        checkout: { kind: "newWorktree", branch: "fork-one" },
      });
      expect(fork.checkout).toMatchObject({ kind: "worktree", branch: "fork-one", repoRoot: repo });
      expect(fs.readFileSync(nodePath.join(fork.checkout.path, "notes.txt"), "utf8")).toBe(
        "after turn one\n",
      );
      expect(fs.readFileSync(file, "utf8")).toBe("after turn two\n");
      expect((yield* store.listMessages(fork.id)).map((m) => m.role)).toEqual([
        "user",
        "assistant",
      ]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.live("refuses to fork while a turn is running", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      const handlers = yield* threadHandlers;
      const repo = yield* tempRepo;
      const thread = yield* runtimes.create({
        projectRoot: repo,
        checkout: { kind: "main", path: repo },
        input: { text: "one" },
      });
      yield* eventually(
        "the first send",
        fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1)),
      );

      const error = yield* handlers["thread.fork"]({ threadId: thread.id }).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "InvalidState",
        message: "can't fork while the agent is working",
      });
      expect((yield* store.listThreads).map((t) => t.id)).toEqual([thread.id]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.live("refuses to share a checkout that has an open session", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const handlers = yield* threadHandlers;
      const repo = yield* tempRepo;
      const { thread } = yield* twoTurns(repo);

      const error = yield* handlers["thread.fork"]({ threadId: thread.id }).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "InvalidState",
        message: "Fork into a new worktree: the source checkout is in use",
      });
      expect((yield* store.listThreads).map((t) => t.id)).toEqual([thread.id]);
    }).pipe(Effect.provide(TestLayer)),
  );
});
