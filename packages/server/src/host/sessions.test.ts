import { describe, expect, it } from "@effect/vitest";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import type { AgentHost, AgentSession, OpenSessionOptions } from "@gram/agents";
import {
  type AgentEvent,
  type AgentKind,
  AgentUnavailable,
  HOST_PROTOCOL_VERSION,
  LOCAL_HOST_ID,
  type ProfileId,
  type RequestId,
  type ThreadId,
} from "@gram/contracts";
import { Proc, ProcLive, Worktrees, WorktreesLive } from "@gram/git";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { agentHostThroughHost, HOST_STOPPED_ENDED } from "../runtime/host-agent-sessions.ts";
import { filesOn } from "./files.ts";
import { gitOn } from "./git.ts";
import { connectHost, HOST_CAPABILITIES, serveHost } from "./protocol.ts";
import { sessionsOnHost } from "./sessions.ts";
import { terminalsOnHost } from "./terminals.ts";
import { streamPair } from "./test-stream.ts";

const THREAD = "thread-on-the-host" as ThreadId;
const CAPABILITIES = {
  modes: ["default"],
  models: [],
} as unknown as AgentHost["capabilities"];

/** A scripted agent: what each session was opened with and asked, and its events to emit. */
const scriptedAgent = (kind: AgentKind, where: string) =>
  Effect.gen(function* () {
    const calls: Array<string> = [];
    const opened: Array<OpenSessionOptions> = [];
    const closed: Array<string> = [];
    const events = yield* Queue.unbounded<AgentEvent, Cause.Done>();
    /** When set, an open waits on it. */
    const gate: { open?: Deferred.Deferred<void> } = {};
    const host: AgentHost = {
      kind,
      capabilities: CAPABILITIES,
      listModels: () => Effect.succeed([]),
      open: (options) =>
        Effect.gen(function* () {
          if (gate.open !== undefined) yield* Deferred.await(gate.open);
          opened.push(options);
          calls.push(`${where}: open`);
          yield* Effect.addFinalizer(() => Effect.sync(() => void closed.push(where)));
          options.onConnectorsSeen?.({
            detailed: true,
            whole: false,
            connectors: [{ name: "docs", status: "connected" }],
          });
          const session: AgentSession = {
            events: Stream.fromQueue(events),
            send: (input) => Effect.sync(() => void calls.push(`send ${input.text}`)),
            steer: (input) => Effect.sync(() => void calls.push(`steer ${input.text}`)),
            interrupt: Effect.sync(() => void calls.push("interrupt")),
            respond: (requestId) => Effect.sync(() => void calls.push(`respond ${requestId}`)),
            setMode: (mode) => Effect.sync(() => void calls.push(`mode ${mode}`)),
            setModel: (model) => Effect.sync(() => void calls.push(`model ${model.model}`)),
            stopTask: (taskId) => Effect.succeed(taskId === "running"),
            processId: Effect.succeed(4242),
            connectors: {
              status: Effect.succeed([{ name: "docs", status: "connected" }]),
              reconnect: () => Effect.void,
              setEnabled: () => Effect.succeed("applied"),
              allowlist: ["docs"],
            },
          };
          return session;
        }),
    };
    return { host, calls, opened, closed, events, gate };
  });

/** A host process's sessions over a real stream, and the server's agent routed through it. */
const routed = Effect.gen(function* () {
  const onHost = yield* scriptedAgent("claude", "host");
  const inServer = yield* scriptedAgent("claude", "server");
  const { host: hostEnd, control } = yield* streamPair;
  const hostSocket = yield* NodeSocket.fromDuplex(Effect.succeed(hostEnd));
  yield* Effect.forkScoped(
    serveHost(hostSocket, {
      hello: {
        protocol: HOST_PROTOCOL_VERSION,
        hostId: LOCAL_HOST_ID,
        capabilities: HOST_CAPABILITIES,
        platform: process.platform,
        pid: 1,
      },
      files: filesOn(yield* Proc),
      worktrees: yield* Worktrees,
      git: gitOn(yield* Proc),
      terminals: yield* terminalsOnHost,
      sessions: yield* sessionsOnHost((agent) =>
        agent === "claude"
          ? Effect.succeed(onHost.host)
          : Effect.fail(new AgentUnavailable({ agent, message: "not here" })),
      ),
      scan: Effect.succeed({ listening: new Map(), children: new Map() }),
    }),
  );
  const connection = yield* connectHost(yield* NodeSocket.fromDuplex(Effect.succeed(control)));
  const agent = agentHostThroughHost(connection.sessions, connection.gone, inServer.host);
  return { onHost, inServer, agent, connection, hostEnd };
});

