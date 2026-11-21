import * as NodeSocket from "@effect/platform-node/NodeSocket";
import type { AgentHost, AgentSession, OpenSessionOptions, RemoteAppTools } from "@gram/agents";
import {
  type AgentEvent,
  type AgentKind,
  AgentUnavailable,
  HostId,
  HOST_PROTOCOL_VERSION,
  type ThreadId,
  type UserInput,
} from "@gram/contracts";
import { Proc, ProcLive, Worktrees, WorktreesLive } from "@gram/git";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentHostOnMachine } from "../runtime/host-agent-sessions.ts";
import { attachmentsOnHost, fileReadsOn } from "./file-reads.ts";
import { filesOn } from "./files.ts";
import { followingSessions } from "./following-sessions.ts";
import { gitOn } from "./git.ts";
import { connectHost, HOST_SERVES, serveHost } from "./protocol.ts";
import { reposOn } from "./repos.ts";
import { sessionsOnHost } from "./sessions.ts";
import { terminalsOnHost } from "./terminals.ts";
import { streamPair } from "./test-stream.ts";

export const THREAD = "thread-on-the-host" as ThreadId;
export const MACHINE = HostId.make("m-box");
/** Never cloned into here: no test asks for a repository. */
export const REPOS = "/nonexistent/gram-host-repos";
export const CAPABILITIES = {
  modes: ["default"],
  models: [],
} as unknown as AgentHost["capabilities"];

/** A scripted agent: what each session was opened with and asked, and its events to emit. */
export const scriptedAgent = (kind: AgentKind, where: string) =>
  Effect.gen(function* () {
    const calls: Array<string> = [];
    const inputs: Array<UserInput> = [];
    const opened: Array<OpenSessionOptions> = [];
    const closed: Array<string> = [];
    const events = yield* Queue.unbounded<AgentEvent, Cause.Done>();
    const gate: {
      open?: Deferred.Deferred<void>;
      send?: Deferred.Deferred<void>;
      endOnClose?: boolean;
    } = {};
    const host: AgentHost = {
      kind,
      capabilities: CAPABILITIES,
      listModels: () => Effect.succeed([]),
      open: (options) =>
        Effect.gen(function* () {
          if (gate.open !== undefined) yield* Deferred.await(gate.open);
          opened.push(options);
          calls.push(`${where}: open`);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              closed.push(where);
              if (gate.endOnClose === true) {
                Queue.offerUnsafe(events, {
                  type: "ended",
                  reason: "error: InterruptError: All fibers interrupted without error",
                });
                Queue.endUnsafe(events);
              }
            }),
          );
          options.onConnectorsSeen?.({
            detailed: true,
            whole: false,
            connectors: [{ name: "docs", status: "connected" }],
          });
          const session: AgentSession = {
            events: Stream.fromQueue(events),
            send: (input) =>
              Effect.sync(() => {
                inputs.push(input);
                calls.push(`send ${input.text}`);
              }).pipe(
                Effect.andThen(gate.send === undefined ? Effect.void : Deferred.await(gate.send)),
              ),
            steer: (input) =>
              Effect.sync(() => {
                inputs.push(input);
                calls.push(`steer ${input.text}`);
              }),
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
    return { host, calls, inputs, opened, closed, events, gate };
  });

/** The app tools the endpoint lists, as the host hands them to the agent. */
export const LISTED: RemoteAppTools = {
  tools: [
    { name: "set_title", description: "", inputSchema: { type: "object" }, alwaysLoad: true },
  ],
  call: async () => ({ content: [] }),
};

export const layer = Layer.mergeAll(WorktreesLive.pipe(Layer.provideMerge(ProcLive)));

/**
 * A joined machine's host whose sessions are a scripted Codex, over a real stream, named `box`,
 * with `features` in its hello: this build's, or an older host's. The server's own Codex is
 * scripted too, to show nothing opens there.
 */
export const codexMachineWith = (features: ReadonlyArray<string>, kind: AgentKind = "codex") =>
  Effect.gen(function* () {
    const onHost = yield* scriptedAgent(kind, "box");
    const inServer = yield* scriptedAgent(kind, "server");
    const { host: hostEnd, control } = yield* streamPair;
    yield* Effect.forkScoped(
      serveHost(yield* NodeSocket.fromDuplex(Effect.succeed(hostEnd)), {
        hello: {
          protocol: HOST_PROTOCOL_VERSION,
          hostId: MACHINE,
          capabilities: HOST_SERVES,
          features,
          platform: process.platform,
          pid: 1,
        },
        files: filesOn(yield* Proc),
        reads: fileReadsOn(yield* Proc),
        attachments: yield* attachmentsOnHost(mkdtempSync(join(tmpdir(), "gram-host-attached-"))),
        repos: reposOn(yield* Proc, REPOS),
        worktrees: yield* Worktrees,
        git: gitOn(yield* Proc),
        terminals: yield* terminalsOnHost,
        sessions: yield* sessionsOnHost(
          (agent) =>
            agent === kind
              ? Effect.succeed(onHost.host)
              : Effect.fail(new AgentUnavailable({ agent, message: "not here" })),
          () => Effect.succeed(LISTED),
        ),
        scan: Effect.succeed({ listening: new Map(), children: new Map() }),
      }),
    );
    const connection = yield* connectHost(yield* NodeSocket.fromDuplex(Effect.succeed(control)), {
      hostId: MACHINE,
    });
    const agent = agentHostOnMachine(
      followingSessions(Effect.succeed(connection)),
      () => false,
      inServer.host,
      "box",
      () => "http://100.64.0.1:4317",
    );
    return { onHost, inServer, agent };
  });
