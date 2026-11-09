import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { describe, expect, it } from "@effect/vitest";
import {
  HOST_PROTOCOL_VERSION,
  HostId,
  HostUnavailable,
  MessageId,
  type ThreadId,
  type ThreadStatus,
} from "@gram/contracts";
import { Proc, ProcLive, Worktrees, WorktreesLive } from "@gram/git";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { followingSessions } from "../host/following-sessions.ts";
import { filesOn } from "../host/files.ts";
import { gitOn } from "../host/git.ts";
import {
  connectHost,
  HOST_CAPABILITIES,
  type HostConnection,
  serveHost,
} from "../host/protocol.ts";
import { reposOn } from "../host/repos.ts";
import { sessionsOnHost } from "../host/sessions.ts";
import { watchedSocket } from "../host/socket-end.ts";
import { terminalsOnHost } from "../host/terminals.ts";
import { streamPair } from "../host/test-stream.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { AgentHosts } from "./agent-hosts.ts";
import { FakeAgentAdapter, FakeAgentControl, type FakeSession } from "./fake-agent.ts";
import { agentHostOnMachine } from "./host-agent-sessions.ts";
import {
  afterMachineRestart,
  MACHINE_RESTART_CONTINUATIONS,
  MACHINE_RESTART_WINDOW_MS,
  machineRestartText,
  type RestartFacts,
} from "./machine-restart.ts";
import { makeRuntimeTestLayer, replyStart } from "./test-harness.ts";
import { ThreadRuntimes } from "./thread-runtimes.ts";

const MACHINE = HostId.make("m-cachyos");
const NAME = "cachyos";
const REPOS = "/nonexistent/gram-host-repos";
const REPLY = (id: string) => MessageId.make(id);

/**
 * A joined machine's `gram-host`, which dials this Gram as `dialOnce` does: its service is built
 * once and served over the dial's stream, and this side watches that stream as `RemoteHosts` does.
 * `stop` ends the process the way a restart does (the dial's server first, then its stream, then
 * the sessions it kept), and `start` runs a new one, with none of the old one's sessions.
 * `current` is the machine's connection now, failing while it is offline.
 */
const fakeMachine = () => {
  let live:
    | {
        readonly connection: HostConnection;
        readonly service: Scope.Closeable;
        readonly dial: Scope.Closeable;
        readonly serving: Fiber.Fiber<unknown, unknown>;
      }
    | undefined;
  let pid = 100;
  /** The threads of the sessions its hosts opened, in order. */
  const opened: Array<string> = [];
  /** The fake agent the host runs its sessions on, once the runtime's layer is built. */
  const agents: { fake?: AgentHosts["Service"] } = {};
  const current = Effect.suspend(() =>
    live === undefined || live.connection.gone()
      ? Effect.fail(new HostUnavailable({ hostId: MACHINE, message: "That machine is offline." }))
      : Effect.succeed(live.connection),
  );
  /** Starts the host process on the fake agent's sessions there, and dials this Gram. */
  const start = Effect.gen(function* () {
    const fake = agents.fake;
    if (fake === undefined) return yield* Effect.die(new Error("no runtime yet"));
    const proc = yield* Proc;
    const serviceScope = yield* Scope.make();
    const service = yield* Effect.gen(function* () {
      return {
        hello: {
          protocol: HOST_PROTOCOL_VERSION,
          hostId: MACHINE,
          capabilities: HOST_CAPABILITIES,
          platform: "linux",
          pid: pid++,
        },
        files: filesOn(proc),
        repos: reposOn(proc, REPOS),
        worktrees: yield* Worktrees,
        git: gitOn(proc),
        terminals: yield* terminalsOnHost,
        sessions: yield* sessionsOnHost(
          (kind) =>
            Effect.map(fake.get(kind), (agent) => ({
              ...agent,
              open: (options) =>
                Effect.andThen(
                  Effect.sync(() => void opened.push(options.threadId)),
                  agent.open(options),
                ),
            })),
          () => Effect.die(new Error("no app tools in this test")),
        ),
        scan: Effect.succeed({ listening: new Map(), children: new Map() }),
      };
    }).pipe(Scope.provide(serviceScope));
    const dial = yield* Scope.make();
    const { host: hostEnd, control } = yield* streamPair.pipe(Scope.provide(dial));
    yield* Scope.addFinalizer(
      dial,
      Effect.sync(() => hostEnd.destroy()),
    );
    const serving = yield* Effect.forkIn(
      Effect.flatMap(NodeSocket.fromDuplex(Effect.succeed(hostEnd)), (socket) =>
        serveHost(socket, service),
      ),
      dial,
    );
    // This side, as `RemoteHosts` holds a dial: its stream's end is the machine gone.
    const ended = yield* Deferred.make<never, HostUnavailable>();
    const socket = yield* NodeSocket.fromDuplex(Effect.succeed(control));
    const connection = yield* connectHost(
      watchedSocket(
        socket,
        Deferred.fail(
          ended,
          new HostUnavailable({ hostId: MACHINE, message: "The machine's connection closed." }),
        ).pipe(Effect.asVoid),
      ),
      { hostId: MACHINE, gone: Deferred.await(ended) },
    );
    live = { connection, service: serviceScope, dial, serving };
  });
  /** The host process ends as a restart ends it, taking its sessions with it. */
  const stop = Effect.suspend(() => {
    const ending = live;
    if (ending === undefined) return Effect.void;
    return Effect.gen(function* () {
      yield* Fiber.interrupt(ending.serving);
      yield* Scope.close(ending.dial, Exit.void);
      yield* Scope.close(ending.service, Exit.void);
    });
  });
  return { current, start, stop, opened, agents };
};