const MCP = {
  url: "http://127.0.0.1:1/mcp",
  headers: { authorization: "Bearer t" },
};

const eventually = <A>(check: () => A | undefined, label: string) =>
  Effect.gen(function* () {
    for (let i = 0; i < 400; i++) {
      const value = check();
      if (value !== undefined) return value;
      yield* Effect.sleep("10 millis");
    }
    return yield* Effect.die(new Error(`timed out waiting for ${label}`));
  });

const layer = Layer.mergeAll(WorktreesLive.pipe(Layer.provideMerge(ProcLive)));

describe("agent sessions through the host process", () => {
  it.live("opens a Claude session on the host, its calls and events crossing in order", () =>
    Effect.gen(function* () {
      const { onHost, inServer, agent } = yield* routed;
      const seen: Array<string> = [];
      const session = yield* agent.open({
        threadId: THREAD,
        cwd: "/work",
        mcp: MCP,
        outwardGate: "irreversible",
        onConnectorsSeen: (report) => void seen.push(report.connectors[0]!.name),
      });
      expect(inServer.opened).toEqual([]);
      const options = onHost.opened[0]!;
      expect(options.cwd).toBe("/work");
      expect(options.mcp).toEqual(MCP);
      expect(options.outwardGate).toBe("irreversible");
      expect(options.appTools).toBeUndefined();

      yield* session.send({ text: "hello" });
      yield* session.steer({ text: "and this" });
      yield* session.respond("r1" as RequestId, {
        kind: "approval",
        decision: "allow",
        scope: "once",
      });
      yield* session.setMode("plan");
      yield* session.setModel({ agent: "claude", model: "opus" });
      yield* session.interrupt;
      expect(onHost.calls.slice(1)).toEqual([
        "send hello",
        "steer and this",
        "respond r1",
        "mode plan",
        "model opus",
        "interrupt",
      ]);
      expect(yield* session.stopTask!("running")).toBe(true);
      expect(yield* session.processId!).toBe(4242);
      expect(session.closeToolGate).toBeUndefined();
      expect(session.connectors?.allowlist).toEqual(["docs"]);
      expect(yield* session.connectors!.status).toEqual([{ name: "docs", status: "connected" }]);
      yield* eventually(() => (seen.length > 0 ? true : undefined), "connectors seen");
      expect(seen).toEqual(["docs"]);

      const collected = yield* Effect.forkScoped(Stream.runCollect(session.events));
      for (let i = 0; i < 5; i++) {
        yield* Queue.offer(onHost.events, {
          type: "notice",
          level: "info",
          message: `n${i}`,
        });
      }
      yield* Queue.end(onHost.events);
      const events = yield* Fiber.join(collected);
      expect(events.map((event) => (event.type === "notice" ? event.message : event.type))).toEqual(
        ["n0", "n1", "n2", "n3", "n4"],
      );
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("closes the host's session with the caller's scope", () =>
    Effect.gen(function* () {
      const { onHost, agent } = yield* routed;
      const scope = yield* Scope.make();
      yield* agent.open({ threadId: THREAD, cwd: "/work" }).pipe(Scope.provide(scope));
      expect(onHost.closed).toEqual([]);
      yield* Scope.close(scope, Exit.void);
      yield* eventually(() => (onHost.closed.length > 0 ? true : undefined), "the host's close");
      expect(onHost.closed).toEqual(["host"]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("closes a session whose open the caller gave up on", () =>
    Effect.gen(function* () {
      const { onHost, agent } = yield* routed;
      onHost.gate.open = yield* Deferred.make<void>();
      const opening = yield* Effect.forkScoped(
        agent.open({ threadId: THREAD, cwd: "/work" }).pipe(Effect.scoped),
      );
      yield* Effect.sleep("100 millis");
      yield* Fiber.interrupt(opening);
      yield* Deferred.succeed(onHost.gate.open, undefined);
      yield* Effect.sleep("200 millis");
      // Interrupted while it waited, so the agent never opened, and nothing is left open.
      expect(onHost.opened).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("keeps what can't cross in the server", () =>
    Effect.gen(function* () {
      const { onHost, inServer, agent } = yield* routed;
      const appTools = { forThread: () => [], forSession: () => [] };
      yield* agent
        .open({
          threadId: THREAD,
          cwd: "/a",
          model: { agent: "claude", model: "m", profileId: "p" as ProfileId },
        })
        .pipe(Effect.scoped);
      yield* agent.open({ threadId: THREAD, cwd: "/b", audience: "dream" }).pipe(Effect.scoped);
      yield* agent.open({ threadId: THREAD, cwd: "/c", appTools }).pipe(Effect.scoped);
      yield* agent.open({ threadId: THREAD, cwd: "/d", switchStartup: "s" }).pipe(Effect.scoped);
      expect(inServer.opened.map((o) => o.cwd)).toEqual(["/a", "/b", "/c", "/d"]);
      expect(onHost.opened).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("ends a session whose host went, and opens the next one in the server", () =>
    Effect.gen(function* () {
      const { onHost, inServer, agent, connection, hostEnd } = yield* routed;
      const session = yield* agent.open({ threadId: THREAD, cwd: "/work" });
      const collected = yield* Effect.forkScoped(Stream.runCollect(session.events));
      yield* Queue.offer(onHost.events, {
        type: "notice",
        level: "info",
        message: "before",
      });
      yield* Effect.sleep("100 millis");
      hostEnd.destroy();
      const events = yield* Fiber.join(collected);
      expect(events.at(-1)).toEqual(HOST_STOPPED_ENDED);
      yield* eventually(() => (connection.gone() ? true : undefined), "the host to count as gone");
      yield* agent.open({ threadId: THREAD, cwd: "/after" }).pipe(Effect.scoped);
      expect(inServer.opened.map((o) => o.cwd)).toEqual(["/after"]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});

describe("a host's session events", () => {
  it.live("are kept until confirmed, so a new subscription picks up after the last confirmed", () =>
    Effect.gen(function* () {
      const agent = yield* scriptedAgent("claude", "host");
      const sessions = yield* sessionsOnHost(() => Effect.succeed(agent.host));
      yield* sessions.open({
        handle: "h",
        agent: "claude",
        threadId: THREAD,
        cwd: "/work",
      });
      for (let i = 1; i <= 4; i++) {
        yield* Queue.offer(agent.events, {
          type: "notice",
          level: "info",
          message: `n${i}`,
        });
      }
      const first = yield* Stream.runCollect(Stream.take(sessions.events("h", 0), 3));
      expect(first.map((e) => e.seq)).toEqual([1, 2, 3]);
      yield* sessions.ack("h", 2);
      const again = yield* Stream.runCollect(Stream.take(sessions.events("h", 0), 2));
      expect(again.map((e) => e.seq)).toEqual([3, 4]);
      yield* sessions.close("h");
      expect(agent.closed).toEqual(["host"]);
      // A closed handle is gone, and an open under a handle closed first is refused.
      const after = yield* Effect.exit(Stream.runCollect(sessions.events("h", 0)));
      expect(Exit.isFailure(after)).toBe(true);
      yield* sessions.close("early");
      const early = yield* Effect.exit(
        sessions.open({
          handle: "early",
          agent: "claude",
          threadId: THREAD,
          cwd: "/work",
        }),
      );
      expect(Exit.isFailure(early)).toBe(true);
      expect(agent.opened).toHaveLength(1);
    }).pipe(Effect.scoped),
  );
});
