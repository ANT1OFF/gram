import { describe, expect, it } from "@effect/vitest";
import type { ServerEvent, ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { AppToolRegistry, defineAppTool } from "../app-tools/registry.ts";
import { ServerConfig } from "../config.ts";
import { EventHub } from "../events/event-hub.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FAKE_CAPABILITIES, FakeAgentControl, makeFakeAgentAdapter } from "./fake-agent.ts";
import { CheckoutService, TurnHooks } from "./hooks.ts";
import { TEST_CONFIG, waitFor } from "./test-harness.ts";
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

const recordEvents = Effect.gen(function* () {
  const hub = yield* EventHub;
  const events: Array<ServerEvent> = [];
  yield* Effect.forkScoped(
    Stream.runForEach(
      hub.serverEvents(Effect.succeed<ServerEvent>({ type: "threads.snapshot", threads: [] })),
      (e) => Effect.sync(() => void events.push(e)),
    ),
  );
  yield* waitFor(
    "the subscription",
    Effect.sync(() => events.length > 0),
  );
  return events;
});

const replies = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const messages = yield* store.listMessages(threadId);
    return messages.filter((m) => m.role === "assistant");
  });

describe("fake agent echo replies", () => {
  it.effect("completes each turn with a streamed echo, agent ids and usage", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const events = yield* recordEvents;
      const thread = yield* runtimes.create({
        projectRoot: "/work/repo",
        checkout: { kind: "main", path: "/work/repo" },
        input: { text: "hello" },
      });
      const [reply] = yield* waitFor(
        "the echo reply",
        replies(thread.id).pipe(Effect.map((r) => r.length === 1 && r)),
      );
      yield* waitFor("idle", runtimes.status(thread.id).pipe(Effect.map((s) => s === "idle")));

      expect(reply!.parts).toEqual([{ type: "text", text: "echo: hello", state: "done" }]);
      expect(reply!.metadata?.agentMessageIds).toHaveLength(2);
      expect(events.some((e) => e.type === "thread.usage" && e.threadId === thread.id)).toBe(true);

      // A second prompt queued while running is sent after the first echo finishes.
      yield* runtimes.send(thread.id, { text: "again" });
      const twice = yield* waitFor(
        "the second echo",
        replies(thread.id).pipe(Effect.map((r) => r.length === 2 && r)),
      );
      expect(twice[1]!.parts).toMatchObject([{ type: "text", text: "echo: again" }]);
    }).pipe(Effect.provide(EchoLayer)),
  );

  it.effect("asks for approval on /approve and finishes the reply after the answer", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const thread = yield* runtimes.create({
        projectRoot: "/work/repo",
        checkout: { kind: "main", path: "/work/repo" },
        input: { text: "run it /approve" },
      });
      yield* waitFor(
        "the approval",
        runtimes.status(thread.id).pipe(Effect.map((s) => s === "needsApproval")),
      );
      const [request] = yield* store.listRequests(thread.id);
      expect(request).toMatchObject({ kind: "approval", toolName: "Bash" });
      expect(yield* replies(thread.id)).toEqual([]);

      yield* runtimes.respond(thread.id, request!.id, {
        kind: "approval",
        decision: "allow",
        scope: "once",
      });
      const [reply] = yield* waitFor(
        "the reply after approval",
        replies(thread.id).pipe(Effect.map((r) => r.length === 1 && r)),
      );
      expect(reply!.parts).toMatchObject([{ type: "text", text: "echo: run it /approve" }]);
      yield* waitFor("idle", runtimes.status(thread.id).pipe(Effect.map((s) => s === "idle")));
    }).pipe(Effect.provide(EchoLayer)),
  );
  it.effect("keeps a card whose answer didn't reach the agent, to be answered again", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const fake = yield* FakeAgentControl;
      const thread = yield* runtimes.create({
        projectRoot: "/work/repo",
        checkout: { kind: "main", path: "/work/repo" },
        input: { text: "run it /approve" },
      });
      yield* waitFor(
        "the approval",
        runtimes.status(thread.id).pipe(Effect.map((s) => s === "needsApproval")),
      );
      const [request] = yield* store.listRequests(thread.id);
      const allow = { kind: "approval", decision: "allow", scope: "once" } as const;

      yield* fake.setRespondFailure("Codex didn't take the approval: HTTP 503");
      const refused = yield* Effect.flip(runtimes.respond(thread.id, request!.id, allow));
      expect(refused).toMatchObject({
        _tag: "InvalidState",
        message: "Codex didn't take the approval: HTTP 503",
      });
      expect(yield* store.listRequests(thread.id)).toEqual([request]);
      expect(yield* runtimes.status(thread.id)).toBe("needsApproval");

      yield* fake.setRespondFailure(undefined);
      yield* runtimes.respond(thread.id, request!.id, allow);
      expect(yield* store.listRequests(thread.id)).toEqual([]);
      const [reply] = yield* waitFor(
        "the reply after approval",
        replies(thread.id).pipe(Effect.map((r) => r.length === 1 && r)),
      );
      expect(reply!.parts).toMatchObject([{ type: "text", text: "echo: run it /approve" }]);
    }).pipe(Effect.provide(EchoLayer)),
  );
});

