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
import { claudeTokenIn } from "./claude-token.ts";
import { checksOn } from "./checks.ts";
import { attachmentsOnHost, fileReadsOn } from "./file-reads.ts";
import { cloneWorktrees } from "./clone-worktrees.ts";
import { hostAttachments, hostHome, hostRepos, readClaudeToken } from "./host-config.ts";
import { reposOn } from "./repos.ts";
import { AgentHosts } from "../runtime/agent-hosts.ts";
import { makeFakeAgentAdapter } from "../runtime/fake-agent.ts";
import { claudeSignInOf, hostStatusOf } from "./claude-sign-in.ts";
import { sessionsOnHost } from "./sessions.ts";
import { terminalsOnHost } from "./terminals.ts";
import {
  HOST_SERVES,
  type HostClaudeToken,
  type HostService,
  type HostUpdater,
  serveHost,
} from "./protocol.ts";
import { foregroundOf } from "../ports/pure.ts";
import { runCli } from "./cli.ts";
import type { HostBusy, HostId } from "@gram/contracts";
import { selfUpdater } from "./self-update-host.ts";
import { type Admission, makeAdmission } from "./admission.ts";
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

/** What could stop a host's update: what is running in it now (`HostBusy`). */
export type BusyOf = Effect.Effect<HostBusy>;

/**
 * What the host serves as `hostId`, its terminals and sessions closed with the scope. A joined
 * machine's host passes `update`, which it serves with what it has running.
 */
const hostService = (
  hostId: HostId,
  claude?: HostClaudeToken,
  update?: (busy: BusyOf, admission: Admission) => HostUpdater | undefined,
): Effect.Effect<HostService, never, Scope.Scope | Proc | Worktrees | AgentHosts> =>
  Effect.gen(function* () {
    const proc = yield* Proc;
    const agents = yield* AgentHosts;
    const terminals = yield* terminalsOnHost;
    const sessions = yield* sessionsOnHost(agents.get);
    let clones = 0;
    const checks = yield* checksOn(proc, join(hostHome(), "checks"));
    const repos = reposOn(proc, hostRepos());
    const scan = liveScan.pipe(Effect.provideService(Proc, proc));
    /**
     * Sessions at work, terminals running a command (a thread's shell with a foreground job, or any
     * other shell still open, such as a sign-in), and clones in flight. A scan that fails counts
     * every thread's shell as busy.
     */
    const busy: BusyOf = Effect.gen(function* () {
      const alive = (yield* terminals.terminals.list()).filter((terminal) => terminal.alive);
      const loose = alive.filter((terminal) => terminal.threadId === undefined).length;
      const shells = terminals.shells();
      let running = shells.length;
      if (shells.length > 0) {
        const swept = yield* scan.pipe(Effect.orElseSucceed(() => undefined));
        if (swept?.processes !== undefined) {
          const { processes, children } = swept;
          running = shells.filter(
            (pid) => foregroundOf(processes, children, pid) !== undefined,
          ).length;
        }
      }
      return {
        turns: sessions.busy(),
        terminals: loose + running,
        clones,
        checks: checks.running?.() ?? 0,
      };
    });
    const admission = makeAdmission();
    const updater = update?.(busy, admission);
    return {
      hello: {
        protocol: HOST_PROTOCOL_VERSION,
        hostId,
        capabilities: updater === undefined ? HOST_SERVES : [...HOST_SERVES, "update"],
        platform: process.platform,
        pid: process.pid,
        ...(RELEASE === undefined ? {} : { release: RELEASE }),
      },
      files: filesOn(proc),
      reads: fileReadsOn(proc),
      attachments: yield* attachmentsOnHost(hostAttachments()),
      repos: {
        ensure: (url) =>
          Effect.acquireUseRelease(
            Effect.sync(() => (clones += 1)),
            () => repos.ensure(url),
            () => Effect.sync(() => (clones -= 1)),
          ),
      },
      worktrees:
        hostId === LOCAL_HOST_ID ? yield* Worktrees : cloneWorktrees(proc, yield* Worktrees),
      git: gitOn(proc),
      terminals,
      sessions,
      scan,
      ...(claude === undefined ? {} : { claude }),
      status: hostStatusOf(
        agents.get("claude").pipe(
          Effect.flatMap(claudeSignInOf),
          Effect.orElseSucceed(() => "unknown" as const),
        ),
      ),
      checks,
      ...(updater === undefined ? {} : { update: updater, admission }),
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
        service: (hostId, home) =>
          hostService(hostId, claudeTokenIn(joinedHome), (busy, admission) =>
            selfUpdater(RELEASE, home, busy, admission),
          ),
        layer: hostLayer(() => readClaudeToken(joinedHome)),
        release: RELEASE,
      }),
);
