// `gram-host`: a machine's worker host as its own process. With no arguments the server starts it
// with the host stream on file descriptor 3 and talks the host protocol over it; when the server
// goes, the stream closes and the host exits. With a command (`join`, `run`, `service`, `status`,
// `leave`) it is another machine's host, which dials the main Gram over the tailnet. Nothing here
// listens on a network either way.

import { Socket as NetSocket } from "node:net";
import { join } from "node:path";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { ClaudeHost, ClaudeHostLive } from "@gram/agents/claude";
import { AgentUnavailable, HOST_PROTOCOL_VERSION, LOCAL_HOST_ID } from "@gram/contracts";
import { Proc, ProcLive, Worktrees, WorktreesLive } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { liveScan } from "../ports/scan.ts";
import { filesOn } from "./files.ts";
import { gitOn } from "./git.ts";
import { checksOn } from "./checks.ts";
import { attachmentsOnHost, fileReadsOn } from "./file-reads.ts";
import { hostAttachments, hostHome, hostRepos } from "./host-config.ts";
import { cloneWorktrees } from "./clone-worktrees.ts";
import { reposOn } from "./repos.ts";
import { AgentHosts } from "../runtime/agent-hosts.ts";
import { makeFakeAgentAdapter } from "../runtime/fake-agent.ts";
import { claudeSignInOf, hostStatusOf } from "./claude-sign-in.ts";
import { sessionsOnHost } from "./sessions.ts";
import { terminalsOnHost } from "./terminals.ts";
import { HOST_SERVES, type HostService, serveHost } from "./protocol.ts";
import { runCli } from "./cli.ts";
import type { HostId } from "@gram/contracts";
import type * as Scope from "effect/Scope";

// The server starts the host as plain Node under Electron; what the host runs (git, ps, an editor
// git opens) must not inherit that.
delete process.env["ELECTRON_RUN_AS_NODE"];

/**
 * The Gram release this host was built from, which its hello carries so the main Gram can say a
 * joined machine needs an update. The app's build sets it (`proc-worker-build.ts`); a host run
 * from source has none.
 */
declare const GRAM_HOST_RELEASE: string | undefined;
const RELEASE = typeof GRAM_HOST_RELEASE === "string" ? GRAM_HOST_RELEASE : undefined;

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

/** What the host serves as `hostId`, its terminals and sessions closed with the scope. */
const hostService = (
  hostId: HostId,
): Effect.Effect<HostService, never, Scope.Scope | Proc | Worktrees | AgentHosts> =>
  Effect.gen(function* () {
    const proc = yield* Proc;
    const agents = yield* AgentHosts;
    return {
      hello: {
        protocol: HOST_PROTOCOL_VERSION,
        hostId,
        capabilities: HOST_SERVES,
        platform: process.platform,
        pid: process.pid,
        ...(RELEASE === undefined ? {} : { release: RELEASE }),
      },
      files: filesOn(proc),
      reads: fileReadsOn(proc),
      attachments: yield* attachmentsOnHost(hostAttachments()),
      repos: reposOn(proc, hostRepos()),
      worktrees:
        hostId === LOCAL_HOST_ID ? yield* Worktrees : cloneWorktrees(proc, yield* Worktrees),
      git: gitOn(proc),
      terminals: yield* terminalsOnHost,
      sessions: yield* sessionsOnHost(agents.get),
      scan: liveScan.pipe(Effect.provideService(Proc, proc)),
      status: hostStatusOf(
        agents.get("claude").pipe(
          Effect.flatMap(claudeSignInOf),
          Effect.orElseSucceed(() => "unknown" as const),
        ),
      ),
      checks: yield* checksOn(proc, join(hostHome(), "checks")),
    };
  });

const HostLayer = Layer.mergeAll(WorktreesLive.pipe(Layer.provideMerge(ProcLive)), HostAgents);

/** This machine's host, for the server that started it. */
const child = Effect.gen(function* () {
  const socket = yield* NodeSocket.fromDuplex(
    Effect.sync(() => new NetSocket({ fd: HOST_STREAM_FD, readable: true, writable: true })),
  );
  yield* serveHost(socket, yield* hostService(LOCAL_HOST_ID));
}).pipe(Effect.scoped, Effect.provide(HostLayer));

const args = process.argv.slice(2);
NodeRuntime.runMain(
  args.length === 0 ? child : runCli(args, { service: hostService, layer: HostLayer }),
);