/**
 * The runtime with Claude's sessions on `machine`, as a worker placed there has them: opened on its
 * host, and nothing here when it can't. The fake agent runs on the machine's side of the wire.
 */
const onMachine = (machine: ReturnType<typeof fakeMachine>, reattachMs = 5_000) => {
  const agents = Layer.effectContext(
    Effect.gen(function* () {
      const fake = yield* AgentHosts;
      machine.agents.fake = fake;
      const control = yield* FakeAgentControl;
      const sessions = followingSessions(machine.current, { reattachMs, callMs: 2_000 });
      return Context.make(
        AgentHosts,
        AgentHosts.of({
          get: (kind) =>
            Effect.map(fake.get(kind), (agent) => {
              const there = agentHostOnMachine(
                sessions,
                () => false,
                agent,
                NAME,
                () => "http://gram.test",
              );
              // No app tools: this runtime has no MCP endpoint for the machine to reach them at.
              return {
                ...there,
                open: (options) => {
                  const { appTools: _, ...rest } = options;
                  return there.open(rest);
                },
              };
            }),
        }),
      ).pipe(Context.add(FakeAgentControl, control));
    }),
  ).pipe(Layer.provide(FakeAgentAdapter));
  return makeRuntimeTestLayer(undefined, undefined, undefined, agents).pipe(
    Layer.provideMerge(WorktreesLive.pipe(Layer.provideMerge(ProcLive))),
  );
};

const eventually = <A, E, R>(label: string, check: Effect.Effect<A | undefined | false, E, R>) =>
  Effect.gen(function* () {
    for (let i = 0; i < 500; i++) {
      const value = yield* check;
      if (value !== undefined && value !== false) return value;
      yield* Effect.sleep("20 millis");
    }
    return yield* Effect.die(new Error(`timed out waiting for ${label}`));
  });

/** The newest session the fake agent opened for the thread, once there are `count`. */
const nthSession = (threadId: ThreadId, count: number) =>
  Effect.gen(function* () {
    const fake = yield* FakeAgentControl;
    return yield* eventually(
      `session ${count}`,
      Effect.sync(() => {
        const mine = fake.sessions.filter((s) => s.options.threadId === threadId);
        return mine.length >= count ? mine[count - 1] : undefined;
      }),
    );
  });

const statusIs = (threadId: ThreadId, status: ThreadStatus) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    return yield* eventually(
      status,
      runtimes.status(threadId).pipe(Effect.map((now) => now === status)),
    );
  });

/** A worker on the machine, mid-turn on its first message, with its Claude session id recorded. */
const midTurn = (machine: ReturnType<typeof fakeMachine>) =>
  Effect.gen(function* () {
    yield* machine.start;
    const runtimes = yield* ThreadRuntimes;
    const thread = yield* runtimes.create({
      projectRoot: "/srv/work/repo",
      checkout: { kind: "worktree", path: "/srv/work/repo-wt", branch: "w", hostId: MACHINE },
      input: { text: "build the feature" },
    } as never);
    const first = yield* nthSession(thread.id, 1);
    yield* eventually(
      "the first send",
      Effect.sync(() => first.sent.length === 1),
    );
    yield* first.emit({ type: "chunk", messageId: REPLY("reply-1"), chunk: replyStart("reply-1") });
    yield* statusIs(thread.id, "running");
    const store = yield* ThreadStore;
    yield* eventually(
      "the Claude session id",
      store.getThread(thread.id).pipe(Effect.map((t) => t.agentSessionId !== undefined)),
    );
    return { thread, first };
  });

