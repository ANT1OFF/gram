// "Keep agents running after Gram quits", end to end over the real host protocol: this machine's
// host outlives two runs of Gram's runtime over one database. The first run quits mid-turn; the
// agent works on with no Gram; the second run takes the session up again, the turn whole.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { describe, expect, it } from "@effect/vitest";
import {
  HOST_PROTOCOL_VERSION,
  HostUnavailable,
  LOCAL_HOST_ID,
  MessageId,
  type RequestId,
  type ThreadId,
} from "@gram/contracts";
import { Proc, ProcLive, Worktrees, WorktreesLive } from "@gram/git";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { attachmentsOnHost, fileReadsOn } from "../host/file-reads.ts";
import { filesOn } from "../host/files.ts";
import { gitOn } from "../host/git.ts";
import {
  connectHost,
  HOST_CAPABILITIES,
  HOST_FEATURES,
  type HostConnection,
  type HostService,
  serveHost,
} from "../host/protocol.ts";
import { reposOn } from "../host/repos.ts";
import { sessionsOnHost } from "../host/sessions.ts";
import { watchedSocket } from "../host/socket-end.ts";
import { terminalsOnHost } from "../host/terminals.ts";
import { streamPair } from "../host/test-stream.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { AgentHosts } from "./agent-hosts.ts";
import { FakeAgentAdapter, FakeAgentControl } from "./fake-agent.ts";
import { agentHostThroughHost } from "./host-agent-sessions.ts";
import { KeptSessions, makeKeptSessions, readRecord } from "./kept-sessions.ts";
import { makeRuntimeTestLayer, replyStart } from "./test-harness.ts";
import { stopForShutdown } from "./shutdown.ts";
import { ThreadRuntimes } from "./thread-runtimes.ts";

const REPLY = MessageId.make("reply-1");

const eventually = <A, E, R>(label: string, check: Effect.Effect<A | undefined | false, E, R>) =>
  Effect.gen(function* () {
    for (let i = 0; i < 500; i++) {
      const value = yield* check;
      if (value !== undefined && value !== false) return value;
      yield* Effect.sleep("20 millis");
    }
    return yield* Effect.die(new Error(`timed out waiting for ${label}`));
  });

/**
 * This machine's host as the kept-running service has it: built once for the whole test, its
 * sessions on the fake agent, waiting for an app while none is connected (`graceFrom`).
 */
const keptHost = (fake: AgentHosts["Service"]) =>
  Effect.gen(function* () {
    const proc = yield* Proc;
    let connectedAt: number | undefined;
    const service: HostService = {
      hello: {
        protocol: HOST_PROTOCOL_VERSION,
        hostId: LOCAL_HOST_ID,
        capabilities: HOST_CAPABILITIES,
        features: HOST_FEATURES,
        platform: "linux",
        pid: 4242,
      },
      files: filesOn(proc),
      reads: fileReadsOn(proc),
      attachments: yield* attachmentsOnHost(mkdtempSync(join(tmpdir(), "gram-kept-attached-"))),
      repos: reposOn(proc, "/nonexistent/gram-kept-repos"),
      worktrees: yield* Worktrees,
      git: gitOn(proc),
      terminals: yield* terminalsOnHost,
      sessions: yield* sessionsOnHost(
        (kind) => fake.get(kind),
        () => Effect.die(new Error("no app tools in this test")),
        { graceFrom: () => connectedAt },
      ),
      scan: Effect.succeed({ listening: new Map(), children: new Map() }),
    } as unknown as HostService;
    /** One app connected to it, for as long as `scope` stays open. */
    const connect = (scope: Scope.Scope) =>
      Effect.gen(function* () {
        const { host, control } = yield* streamPair;
        connectedAt = Date.now();
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            connectedAt = undefined;
            host.destroy();
          }),
        );
        yield* Effect.forkScoped(
          Effect.flatMap(NodeSocket.fromDuplex(Effect.succeed(host)), (socket) =>
            serveHost(socket, service),
          ),
        );
        const ended = yield* Deferred.make<never, HostUnavailable>();
        const socket = yield* NodeSocket.fromDuplex(Effect.succeed(control));
        return yield* connectHost(
          watchedSocket(
            socket,
            Deferred.fail(
              ended,
              new HostUnavailable({ hostId: LOCAL_HOST_ID, message: "The app quit." }),
            ).pipe(Effect.asVoid),
          ),
          { hostId: LOCAL_HOST_ID, gone: Deferred.await(ended) },
        );
      }).pipe(Scope.provide(scope));
    return { connect };
  });

