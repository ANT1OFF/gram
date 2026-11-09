import { describe, expect, it } from "@effect/vitest";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import type { AgentHost, AgentSession, OpenSessionOptions, RemoteAppTools } from "@gram/agents";
import {
  type AgentEvent,
  type AgentKind,
  AgentUnavailable,
  HostFailed,
  HostId,
  HOST_PROTOCOL_VERSION,
  HostUnavailable,
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
import {
  agentHostOnMachine,
  agentHostThroughHost,
  HOST_STOPPED_ENDED,
} from "../runtime/host-agent-sessions.ts";
import { isUndelivered } from "../runtime/undelivered.ts";
import { filesOn } from "./files.ts";
import { reposOn } from "./repos.ts";
import { gitOn } from "./git.ts";
import { followingSessions } from "./following-sessions.ts";
import {
  connectHost,
  HOST_CAPABILITIES,
  HOST_SERVES,
  type HostConnection,
  type HostSessionsConnection,
  serveHost,
} from "./protocol.ts";
import { sessionsOnHost } from "./sessions.ts";
import { terminalsOnHost } from "./terminals.ts";
import { streamPair } from "./test-stream.ts";

const THREAD = "thread-on-the-host" as ThreadId;
const MACHINE = HostId.make("m-box");
/** Never cloned into here: no test asks for a repository. */
const REPOS = "/nonexistent/gram-host-repos";
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
    /** When set, an open waits on it, and a send once the agent has it. */
    const gate: { open?: Deferred.Deferred<void>; send?: Deferred.Deferred<void> } = {};
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
            send: (input) =>
              Effect.sync(() => void calls.push(`send ${input.text}`)).pipe(
                Effect.andThen(gate.send === undefined ? Effect.void : Deferred.await(gate.send)),
              ),
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
  /** The endpoints the host reached for a session's app tools. */
  const reached: Array<string> = [];
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
      repos: reposOn(yield* Proc, REPOS),
      worktrees: yield* Worktrees,
      git: gitOn(yield* Proc),
      terminals: yield* terminalsOnHost,
      sessions: yield* sessionsOnHost(
        (agent) =>
          agent === "claude"
            ? Effect.succeed(onHost.host)
            : Effect.fail(new AgentUnavailable({ agent, message: "not here" })),
        (endpoint) =>
          Effect.sync(() => {
            reached.push(endpoint.url);
            return LISTED;
          }),
      ),
      scan: Effect.succeed({ listening: new Map(), children: new Map() }),
    }),
  );
  const connection = yield* connectHost(yield* NodeSocket.fromDuplex(Effect.succeed(control)));
  const agent = agentHostThroughHost(connection.sessions, connection.gone, inServer.host);
  return { onHost, inServer, agent, connection, hostEnd, reached };
});

/** The app tools the endpoint lists, as the host hands them to the agent. */
const LISTED: RemoteAppTools = {
  tools: [
    { name: "set_title", description: "", inputSchema: { type: "object" }, alwaysLoad: true },
  ],
  call: async () => ({ content: [] }),
};

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
      const { onHost, inServer, agent, reached } = yield* routed;
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
      // The host reached the endpoint itself, and gave the agent the tools it lists.
      expect(reached).toEqual([MCP.url]);
      expect(options.remoteAppTools).toBe(LISTED);

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

/**
 * A joined machine's host whose service outlives its dials, as `dialForever` keeps it: `dial`
 * serves it over a new stream and connects to it, as a redial does; `current` is the machine's
 * connection now, failing while none is up.
 */
const redialling = Effect.gen(function* () {
  const onHost = yield* scriptedAgent("claude", "host");
  const inServer = yield* scriptedAgent("claude", "server");
  const service = {
    hello: {
      protocol: HOST_PROTOCOL_VERSION,
      hostId: MACHINE,
      capabilities: HOST_SERVES,
      platform: process.platform,
      pid: 7,
    },
    files: filesOn(yield* Proc),
    repos: reposOn(yield* Proc, REPOS),
    worktrees: yield* Worktrees,
    git: gitOn(yield* Proc),
    terminals: yield* terminalsOnHost,
    sessions: yield* sessionsOnHost((agent) =>
      agent === "claude"
        ? Effect.succeed(onHost.host)
        : Effect.fail(new AgentUnavailable({ agent, message: "not here" })),
    ),
    scan: Effect.succeed({ listening: new Map(), children: new Map() }),
  };
  let live: { connection: HostConnection; hostEnd: { destroy: () => void } } | undefined;
  const dial = Effect.gen(function* () {
    const { host: hostEnd, control } = yield* streamPair;
    yield* Effect.forkScoped(
      serveHost(yield* NodeSocket.fromDuplex(Effect.succeed(hostEnd)), service),
    );
    const connection = yield* connectHost(yield* NodeSocket.fromDuplex(Effect.succeed(control)), {
      hostId: MACHINE,
    });
    live = { connection, hostEnd };
    return live;
  });
  const current = Effect.suspend(() =>
    live === undefined || live.connection.gone()
      ? Effect.fail(new HostUnavailable({ hostId: MACHINE, message: "That machine is offline." }))
      : Effect.succeed(live.connection),
  );
  const first = yield* dial;
  const agent = (reattachMs: number) =>
    agentHostOnMachine(
      followingSessions(current, { reattachMs, callMs: 2_000 }),
      () => false,
      inServer.host,
      "box",
      () => "http://gram.test",
    );
  return { onHost, dial, first, agent, sessions: service.sessions };
});