/** The host restarts: its process ends with every session on it, and a new one dials in. */
const restart = (machine: ReturnType<typeof fakeMachine>, first: FakeSession) =>
  Effect.gen(function* () {
    yield* machine.stop;
    yield* eventually(
      "the old session closed",
      Effect.sync(() => first.closed),
    );
    yield* Effect.sleep("100 millis");
    yield* machine.start;
  });

const sessionRestarts = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const messages = yield* store.listMessages(threadId);
    return messages.flatMap((m) =>
      m.parts.flatMap((part) => (part.type === "data-session-restart" ? [part.data] : [])),
    );
  });

describe("a joined machine whose host restarts mid-turn", () => {
  it.live(
    "resumes the same Claude session there and continues the turn",
    () => {
      const machine = fakeMachine();
      return Effect.gen(function* () {
        const { thread, first } = yield* midTurn(machine);
        const store = yield* ThreadStore;
        const sessionId = (yield* store.getThread(thread.id)).agentSessionId;
        yield* restart(machine, first);

        // Before this change the thread failed here with "no longer has the session".
        const second = yield* nthSession(thread.id, 2);
        expect(second.options.resumeId).toBe(sessionId);
        expect(second.options.fork).not.toBe(true);
        expect(second.options.cwd).toBe("/srv/work/repo-wt");
        expect(second.agentSessionId).toBe(sessionId);
        // Both on the machine: nothing opened here instead.
        expect(machine.opened).toEqual([thread.id, thread.id]);
        // It continues once the resumed session is idle, with a note of what happened.
        yield* second.emit({ type: "status", status: "idle" });
        yield* eventually(
          "the continuation",
          Effect.sync(() => second.sent.length === 1),
        );
        expect(second.sent[0]).toMatchObject({ text: machineRestartText(NAME) });
        expect(yield* sessionRestarts(thread.id)).toEqual([
          expect.objectContaining({ machineRestart: { machine: NAME, continued: "turn" } }),
        ]);
        const kept = yield* store.getThread(thread.id);
        expect(kept.lastError).toBeUndefined();
      }).pipe(Effect.ensuring(machine.stop), Effect.scoped, Effect.provide(onMachine(machine)));
    },
    30_000,
  );

  it.live(
    "doesn't continue a turn waiting on the user's approval",
    () => {
      const machine = fakeMachine();
      return Effect.gen(function* () {
        const { thread, first } = yield* midTurn(machine);
        yield* first.emit({
          type: "request",
          request: { kind: "question", id: "q-1" as never, questions: [] },
        });
        yield* statusIs(thread.id, "needsInput");
        yield* restart(machine, first);
        yield* statusIs(thread.id, "error");
        const fake = yield* FakeAgentControl;
        expect(fake.sessions.filter((s) => s.options.threadId === thread.id)).toHaveLength(1);
        const kept = yield* (yield* ThreadStore).getThread(thread.id);
        expect(kept.lastError?.text ?? "").toContain(`${NAME} restarted while this turn waited`);
      }).pipe(Effect.ensuring(machine.stop), Effect.scoped, Effect.provide(onMachine(machine)));
    },
    30_000,
  );

  it.live(
    "doesn't continue a turn the user stopped",
    () => {
      const machine = fakeMachine();
      return Effect.gen(function* () {
        const { thread, first } = yield* midTurn(machine);
        const fake = yield* FakeAgentControl;
        // The interrupt reaches an agent that never ends its turn: the host restarts under it.
        yield* fake.setInterruptBehavior("hang");
        const runtimes = yield* ThreadRuntimes;
        yield* Effect.forkScoped(runtimes.interrupt(thread.id).pipe(Effect.ignore));
        yield* eventually(
          "the interrupt",
          Effect.sync(() => first.interrupts === 1),
        );
        yield* restart(machine, first);
        yield* statusIs(thread.id, "cold");
        yield* Effect.sleep("300 millis");
        expect(fake.sessions.filter((s) => s.options.threadId === thread.id)).toHaveLength(1);
        expect((yield* (yield* ThreadStore).getThread(thread.id)).lastError).toBeUndefined();
      }).pipe(Effect.ensuring(machine.stop), Effect.scoped, Effect.provide(onMachine(machine)));
    },
    30_000,
  );

  it.live(
    "continues at most three times an hour, then waits for the user",
    () => {
      const machine = fakeMachine();
      return Effect.gen(function* () {
        const { thread, first } = yield* midTurn(machine);
        let cut = first;
        for (let n = 2; n <= 4; n++) {
          yield* restart(machine, cut);
          cut = yield* nthSession(thread.id, n);
          yield* cut.emit({ type: "status", status: "idle" });
          yield* eventually(
            `continuation ${n - 1}`,
            Effect.sync(() => cut.sent.length === 1),
          );
          yield* cut.emit({
            type: "chunk",
            messageId: REPLY(`reply-${n}`),
            chunk: replyStart(`reply-${n}`),
          });
          yield* statusIs(thread.id, "running");
        }
        yield* restart(machine, cut);
        yield* statusIs(thread.id, "error");
        expect(machine.opened).toHaveLength(4);
        const kept = yield* (yield* ThreadStore).getThread(thread.id);
        expect(kept.lastError?.text ?? "").toContain("3 times in the last hour");
      }).pipe(Effect.ensuring(machine.stop), Effect.scoped, Effect.provide(onMachine(machine)));
    },
    60_000,
  );

  it.live(
    "fails naming the machine when it doesn't come back in time, and opens nothing here",
    () => {
      const machine = fakeMachine();
      return Effect.gen(function* () {
        const { thread, first } = yield* midTurn(machine);
        yield* machine.stop;
        yield* statusIs(thread.id, "error");
        const kept = yield* (yield* ThreadStore).getThread(thread.id);
        expect(kept.lastError?.text ?? "").toContain(`${NAME} stopped or restarted`);
        const fake = yield* FakeAgentControl;
        expect(fake.sessions.filter((s) => s.options.threadId === thread.id)).toEqual([first]);
      }).pipe(
        Effect.ensuring(machine.stop),
        Effect.scoped,
        Effect.provide(onMachine(machine, 1_000)),
      );
    },
    30_000,
  );
});

