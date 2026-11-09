// `gram-host`: a machine's worker host as its own process. With no arguments the server starts it
// with the host stream on file descriptor 3 and talks the host protocol over it; when the server
// goes, the stream closes and the host exits. With a command (`join`, `run`, `service`, `status`,
// `leave`) it is another machine's host, which dials the main Gram over the tailnet. Nothing here
// listens on a network either way.

import { Socket as NetSocket } from "node:net";
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
import { claudeTokenIn } from "./claude-token.ts";
import { hostHome, hostRepos, readClaudeToken } from "./host-config.ts";
import { reposOn } from "./repos.ts";
import { AgentHosts } from "../runtime/agent-hosts.ts";
import { makeFakeAgentAdapter } from "../runtime/fake-agent.ts";
import { claudeSignInOf, hostStatusOf } from "./claude-sign-in.ts";
import { sessionsOnHost } from "./sessions.ts";
import { terminalsOnHost } from "./terminals.ts";
import { HOST_SERVES, type HostClaudeToken, type HostService, serveHost } from "./protocol.ts";
import { runCli } from "./cli.ts";
import type { HostId } from "@gram/contracts";
import type * as Scope from "effect/Scope";

// The server starts the host as plain Node under Electron; what the host runs (git, ps, an editor
// git opens) must not inherit that.
delete process.env["ELECTRON_RUN_AS_NODE"];

/** The descriptor the server hands the host stream on. */
export const HOST_STREAM_FD = 3;

/**
 * The agents whose sessions the host runs: Claude Code on the user's own login, or on the token
 * `oauthToken` reads (a joined machine's, from `claude setup-token`). A session through a gateway
 * profile, and every Codex session, still opens in the server, which keeps the keys and the Codex
 * homes. Under the fake agent the host runs the fake, as the server does.
 */
const hostAgents = (oauthToken?: () => string | undefined): Layer.Layer<AgentHosts> =>
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
      ).pipe(
        Layer.provide(
          ClaudeHostLive(oauthToken === undefined ? {} : { environment: { oauthToken } }),
        ),
      );

/** What the host serves as `hostId`, its terminals and sessions closed with the scope. */
const hostService = (
  hostId: HostId,
  claude?: HostClaudeToken,
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
      },
      files: filesOn(proc),
      repos: reposOn(proc, hostRepos()),
      worktrees: yield* Worktrees,
      git: gitOn(proc),
      terminals: yield* terminalsOnHost,
      sessions: yield* sessionsOnHost(agents.get),
      scan: liveScan.pipe(Effect.provideService(Proc, proc)),
      ...(claude === undefined ? {} : { claude }),
      status: hostStatusOf(
        agents.get("claude").pipe(
          Effect.flatMap(claudeSignInOf),
          Effect.orElseSucceed(() => "unknown" as const),
        ),
      ),
    };
  });

const hostLayer = (oauthToken?: () => string | undefined) =>
  Layer.mergeAll(WorktreesLive.pipe(Layer.provideMerge(ProcLive)), hostAgents(oauthToken));

/** This machine's host, for the server that started it. */
const child = Effect.gen(function* () {
  const socket = yield* NodeSocket.fromDuplex(
    Effect.sync(() => new NetSocket({ fd: HOST_STREAM_FD, readable: true, writable: true })),
  );
  yield* serveHost(socket, yield* hostService(LOCAL_HOST_ID));
}).pipe(Effect.scoped, Effect.provide(hostLayer()));

const args = process.argv.slice(2);
/**
 * A joined machine's host reads its token from its own folder at each session, so one set or
 * forgotten applies to the next; one it can't read leaves Claude on the machine's own sign-in.
 */
const joinedHome = hostHome();
NodeRuntime.runMain(
  args.length === 0
    ? child
    : runCli(args, {
        service: (hostId) => hostService(hostId, claudeTokenIn(joinedHome)),
        layer: hostLayer(() => readClaudeToken(joinedHome)),
      }),
);