/** One run of Gram: its runtime over `db`, with Claude's sessions on `connection`. */
const gramRun = (
  connection: HostConnection,
  kept: KeptSessions["Service"],
  fake: Context.Context<AgentHosts | FakeAgentControl>,
  db: string,
) => {
  const agents = Layer.effectContext(
    Effect.sync(() => {
      const inner = Context.get(fake, AgentHosts);
      return Context.make(
        AgentHosts,
        AgentHosts.of({
          get: (kind) =>
            Effect.map(inner.get(kind), (agent) => {
              const through = agentHostThroughHost(connection.sessions, connection.gone, agent, {
                hooks: kept.hooks,
                take: kept.take,
              });
              // No app tools: this runtime has no MCP endpoint for the host to reach them at.
              return {
                ...through,
                open: (options) => {
                  const { appTools: _, ...rest } = options;
                  return through.open(rest);
                },
              };
            }),
        }),
      ).pipe(
        Context.add(FakeAgentControl, Context.get(fake, FakeAgentControl)),
        Context.add(KeptSessions, kept),
      );
    }),
  );
  return makeRuntimeTestLayer(
    undefined,
    undefined,
    undefined,
    agents,
    ThreadStore.layerSqlite(db),
  ).pipe(Layer.provideMerge(Layer.succeed(KeptSessions, kept)));
};

const text = (delta: string) =>
  ({ type: "chunk", messageId: REPLY, chunk: { type: "text-delta", id: "t1", delta } }) as const;

