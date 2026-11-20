// `gram-host`: a machine's worker host as its own process. With no arguments the server starts it
// with the host stream on file descriptor 3 and talks the host protocol over it; when the server
// goes, the stream closes and the host exits. With a command (`join`, `run`, `service`, `status`,
// `leave`) it is another machine's host, which dials the main Gram over the tailnet. Nothing here
// listens on a network either way.

import { randomBytes } from "node:crypto";
import { Socket as NetSocket } from "node:net";
import { join } from "node:path";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { ClaudeHost, ClaudeHostLive } from "@gram/agents/claude";
import { AgentUnavailable, HOST_PROTOCOL_VERSION, LOCAL_HOST_ID } from "@gram/contracts";
import { Proc, ProcLive, Worktrees, WorktreesLive } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { liveScan } from "../ports/scan.ts";
import { filesOn } from "./files.ts";
import { foldersOn, gatedSessions } from "./folders.ts";
import { gitOn } from "./git.ts";
import { claudeTokenIn } from "./claude-token.ts";
import { checksOn } from "./checks.ts";
import { attachmentsOnHost, fileReadsOn } from "./file-reads.ts";
import { sharedOnHost } from "../shared/host-shared.ts";
import { hostLoopback } from "./loopback.ts";
import { threadPlacesOnHost } from "./thread-places.ts";
import { cloneWorktrees } from "./clone-worktrees.ts";
import {
  hostAttachments,
  hostIdentity,
  hostShared,
  hostHome,
  hostRepos,
  readClaudeToken,
  readHostConfig,
} from "./host-config.ts";
import { reposOn } from "./repos.ts";
import { AgentHosts } from "../runtime/agent-hosts.ts";
import { makeFakeAgentAdapter } from "../runtime/fake-agent.ts";
import { claudeSignInOf, hostStatusOf } from "./claude-sign-in.ts";
import { codexStatusOf, hostCodexLive } from "./codex-on-host.ts";
import { CodexHost } from "@gram/agents/codex";
import { GrokHost, GrokHostLive } from "@gram/agents/grok";
import { OpenCodeHost } from "@gram/agents/opencode";
import { grokStatusOf } from "./grok-on-host.ts";
import { hostOpenCodeLive, openCodeStatusOf } from "./opencode-on-host.ts";
import { sessionsOnHost } from "./sessions.ts";
import { terminalsOnHostKeeping } from "./terminals.ts";
import { KEPT_TERMINALS_ENV, keptTerminalsIn } from "../terminal/kept.ts";
import { serveLocal } from "./local-service.ts";
import { LOCAL_SECRET_ENV } from "./local-service-unit.ts";
import { type HostStop, stopOn } from "./stop.ts";
import { GOING_WITHIN_MS, holdingTerm } from "./term-hold.ts";
import {
  HOST_FEATURES,
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
import { hostTeardown, prepareHostProcess } from "./launch.ts";
import { type Admission, makeAdmission } from "./admission.ts";
import type * as Scope from "effect/Scope";

// The host runs as Node, or in host mode in the app's own Electron (`launch.ts`); what it runs
// (git, ps, an editor git opens) must not inherit either.
delete process.env["ELECTRON_RUN_AS_NODE"];
prepareHostProcess();

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
 * `oauthToken` reads (a joined machine's, from `claude setup-token`), and on a joined machine
 * Codex too, its homes in `codexData`, the host's own folder (`codex-on-host.ts`). A session
 * through a gateway profile still opens in the server, which keeps the keys; so does every Codex
 * session of this machine, whose homes are the server's. Under the fake agent the host runs the
 * fake, as the server does, echoing when asked to.
 */
const hostAgents = (
  oauthToken?: () => string | undefined,
  keyAuth = false,
  codexData?: string,
): Layer.Layer<AgentHosts> =>
  process.env["GRAM_FAKE_AGENT"] === "1"
    ? makeFakeAgentAdapter(process.env["GRAM_FAKE_AGENT_REPLY"] === "echo" ? { reply: "echo" } : {})
    : Layer.effect(
        AgentHosts,
        Effect.gen(function* () {
          const claude = yield* ClaudeHost;
          const codex = Option.getOrUndefined(yield* Effect.serviceOption(CodexHost));
          const opencode = Option.getOrUndefined(yield* Effect.serviceOption(OpenCodeHost));
          const grok = Option.getOrUndefined(yield* Effect.serviceOption(GrokHost));
          return AgentHosts.of({
            get: (agent) =>
              agent === "claude"
                ? Effect.succeed(claude)
                : agent === "codex" && codex !== undefined
                  ? Effect.succeed(codex)
                  : agent === "opencode" && opencode !== undefined
                    ? Effect.succeed(opencode)
                    : agent === "grok" && grok !== undefined
                      ? Effect.succeed(grok)
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
          ClaudeHostLive({
            environment: {
              ...(oauthToken === undefined ? {} : { oauthToken }),
              ...(keyAuth ? { keyAuth } : {}),
            },
          }),
        ),
        Layer.provide(codexData === undefined ? Layer.empty : hostCodexLive(codexData)),
        // OpenCode as well on a joined machine (the one whose host has a folder of its own).
        Layer.provide(codexData === undefined ? Layer.empty : hostOpenCodeLive()),
        // And Grok Build, on that machine's own sign-in or its environment's token command.
        Layer.provide(codexData === undefined ? Layer.empty : GrokHostLive()),
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
  /** Where its threads' open terminals are kept for its next start; absent, none are. */
  keptTerminals?: string,
  /** This machine's host kept running after the app quit: its sessions' timing, and its busy. */
  local?: {
    readonly graceFrom: () => number | undefined;
    readonly busy: (busy: BusyOf) => void;
  },
  /** A joined machine's host: the folder whose disk it names in its hello (`HostHello.diskId`). */
  diskOf?: string,
): Effect.Effect<HostService, never, Scope.Scope | Proc | Worktrees | AgentHosts> =>
  Effect.gen(function* () {
    const proc = yield* Proc;
    const agents = yield* AgentHosts;
    // Named in its hello only where it runs them: a joined machine's host, or the fake.
    const runsCodex = yield* agents.get("codex").pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    const runsOpenCode = yield* agents.get("opencode").pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    const runsGrok = yield* agents.get("grok").pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    const terminals = yield* terminalsOnHostKeeping(
      keptTerminals === undefined ? undefined : keptTerminalsIn(keptTerminals),
    );
    const folders = foldersOn(proc);
    // A joined machine's sessions open only in a folder its gate lets through; this machine's own
    // host runs this machine's threads wherever the user opened them, as the server did.
    const opened = yield* sessionsOnHost(
      agents.get,
      undefined,
      local === undefined ? {} : { graceFrom: local.graceFrom },
    );
    const sessions = hostId === LOCAL_HOST_ID ? opened : gatedSessions(opened, folders.gate);
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
    local?.busy(busy);
    const admission = makeAdmission();
    const updater = update?.(busy, admission);
    const stop = stopOn({
      proc,
      busy,
      admission,
      // A joined machine keeps only what its sessions could open; this machine's host any folder.
      ...(hostId === LOCAL_HOST_ID ? {} : { admit: (cwd) => folders.gate.admit(cwd, "session") }),
      // A clone made to put a thread's folder back counts as one, as any other the host makes.
      ensure: (url) =>
        Effect.acquireUseRelease(
          Effect.sync(() => (clones += 1)),
          () => repos.ensure(url),
          () => Effect.sync(() => (clones -= 1)),
        ),
    });
    // Its disk, and this start of it. One it can't keep says neither, and is taken as hosts were
    // before they said: a redial that has lost its sessions restarted on the same disk.
    const disk =
      diskOf === undefined
        ? undefined
        : yield* Effect.try(() => hostIdentity(diskOf, hostRepos())).pipe(
            Effect.map(({ diskId, unknown }) => ({
              diskId,
              bootId: randomBytes(16).toString("base64url"),
              ...(unknown === undefined ? {} : { diskUnknown: unknown }),
            })),
            Effect.tapError((error) =>
              Effect.logWarning("gram-host: couldn't keep the id of its disk").pipe(
                Effect.annotateLogs({ reason: String(error.cause) }),
              ),
            ),
            Effect.orElseSucceed(() => undefined),
          );
    return {
      hello: {
        protocol: HOST_PROTOCOL_VERSION,
        hostId,
        capabilities: updater === undefined ? HOST_SERVES : [...HOST_SERVES, "update"],
        platform: process.platform,
        pid: process.pid,
        ...(RELEASE === undefined ? {} : { release: RELEASE }),
        features: HOST_FEATURES.filter(
          (feature) =>
            (feature !== "agent-codex" || runsCodex) &&
            (feature !== "agent-opencode-sessions" || runsOpenCode) &&
            (feature !== "agent-grok" || runsGrok),
        ),
        ...disk,
      },
      files: filesOn(proc),
      folders,
      reads: fileReadsOn(proc),
      attachments: yield* attachmentsOnHost(hostAttachments()),
      shared: sharedOnHost(hostShared()),
      loopback: hostLoopback(),
      threadPlaces: threadPlacesOnHost(proc, hostRepos()),
      repos: {
        ensure: (url) =>
          Effect.acquireUseRelease(
            Effect.sync(() => (clones += 1)),
            () => repos.ensure(url),
            () => Effect.sync(() => (clones -= 1)),
          ),
        // A read: nothing for an update to wait on.
        identify: repos.identify,
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
        undefined,
        // What its Claude Code lists, for a worker placed here to resolve its tier against.
        agents.get("claude").pipe(
          Effect.flatMap((host) => host.listModels()),
          Effect.orElseSucceed(() => undefined),
        ),
        // And its Codex, where this host runs Codex sessions.
        runsCodex ? codexStatusOf(agents.get("codex")) : Effect.succeed(undefined),
        // And its OpenCode, where this host runs OpenCode sessions.
        runsOpenCode ? openCodeStatusOf(agents.get("opencode")) : Effect.succeed(undefined),
        // And its Grok Build, where this host runs Grok Build sessions.
        runsGrok ? grokStatusOf(agents.get("grok")) : Effect.succeed(undefined),
      ),
      checks,
      admission,
      stop,
      ...(updater === undefined ? {} : { update: updater }),
    };
  });

const hostLayer = (oauthToken?: () => string | undefined, keyAuth = false, codexData?: string) =>
  Layer.mergeAll(
    WorktreesLive.pipe(Layer.provideMerge(ProcLive)),
    hostAgents(oauthToken, keyAuth, codexData),
  );

/** This machine's host, for the server that started it. */
const child = Effect.gen(function* () {
  const socket = yield* NodeSocket.fromDuplex(
    Effect.sync(() => new NetSocket({ fd: HOST_STREAM_FD, readable: true, writable: true })),
  );
  const kept = process.env[KEPT_TERMINALS_ENV];
  yield* serveHost(
    socket,
    yield* hostService(
      LOCAL_HOST_ID,
      undefined,
      undefined,
      kept === undefined || kept === "" ? undefined : kept,
    ),
  );
}).pipe(Effect.scoped, Effect.provide(hostLayer()));

/**
 * This machine's host kept running after the app quits (`gram-host local --socket <path>`), as a
 * service the app starts. It serves the app on a socket in Gram's data folder, keeps its sessions
 * while no app is connected (approvals wait for it), and ends once none has been for a while with
 * nothing running.
 */
const local = (socketPath: string) =>
  Effect.gen(function* () {
    /** When an app last connected; `undefined` while none is. */
    let connectedAt: number | undefined;
    let busyOf: BusyOf = Effect.succeed({ turns: 0, terminals: 0, clones: 0, checks: 0 });
    const kept = process.env[KEPT_TERMINALS_ENV];
    const secretFile = process.env[LOCAL_SECRET_ENV];
    if (secretFile === undefined || secretFile === "")
      return yield* Effect.fail(new Error("No secret file was named; nothing will be served."));
    yield* serveLocal(
      socketPath,
      hostService(
        LOCAL_HOST_ID,
        undefined,
        undefined,
        kept === undefined || kept === "" ? undefined : kept,
        {
          graceFrom: () => connectedAt,
          busy: (busy) => {
            busyOf = busy;
          },
        },
      ),
      {
        busy: Effect.suspend(() => busyOf),
        secretFile,
        connected: (yes) => {
          connectedAt = yes ? Date.now() : undefined;
        },
      },
    );
  }).pipe(Effect.scoped, Effect.provide(hostLayer()));

const args = process.argv.slice(2);
/**
 * A joined machine's host reads its token from its own folder at each session, so one set or
 * forgotten applies to the next; one it can't read leaves Claude on the machine's own sign-in.
 */
const joinedHome = hostHome();
/**
 * Claude Code's own key auth on a provisioned host whose operator asked for it: the platform that
 * started the host points Claude Code at its own model endpoint. A provisioned host exists only
 * where its control plane has the hosted features on; a machine a person joined never takes this.
 */
const keyAuth =
  process.env["GRAM_HOST_CLAUDE_KEY_AUTH"] === "1" &&
  (() => {
    try {
      return readHostConfig(joinedHome)?.provisioned === true;
    } catch {
      return false;
    }
  })();
/** The provisioned host's stop, which says it is going on SIGTERM (`holdingTerm`). */
let goingStop: HostStop | undefined;
const socketArg = args[0] === "local" && args[1] === "--socket" ? args[2] : undefined;
NodeRuntime.runMain(
  args.length === 0
    ? child
    : socketArg !== undefined
      ? local(socketArg).pipe(
          Effect.catch((error) =>
            Effect.logError("gram-host local: couldn't serve").pipe(
              Effect.annotateLogs({ reason: error.message }),
            ),
          ),
        )
      : holdingTerm(
          runCli(args, {
            service: (hostId, home, provisioned) =>
              hostService(
                hostId,
                claudeTokenIn(joinedHome),
                // A provisioned host is replaced by whatever started it, never updated in place.
                provisioned
                  ? undefined
                  : (busy, admission) => selfUpdater(RELEASE, home, busy, admission),
                join(home, "kept-terminals", hostId),
                undefined,
                home,
              ).pipe(
                // Its compute goes with it, so its work is kept on SIGTERM. A machine a person
                // joined keeps its disk, and an update's restart is a SIGTERM too.
                Effect.tap((service) =>
                  Effect.sync(() => {
                    if (provisioned) goingStop = service.stop;
                  }),
                ),
              ),
            // Its Codex homes go in its own folder, beside its token.
            layer: hostLayer(() => readClaudeToken(joinedHome), keyAuth, joinedHome),
            release: RELEASE,
          }),
          () =>
            goingStop?.goAway(GOING_WITHIN_MS).pipe(
              Effect.tap((gone) =>
                Effect.logInfo("gram-host: going on SIGTERM").pipe(
                  Effect.annotateLogs({ outcome: gone }),
                ),
              ),
              Effect.asVoid,
            ),
        ),
  { teardown: hostTeardown },
);
