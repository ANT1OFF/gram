// `gram-host`: this machine's worker host as its own process. The server starts it with the host
// stream on file descriptor 3 and talks the host protocol over it; nothing here listens on a
// network. When the server goes, the stream closes and the host exits.

import { Socket as NetSocket } from "node:net";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { ClaudeHost, ClaudeHostLive } from "@gram/agents/claude";
import {
  AgentUnavailable,
  HOST_PROTOCOL_VERSION,
  LOCAL_HOST_ID,
} from "@gram/contracts";
import { Proc, ProcLive, Worktrees, WorktreesLive } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { liveScan } from "../ports/scan.ts";
import { filesOn } from "./files.ts";
import { gitOn } from "./git.ts";
import { AgentHosts } from "../runtime/agent-hosts.ts";
import { makeFakeAgentAdapter } from "../runtime/fake-agent.ts";
import { sessionsOnHost } from "./sessions.ts";
import { terminalsOnHost } from "./terminals.ts";
import { HOST_CAPABILITIES, serveHost } from "./protocol.ts";

// The server starts the host as plain Node under Electron; what the host runs (git, ps, an editor
// git opens) must not inherit that.
delete process.env["ELECTRON_RUN_AS_NODE"];

/** The descriptor the server hands the host stream on. */
export const HOST_STREAM_FD = 3;

/**
 * The agents whose sessions the host runs: Claude Code on the user's own login. A session through a
 * gateway profile, and every Codex session, still opens in the server, which keeps the keys and the
 * Codex homes. Under the fake agent the host runs the fake, as the server does.
 */
const HostAgents: Layer.Layer<AgentHosts> =
  process.env["GRAM_FAKE_AGENT"] === "1"
    ? makeFakeAgentAdapter()
    : Layer.effect(
        AgentHosts,
        Effect.gen(function* () {
          const claude = yield* ClaudeHost;
          return AgentHosts.of({
            get: (agent) =>
              agent === "claude"
                ? Effect.succeed(claude)
                : Effect.fail(
                    new AgentUnavailable({
                      agent,
                      message: `${agent} sessions don't run in this machine's host yet.`,
                    }),
                  ),
          });
        }),
      ).pipe(Layer.provide(ClaudeHostLive()));

const program = Effect.gen(function* () {
  const proc = yield* Proc;
  const socket = yield* NodeSocket.fromDuplex(
    Effect.sync(
      () =>
        new NetSocket({ fd: HOST_STREAM_FD, readable: true, writable: true }),
    ),
  );
  yield* serveHost(socket, {
    hello: {
      protocol: HOST_PROTOCOL_VERSION,
      hostId: LOCAL_HOST_ID,
      capabilities: HOST_CAPABILITIES,
      platform: process.platform,
      pid: process.pid,
    },
    files: filesOn(proc),
    worktrees: yield* Worktrees,
    git: gitOn(proc),
    terminals: yield* terminalsOnHost,
    sessions: yield* sessionsOnHost((yield* AgentHosts).get),
    scan: liveScan.pipe(Effect.provideService(Proc, proc)),
  });
}).pipe(
  Effect.scoped,
  Effect.provide(
    Layer.mergeAll(
      WorktreesLive.pipe(Layer.provideMerge(ProcLive)),
      HostAgents,
    ),
  ),
);

NodeRuntime.runMain(program);