describe("a session kept running after Gram quits", () => {
  it.live.each([
    ["main's orderly shutdown", true],
    ["the server's layers closing, as on a signal", false],
  ] as const)(
    "works on with no Gram after %s, and the next Gram takes it up: the same session, the turn whole",
    ([, orderly]) =>
      Effect.gen(function* () {
        const dir = mkdtempSync(join(tmpdir(), "gram-kept-"));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
        );
        const db = join(dir, "gram.db");
        const record = join(dir, "local-host", "sessions.json");
        const fake = yield* Layer.build(FakeAgentAdapter);
        const control = Context.get(fake, FakeAgentControl);
        const host = yield* keptHost(Context.get(fake, AgentHosts));

        // The first Gram: a thread mid-turn on the host, half its reply streamed.
        const first = yield* Effect.gen(function* () {
          const scope = yield* Effect.scope;
          const connection = yield* host.connect(scope);
          const kept = yield* makeKeptSessions(record, connection.sessions, connection.hello.pid);
          const context = yield* Layer.build(gramRun(connection, kept, fake, db));
          return yield* Effect.gen(function* () {
            const runtimes = yield* ThreadRuntimes;
            const thread = yield* runtimes.create({
              projectRoot: "/srv/work/repo",
              checkout: { kind: "worktree", path: "/srv/work/repo-wt", branch: "w" },
              input: { text: "build the feature" },
            } as never);
            const session = yield* eventually(
              "the session",
              Effect.sync(() => control.sessions.find((s) => s.options.threadId === thread.id)),
            );
            yield* eventually(
              "the send",
              Effect.sync(() => session.sent.length === 1),
            );
            yield* session.emit(
              { type: "status", status: "running" },
              { type: "chunk", messageId: REPLY, chunk: replyStart(REPLY) },
              { type: "chunk", messageId: REPLY, chunk: { type: "text-start", id: "t1" } },
              text("first half"),
            );
            yield* eventually(
              "running",
              runtimes.status(thread.id).pipe(Effect.map((s) => s === "running")),
            );
            // Gram quits: its runtime shuts down (or not, when the process just ends) and its
            // connection to the host closes.
            // Main's orderly quit tells the shell what it left running, for its one notice.
            if (orderly) {
              const posted: Array<unknown> = [];
              yield* stopForShutdown((message) => void posted.push(message));
              expect(posted).toContainEqual({ type: "keptRunning", agents: 1 });
            }
            return { threadId: thread.id as ThreadId, session };
          }).pipe(Effect.provide(context));
        }).pipe(Effect.scoped);

        // Left running: the host never closed it, and the record says where it stood.
        expect(first.session.closed).toBe(false);
        expect(readRecord(record)?.sessions.map((s) => s.threadId)).toEqual([first.threadId]);

        // With no Gram open, the agent finishes its reply, and asks to run a command.
        yield* first.session.emit(
          text(", second half"),
          { type: "chunk", messageId: REPLY, chunk: { type: "text-end", id: "t1" } },
          {
            type: "request",
            request: {
              kind: "approval",
              id: "req-1" as RequestId,
              toolName: "Bash",
              displayName: "Bash",
              input: { command: "git push" },
              suggestions: [],
            },
          } as never,
          { type: "status", status: "awaitingApproval" },
        );
        yield* Effect.sleep("100 millis");

        // The next Gram takes it up as it starts.
        yield* Effect.gen(function* () {
          const scope = yield* Effect.scope;
          const connection = yield* host.connect(scope);
          const kept = yield* makeKeptSessions(record, connection.sessions, connection.hello.pid);
          expect([...kept.survivors]).toEqual([first.threadId]);
          const context = yield* Layer.build(gramRun(connection, kept, fake, db));
          yield* Effect.gen(function* () {
            const runtimes = yield* ThreadRuntimes;
            const store = yield* ThreadStore;
            // The approval it asked for while Gram was closed waits for the user here.
            const requests = yield* eventually(
              "the waiting approval",
              store
                .listRequests(first.threadId)
                .pipe(Effect.map((list) => (list.length > 0 ? list : undefined))),
            );
            expect(requests.map((r) => r.id)).toEqual(["req-1"]);
            // The reply holds both halves: what streamed before the quit and after it.
            const reply = yield* eventually(
              "the whole reply",
              store.listMessages(first.threadId).pipe(
                Effect.map((messages) => {
                  const found = messages.find((m) => m.id === REPLY);
                  const said = found?.parts
                    .flatMap((p) => (p.type === "text" ? [p.text] : []))
                    .join("");
                  return said === "first half, second half" ? said : undefined;
                }),
              ),
            );
            expect(reply).toBe("first half, second half");
            // The turn the first Gram opened is still the one open: no restart cut it.
            const turn = yield* store.lastTurn(first.threadId);
            expect(turn?.endedAt).toBeUndefined();

            // Answered here, the answer reaches the same agent session.
            yield* runtimes.respond(first.threadId, "req-1" as RequestId, {
              kind: "approval",
              decision: "allow",
              scope: "once",
            });
            yield* eventually(
              "the answer",
              Effect.sync(() => first.session.responses.length === 1),
            );
            yield* first.session.emit(
              { type: "chunk", messageId: REPLY, chunk: { type: "finish" } },
              { type: "turnEnd", reason: "completed" },
              { type: "status", status: "idle" },
            );
            yield* eventually(
              "the turn's end",
              store.lastTurn(first.threadId).pipe(Effect.map((t) => t?.endedAt !== undefined)),
            );
            // One agent session from start to end: nothing was opened again.
            expect(control.sessions.filter((s) => s.options.threadId === first.threadId)).toEqual([
              first.session,
            ]);
          }).pipe(Effect.provide(context));
        }).pipe(Effect.scoped);
      }).pipe(Effect.scoped, Effect.provide(WorktreesLive.pipe(Layer.provideMerge(ProcLive)))),
    60_000,
  );
});