const facts = (over: Partial<RestartFacts> = {}): RestartFacts => ({
  machine: NAME,
  turnCut: true,
  turnOpen: true,
  stopAsked: false,
  queued: false,
  waitingOnUser: false,
  recent: [],
  now: 10 * MACHINE_RESTART_WINDOW_MS,
  ...over,
});

describe("what a machine restart leaves a thread to do", () => {
  it("continues a cut turn, or only the queue when the turn's input never got there", () => {
    expect(afterMachineRestart(facts()).next).toEqual({
      kind: "continue",
      machine: NAME,
      continued: "turn",
    });
    expect(afterMachineRestart(facts({ turnCut: false })).next).toMatchObject({
      kind: "continue",
      continued: "queue",
    });
    expect(
      afterMachineRestart(facts({ turnOpen: false, turnCut: false, queued: true })).next,
    ).toMatchObject({ kind: "continue", continued: "queue" });
  });

  it("lets an idle thread, or a turn the user stopped, rest", () => {
    expect(afterMachineRestart(facts({ turnOpen: false, turnCut: false })).next.kind).toBe("rest");
    expect(afterMachineRestart(facts({ stopAsked: true })).next.kind).toBe("rest");
    expect(afterMachineRestart(facts({ stopAsked: true, queued: true })).next.kind).toBe("rest");
  });

  it("never continues a turn waiting on the user", () => {
    const { next } = afterMachineRestart(facts({ waitingOnUser: true }));
    expect(next).toMatchObject({ kind: "fail" });
    expect(next.kind === "fail" && next.reason).toContain("waited on you");
  });

  it(`continues at most ${MACHINE_RESTART_CONTINUATIONS} times an hour`, () => {
    let recent: ReadonlyArray<number> = [];
    const at = (now: number) => {
      const decided = afterMachineRestart(facts({ recent, now }));
      recent = decided.recent;
      return decided.next.kind;
    };
    const start = 10 * MACHINE_RESTART_WINDOW_MS;
    expect([at(start), at(start + 1), at(start + 2), at(start + 3)]).toEqual([
      "continue",
      "continue",
      "continue",
      "fail",
    ]);
    // The first falls out of the hour, which makes room for one more.
    expect(at(start + MACHINE_RESTART_WINDOW_MS)).toBe("continue");
    expect(at(start + MACHINE_RESTART_WINDOW_MS)).toBe("fail");
  });
});
