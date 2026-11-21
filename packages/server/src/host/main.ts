import { randomBytes } from "node:crypto";
import { Socket as NetSocket } from "node:net";
import { join } from "node:path";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { makeAppToolsTunnel } from "./app-tools-tunnel.ts";
import { hostOriginGuard } from "./origin-guard.ts";
import { ClaudeHost, ClaudeHostLive } from "@gram/agents/claude";
import { AgentUnavailable, HOST_PROTOCOL_VERSION, LOCAL_HOST_ID } from "@gram/contracts";
import { guardOrigins, Proc, ProcLive, Worktrees, WorktreesLive } from "@gram/git";
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
import { homedir } from "node:os";
import { GrokHost, GrokHostLive } from "@gram/agents/grok";
import { AntigravityHost, AntigravityHostLive } from "@gram/agents/antigravity";
import {
  antigravityGeminiDir,
  prepareOwnedAntigravityHome,
} from "../gateway/antigravity-owned-home.ts";
import { prepareOwnedGrokHome } from "../gateway/grok-owned-home.ts";
import { OpenCodeHost } from "@gram/agents/opencode";
import { antigravityStatusOf, grokStatusOf } from "./grok-on-host.ts";
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
import { HOST_AGENTS_ENV, hostAgentsFrom, limitedAgentHosts } from "./host-agents.ts";
import type { HostBusy, HostId } from "@gram/contracts";
import { selfUpdater } from "./self-update-host.ts";
import { hostTeardown, prepareHostProcess } from "./launch.ts";
import { type Admission, makeAdmission } from "./admission.ts";
import type * as Scope from "effect/Scope";

delete process.env["ELECTRON_RUN_AS_NODE"];
prepareHostProcess();

declare const GRAM_HOST_RELEASE: string | undefined;
const RELEASE = typeof GRAM_HOST_RELEASE === "string" ? GRAM_HOST_RELEASE : undefined;

/** The descriptor the server hands the host stream on. */
export const HOST_STREAM_FD = 3;