const notice = (message: string): AgentEvent => ({ type: "notice", level: "info", message });
const said = (events: Iterable<AgentEvent>) =>
  [...events].map((event) => (event.type === "notice" ? event.message : event.type));

describe("a joined machine's sessions across a dropped connection", () => {
  it.live("pick up after a redial where they were, the agent still running", () =>
    Effect.gen(function* () {
      const { onHost, dial, first, agent } = yield* redialling;
      const reports: Array<string> = [];
      const session = yield* agent(10_000).open({
        threadId: THREAD,
        cwd: "/work",
        onConnectorsSeen: (report) => void reports.push(report.connectors[0]!.name),
      });
      yield* eventually(() => (reports.length === 1 ? true : undefined), "the connectors report");
      const seen: Array<AgentEvent> = [];
      yield* Effect.forkScoped(
        Stream.runForEach(session.events, (event) => Effect.sync(() => void seen.push(event))),
      );
      yield* Queue.offer(onHost.events, notice("before"));
      yield* eventually(() => (seen.length === 1 ? true : undefined), "the first event");
      // Before this change the session ended here with HOST_STOPPED_ENDED.
      first.hostEnd.destroy();
      yield* eventually(() => (first.connection.gone() ? true : undefined), "the drop");
      // The agent keeps working while no one is connected; what it says is kept for the redial.
      yield* Queue.offer(onHost.events, notice("while away"));
      yield* Effect.sleep("300 millis");
      yield* dial;
      yield* Queue.offer(onHost.events, notice("after"));
      yield* eventually(
        () => (seen.length === 3 ? true : undefined),
        "the events after the redial",
      );
      expect(said(seen)).toEqual(["before", "while away", "after"]);
      // The connectors report is followed again too: the host hands the last one to the new stream.
      yield* eventually(() => (reports.length === 2 ? true : undefined), "the report again");
      expect(reports).toEqual(["docs", "docs"]);
      // Calls reach the agent over the new connection, and it never closed.
      yield* session.send({ text: "hi" });
      expect(onHost.calls).toContain("send hi");
      expect(onHost.closed).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("end once the machine doesn't come back in time", () =>
    Effect.gen(function* () {
      const { onHost, first, agent } = yield* redialling;
      const session = yield* agent(1_000).open({ threadId: THREAD, cwd: "/work" });
      const collected = yield* Effect.forkScoped(Stream.runCollect(session.events));
      yield* Queue.offer(onHost.events, notice("before"));
      yield* Effect.sleep("200 millis");
      first.hostEnd.destroy();
      const events = yield* Fiber.join(collected);
      expect(said(events)).toEqual(["before", "ended"]);
      expect(events.at(-1)).toEqual(HOST_STOPPED_ENDED);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});

/** Whether `exit` is a death by `InputUndelivered`: the input kept, not counted taken. */
const diedUndelivered = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) &&
  exit.cause.reasons.some((r) => r._tag === "Die" && isUndelivered(r.defect));

describe("input a joined machine's session didn't take", () => {
  it.live("isn't reported delivered when the host fails the send or the steer", () =>
    Effect.gen(function* () {
      const { inServer, connection: real } = yield* routed;
      const failed = Effect.fail(
        new HostFailed({ message: "This machine's host isn't answering." }),
      );
      // The audit's reproduction: a connection whose send and steer fail before they arrive.
      const connection: HostSessionsConnection = {
        ...real.sessions,
        send: () => failed,
        steer: () => failed,
      };
      const session = yield* agentHostOnMachine(
        connection,
        () => false,
        inServer.host,
        "box",
        () => "http://gram.test",
      ).open({ threadId: THREAD, cwd: "/work" });
      // Before this change both succeeded, a warning logged and the input lost.
      expect(diedUndelivered(yield* Effect.exit(session.send({ text: "hi" })))).toBe(true);
      expect(diedUndelivered(yield* Effect.exit(session.steer({ text: "and this" })))).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("waits for a machine that is away past a call's wait, and delivers once it is back", () =>
    Effect.gen(function* () {
      const { onHost, dial, first, agent } = yield* redialling;
      const session = yield* agent(10_000).open({ threadId: THREAD, cwd: "/work" });
      yield* Effect.forkScoped(Stream.runDrain(session.events));
      first.hostEnd.destroy();
      yield* eventually(() => (first.connection.gone() ? true : undefined), "the drop");
      const sending = yield* Effect.forkScoped(Effect.exit(session.send({ text: "hi" })));
      // Longer than a call waits (2 s here): before this change the send gave up and succeeded.
      yield* Effect.sleep("2500 millis");
      yield* dial;
      expect(Exit.isSuccess(yield* Fiber.join(sending))).toBe(true);
      expect(onHost.calls.filter((call) => call === "send hi")).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("asks again after a drop that lost the answer, and the agent takes it once", () =>
    Effect.gen(function* () {
      const { onHost, dial, first, agent } = yield* redialling;
      const session = yield* agent(10_000).open({ threadId: THREAD, cwd: "/work" });
      yield* Effect.forkScoped(Stream.runDrain(session.events));
      const held = yield* Deferred.make<void>();
      onHost.gate.send = held;
      const sending = yield* Effect.forkScoped(Effect.exit(session.send({ text: "hi" })));
      // The host has it; the connection drops before its answer comes back.
      yield* eventually(() => (onHost.calls.includes("send hi") ? true : undefined), "the send");
      first.hostEnd.destroy();
      yield* eventually(() => (first.connection.gone() ? true : undefined), "the drop");
      yield* dial;
      yield* Effect.sleep("200 millis");
      yield* Deferred.succeed(held, undefined);
      expect(Exit.isSuccess(yield* Fiber.join(sending))).toBe(true);
      expect(onHost.calls.filter((call) => call === "send hi")).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("is kept, not lost, when the machine doesn't come back in time", () =>
    Effect.gen(function* () {
      const { onHost, first, agent } = yield* redialling;
      const session = yield* agent(1_000).open({ threadId: THREAD, cwd: "/work" });
      yield* Effect.forkScoped(Stream.runDrain(session.events));
      first.hostEnd.destroy();
      yield* eventually(() => (first.connection.gone() ? true : undefined), "the drop");
      expect(diedUndelivered(yield* Effect.exit(session.send({ text: "hi" })))).toBe(true);
      expect(onHost.calls).not.toContain("send hi");
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});

describe("a host's deliveries", () => {
  it.live("take input once per delivery id, a repeat answered as the first", () =>
    Effect.gen(function* () {
      const agent = yield* scriptedAgent("claude", "host");
      const sessions = yield* sessionsOnHost(() => Effect.succeed(agent.host));
      yield* sessions.open({ handle: "h", agent: "claude", threadId: THREAD, cwd: "/work" });
      const send = (text: string, id: string) =>
        sessions.deliver("h", id, (session) => session.send({ text }));
      yield* send("one", "d1");
      yield* send("one", "d1");
      yield* send("two", "d2");
      expect(agent.calls.filter((call) => call.startsWith("send"))).toEqual([
        "send one",
        "send two",
      ]);
      // A session that isn't open takes nothing.
      expect(
        Exit.isFailure(yield* Effect.exit(sessions.deliver("gone", "d3", () => Effect.void))),
      ).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});

describe("a joined machine's agent process", () => {
  it.live("has no process id here, so the port chips never match it to this machine's", () =>
    Effect.gen(function* () {
      const { agent } = yield* redialling;
      // The host reports pid 4242, which is that machine's: here it could be any process at all.
      const session = yield* agent(10_000).open({ threadId: THREAD, cwd: "/work" });
      expect(session.processId).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});

describe("a host's sessions left behind", () => {
  it.live("end when their thread opens anew, unless something still follows them", () =>
    Effect.gen(function* () {
      const agent = yield* scriptedAgent("claude", "host");
      const sessions = yield* sessionsOnHost(() => Effect.succeed(agent.host));
      const open = (handle: string, threadId: string) =>
        sessions.open({ handle, agent: "claude", threadId: threadId as ThreadId, cwd: "/work" });
      yield* open("followed", "t1");
      yield* Effect.forkScoped(Stream.runDrain(sessions.events("followed", 0)));
      yield* Effect.sleep("50 millis");
      yield* open("left", "t2");
      yield* open("other", "t3");
      // A Gram that restarted opens its threads anew: only the session nothing follows ends.
      yield* open("followed-again", "t1");
      yield* open("left-again", "t2");
      expect(agent.closed).toEqual(["host"]);
      expect(yield* Effect.exit(sessions.session("left"))).toMatchObject({ _tag: "Failure" });
      expect(yield* Effect.exit(sessions.session("followed"))).toMatchObject({ _tag: "Success" });
      expect(yield* Effect.exit(sessions.session("other"))).toMatchObject({ _tag: "Success" });
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("end once nothing has followed them for the grace", () =>
    Effect.gen(function* () {
      const agent = yield* scriptedAgent("claude", "host");
      const sessions = yield* sessionsOnHost(() => Effect.succeed(agent.host), undefined, {
        unfollowedMs: 150,
        sweepMs: 25,
      });
      const open = (handle: string) =>
        sessions.open({ handle, agent: "claude", threadId: handle as ThreadId, cwd: "/work" });
      yield* open("followed");
      yield* Effect.forkScoped(Stream.runDrain(sessions.events("followed", 0)));
      yield* open("given-up");
      yield* Effect.sleep("50 millis");
      expect(agent.closed).toEqual([]);
      yield* Effect.sleep("400 millis");
      expect(agent.closed).toEqual(["host"]);
      expect(yield* Effect.exit(sessions.session("given-up"))).toMatchObject({ _tag: "Failure" });
      expect(yield* Effect.exit(sessions.session("followed"))).toMatchObject({ _tag: "Success" });
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