const create = (text: string) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    return yield* runtimes.create({
      projectRoot: "/work/repo",
      checkout: { kind: "main", path: "/work/repo" },
      input: { text },
    });
  });

const idle = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    yield* waitFor("idle", runtimes.status(threadId).pipe(Effect.map((s) => s === "idle")));
  });

const replyTexts = (threadId: ThreadId) =>
  replies(threadId).pipe(
    Effect.map((messages) =>
      messages.map((m) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("")),
    ),
  );

describe("fake agent /call", () => {
  it.effect("runs an app tool that calls back into the runtime, and echoes its result", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const registry = yield* AppToolRegistry;
      // Queues a message on the calling thread, which takes the lock `send` is holding.
      yield* registry.register([
        defineAppTool({
          descriptor: { name: "nudge_self", class: "self", description: "Queue a follow-up." },
          input: Schema.Struct({ text: Schema.String }),
          handle: (threadId, { text }) =>
            runtimes.send(threadId, { text }).pipe(Effect.as({ queued: text }), Effect.orDie),
        }),
      ]);

      const thread = yield* create('/call set_title {"title":"Named by the agent"}');
      yield* waitFor(
        "the tool's reply",
        replyTexts(thread.id).pipe(Effect.map((r) => r.length === 1)),
      );
      expect(yield* replyTexts(thread.id)).toEqual([
        'echo: set_title → {"title":"Named by the agent","applied":true}',
      ]);
      expect((yield* store.getThread(thread.id)).title).toBe("Named by the agent");
      yield* idle(thread.id);

      yield* runtimes.send(thread.id, { text: 'please /call nudge_self {"text":"from the tool"}' });
      yield* waitFor(
        "the queued follow-up's echo",
        replyTexts(thread.id).pipe(Effect.map((r) => r.length === 3)),
      );
      expect((yield* replyTexts(thread.id)).slice(1)).toEqual([
        'echo: nudge_self → {"queued":"from the tool"}',
        "echo: from the tool",
      ]);
    }).pipe(Effect.provide(EchoLayer)),
  );

  it.effect("reports an unknown tool, bad JSON, bad input and a tool's own failure", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const thread = yield* create("/call no_such_tool {}");
      const expectReply = (n: number) =>
        waitFor("the reply", replyTexts(thread.id).pipe(Effect.map((r) => r.length === n && r)));
      expect((yield* expectReply(1))[0]).toBe(
        "echo: no_such_tool → error: unknown tool no_such_tool",
      );
      yield* idle(thread.id);
      yield* runtimes.send(thread.id, { text: "/call set_title {not json" });
      expect((yield* expectReply(2))[1]).toBe("echo: set_title → error: the input isn't JSON");
      yield* idle(thread.id);
      yield* runtimes.send(thread.id, { text: "/call set_title" });
      expect((yield* expectReply(3))[2]).toMatch(/^echo: set_title → error: Invalid input: /);
      yield* idle(thread.id);
      yield* runtimes.send(thread.id, { text: '/call dismiss_task {"taskId":"nope"}' });
      expect((yield* expectReply(4))[3]).toBe("echo: dismiss_task → error: unknown task nope");
    }).pipe(Effect.provide(EchoLayer)),
  );

  it.effect("gets the registry's card when the tool or its class asks, as on Claude", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const registry = yield* AppToolRegistry;
      const ran: Array<string> = [];
      const counted = (
        name: string,
        toolClass: "self" | "crossThread",
        needsApproval?: (label: string) => boolean,
      ) =>
        defineAppTool({
          descriptor: { name, class: toolClass, description: `${name} tool` },
          input: Schema.Struct({ label: Schema.String }),
          handle: (_, { label }) => Effect.sync(() => ({ ran: ran.push(`${name}:${label}`) })),
          describe: (_, { label }) => Effect.succeed(`Run ${name} for ${label}`),
          ...(needsApproval === undefined
            ? {}
            : { needsApproval: (_, { label }) => Effect.succeed(needsApproval(label)) }),
        });
      yield* registry.register([
        counted("budgeted", "self", (label) => label === "over"),
        counted("delegable", "crossThread", (label) => label !== "mine"),
        counted("reaching", "crossThread"),
      ]);
      const thread = yield* create('/call budgeted {"label":"under"}');
      const expectReply = (n: number) =>
        waitFor("the reply", replyTexts(thread.id).pipe(Effect.map((r) => r.length === n && r)));
      const answer = (decision: "allow" | "deny") =>
        Effect.gen(function* () {
          yield* waitFor(
            "the approval",
            runtimes.status(thread.id).pipe(Effect.map((s) => s === "needsApproval")),
          );
          const [request] = yield* store.listRequests(thread.id);
          yield* runtimes.respond(thread.id, request!.id, {
            kind: "approval",
            decision,
            scope: "once",
          });
          return request!;
        });

      // `false` from the tool: no card, whatever the class.
      expect((yield* expectReply(1))[0]).toBe('echo: budgeted → {"ran":1}');
      yield* idle(thread.id);
      yield* runtimes.send(thread.id, { text: '/call delegable {"label":"mine"}' });
      expect((yield* expectReply(2))[1]).toBe('echo: delegable → {"ran":2}');
      yield* idle(thread.id);

      // `true` from a tool whose class has no card: one card, for this call only.
      yield* runtimes.send(thread.id, { text: '/call budgeted {"label":"over"}' });
      expect(yield* answer("allow")).toMatchObject({
        kind: "approval",
        toolName: "mcp__gram__budgeted",
        displayName: "budgeted",
        input: { label: "over" },
        description: "Run budgeted for over",
        scopes: ["once"],
      });
      expect((yield* expectReply(3))[2]).toBe('echo: budgeted → {"ran":3}');
      yield* idle(thread.id);

      // No answer from the tool: the class asks, and a denial doesn't run it.
      yield* runtimes.send(thread.id, { text: '/call reaching {"label":"x"}' });
      expect(yield* answer("deny")).toMatchObject({ scopes: ["once", "session"] });
      expect((yield* expectReply(4))[3]).toBe(
        "echo: reaching → error: The user declined reaching.",
      );
      expect(ran).toEqual(["budgeted:under", "delegable:mine", "budgeted:over"]);
      yield* idle(thread.id);
    }).pipe(Effect.provide(EchoLayer)),
  );

  it.effect("records what the session was opened with, and scripts a tool call", () =>
    Effect.gen(function* () {
      const control = yield* FakeAgentControl;
      const store = yield* ThreadStore;
      const thread = yield* create("hello");
      yield* idle(thread.id);
      const session = yield* control.latest(thread.id);
      expect(session.options).toMatchObject({ threadId: thread.id, cwd: "/work/repo" });
      expect(session.options.appTools).toBeDefined();
      expect(yield* session.callTool("set_title", { title: "Scripted" })).toEqual({
        title: "Scripted",
        applied: true,
      });
      expect((yield* store.getThread(thread.id)).title).toBe("Scripted");
      expect(yield* Effect.flip(session.callTool("no_such_tool", {}))).toMatchObject({
        _tag: "AppToolError",
        message: "unknown tool no_such_tool",
      });
    }).pipe(Effect.provide(EchoLayer)),
  );
});

describe("thread summaries", () => {
  it.effect("carry the agent's capabilities for cold threads without a session", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const project = yield* store.ensureProject({ root: "/work/repo", name: "repo" });
      yield* store.insertThread({
        id: "cold-thread" as ThreadId,
        projectId: project.id,
        title: "cold",
        userNamed: false,
        model: { agent: "claude", model: "default" },
        mode: "default",
        checkout: { kind: "main", path: "/work/repo" },
        labels: [],
        pinned: false,
        parked: false,
        unread: false,
        createdAt: 1,
        lastActivityAt: 1,
      });
      const [summary] = yield* runtimes.snapshot;
      expect(summary).toMatchObject({ status: "cold", capabilities: FAKE_CAPABILITIES });
    }).pipe(Effect.provide(EchoLayer)),
  );
});