const hostAgents = (
  oauthToken?: () => string | undefined,
  keyAuth = false,
  codexData?: string,
  limit?: ReturnType<typeof hostAgentsFrom>,
): Layer.Layer<AgentHosts> =>
  process.env["GRAM_FAKE_AGENT"] === "1"
    ? makeFakeAgentAdapter(process.env["GRAM_FAKE_AGENT_REPLY"] === "echo" ? { reply: "echo" } : {})
    : Layer.effect(
        AgentHosts,
        Effect.gen(function* () {
          if (limit !== undefined && limit.ignored.length > 0)
            yield* Effect.logWarning(`gram-host: ${HOST_AGENTS_ENV} names no such agent`).pipe(
              Effect.annotateLogs({ ignored: limit.ignored.join(",") }),
            );
          const claude = yield* ClaudeHost;
          const codex = Option.getOrUndefined(yield* Effect.serviceOption(CodexHost));
          const opencode = Option.getOrUndefined(yield* Effect.serviceOption(OpenCodeHost));
          const grok = Option.getOrUndefined(yield* Effect.serviceOption(GrokHost));
          const antigravity = Option.getOrUndefined(yield* Effect.serviceOption(AntigravityHost));
          return limitedAgentHosts(
            AgentHosts.of({
              get: (agent) =>
                agent === "claude"
                  ? Effect.succeed(claude)
                  : agent === "codex" && codex !== undefined
                    ? Effect.succeed(codex)
                    : agent === "opencode" && opencode !== undefined
                      ? Effect.succeed(opencode)
                      : agent === "grok" && grok !== undefined
                        ? Effect.succeed(grok)
                        : agent === "antigravity" && antigravity !== undefined
                          ? Effect.succeed(antigravity)
                          : Effect.fail(
                              new AgentUnavailable({
                                agent,
                                message: `${agent} sessions don't run in this machine's host yet.`,
                              }),
                            ),
            }),
            limit?.only,
          );
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
        Layer.provide(codexData === undefined ? Layer.empty : hostOpenCodeLive()),
        Layer.provide(
          codexData === undefined
            ? Layer.empty
            : GrokHostLive({
                ownedHome: (userEnv) => prepareOwnedGrokHome(codexData, homedir(), userEnv),
              }),
        ),
        Layer.provide(
          codexData === undefined
            ? Layer.empty
            : AntigravityHostLive({
                ownedHome: (userEnv) => prepareOwnedAntigravityHome(codexData, homedir(), userEnv),
                geminiDir: antigravityGeminiDir(codexData),
              }),
        ),
      );

/** What could stop a host's update: what is running in it now (`HostBusy`). */
export type BusyOf = Effect.Effect<HostBusy>;

const hostService = (
  hostId: HostId,
  claude?: HostClaudeToken,
  update?: (busy: BusyOf, admission: Admission) => HostUpdater | undefined,
  keptTerminals?: string,
  local?: {
    readonly graceFrom: () => number | undefined;
    readonly busy: (busy: BusyOf) => void;
  },
  diskOf?: string,
): Effect.Effect<HostService, never, Scope.Scope | Proc | Worktrees | AgentHosts> =>
  Effect.gen(function* () {
    const proc = yield* Proc;
    const agents = yield* AgentHosts;
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
    const runsAntigravity = yield* agents.get("antigravity").pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    const terminals = yield* terminalsOnHostKeeping(
      keptTerminals === undefined ? undefined : keptTerminalsIn(keptTerminals),
    );
    const folders = foldersOn(proc);
    const opened = yield* sessionsOnHost(
      agents.get,
      undefined,
      local === undefined ? {} : { graceFrom: local.graceFrom },
    );
    const sessions = hostId === LOCAL_HOST_ID ? opened : gatedSessions(opened, folders.gate);
    let clones = 0;
    const checks = yield* checksOn(proc, join(hostHome(), "checks"));
    const repos = reposOn(proc, hostRepos());
    if (hostId !== LOCAL_HOST_ID)
      yield* Effect.acquireRelease(
        Effect.sync(() => guardOrigins(hostOriginGuard(hostRepos()))),
        (release) => Effect.sync(release),
      );
    const scan = liveScan.pipe(Effect.provideService(Proc, proc));
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
      ...(hostId === LOCAL_HOST_ID ? {} : { admit: (cwd) => folders.gate.admit(cwd, "session") }),
      ensure: (url) =>
        Effect.acquireUseRelease(
          Effect.sync(() => (clones += 1)),
          () => repos.ensure(url),
          () => Effect.sync(() => (clones -= 1)),
        ),
    });
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
            (feature !== "agent-grok" || runsGrok) &&
            (feature !== "agent-antigravity" || runsAntigravity),
        ),
        ...disk,
      },
      files: filesOn(proc),
      folders,
      reads: fileReadsOn(proc),
      attachments: yield* attachmentsOnHost(hostAttachments()),
      shared: sharedOnHost(hostShared()),
      appTools: yield* makeAppToolsTunnel,
      loopback: hostLoopback(),
      threadPlaces: threadPlacesOnHost(proc, hostRepos()),
      repos: {
        ensure: (url) =>
          Effect.acquireUseRelease(
            Effect.sync(() => (clones += 1)),
            () => repos.ensure(url),
            () => Effect.sync(() => (clones -= 1)),
          ),
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
        agents.get("claude").pipe(
          Effect.flatMap((host) => host.listModels()),
          Effect.orElseSucceed(() => undefined),
        ),
        runsCodex ? codexStatusOf(agents.get("codex")) : Effect.succeed(undefined),
        runsOpenCode ? openCodeStatusOf(agents.get("opencode")) : Effect.succeed(undefined),
        runsGrok ? grokStatusOf(agents.get("grok")) : Effect.succeed(undefined),
        runsAntigravity
          ? antigravityStatusOf(agents.get("antigravity"))
          : Effect.succeed(undefined),
      ),
      checks,
      admission,
      stop,
      ...(updater === undefined ? {} : { update: updater }),
    };
  });

const hostLayer = (
  oauthToken?: () => string | undefined,
  keyAuth = false,
  codexData?: string,
  limit?: ReturnType<typeof hostAgentsFrom>,
) =>
  Layer.mergeAll(
    WorktreesLive.pipe(Layer.provideMerge(ProcLive)),
    hostAgents(oauthToken, keyAuth, codexData, limit),
  );

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

const local = (socketPath: string) =>
  Effect.gen(function* () {
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
const joinedHome = hostHome();
const keyAuth =
  process.env["GRAM_HOST_CLAUDE_KEY_AUTH"] === "1" &&
  (() => {
    try {
      return readHostConfig(joinedHome)?.provisioned === true;
    } catch {
      return false;
    }
  })();
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
                provisioned
                  ? undefined
                  : (busy, admission) => selfUpdater(RELEASE, home, busy, admission),
                join(home, "kept-terminals", hostId),
                undefined,
                home,
              ).pipe(
                Effect.tap((service) =>
                  Effect.sync(() => {
                    if (provisioned) goingStop = service.stop;
                  }),
                ),
              ),
            layer: hostLayer(
              () => readClaudeToken(joinedHome),
              keyAuth,
              joinedHome,
              hostAgentsFrom(process.env[HOST_AGENTS_ENV]),
            ),
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
