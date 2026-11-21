import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import {
  beginChildShutdownCheck,
  notOrderlyExits,
  runningOwnedAgents,
  stopOwnedAgentsForUpdate,
} from "@gram/agents";
import { ClaudeHost, ClaudeHostLive } from "@gram/agents/claude";
import { CodexHost, CodexHostLive } from "@gram/agents/codex";
import { AntigravityHost, AntigravityHostLive } from "@gram/agents/antigravity";
import { GrokHost, GrokHostLive } from "@gram/agents/grok";
import { OpenCodeHost, OpenCodeHostLive } from "@gram/agents/opencode";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { homedir } from "node:os";
import { ManagedRuntimes } from "./agent-runtime/service.ts";
import { ServerConfig } from "./config.ts";
import { McpCli, McpCliLive } from "./connectors/mcp-cli.ts";
import {
  codexSkillRoots,
  installOutwardRules,
  prepareCodexHome,
  releaseCodexHome,
  removeOutwardRules,
  syncCodexInstructions,
} from "./gateway/codex-home.ts";
import { ownedCodexProvider, prepareOwnedCodexHome } from "./gateway/codex-owned-home.ts";
import {
  antigravityGeminiDir,
  prepareOwnedAntigravityHome,
} from "./gateway/antigravity-owned-home.ts";
import { prepareOwnedGrokHome } from "./gateway/grok-owned-home.ts";
import { GatewayCredentials } from "./gateway/credentials.ts";
import { GitPlatformLive } from "./git/platform.ts";
import { GitTurnHooksLive } from "./git/turn-hooks.ts";
import { ServerWork } from "./host/ownership.ts";
import { bootLine, LaunchToken, serverPort, ServerLayer } from "./http/server.ts";
import { embeddingEnabled } from "./settings/embedding.ts";
import { securePrivateDir } from "./logging/data-dir.ts";
import { createLogger, logDirFor } from "./logging/logger.ts";
import { ServerLog, serverLogLayer } from "./logging/service.ts";
import { ThreadStore } from "./persistence/thread-store.ts";
import { sealForUpdate } from "./persistence/update-seal.ts";
import { OpenerLive, openerFenced } from "./platform/opener.ts";
import { TailscaleLive } from "./http/remote-control.ts";
import { HttpServer } from "./platform/unstable.ts";
import { AgentHosts } from "./runtime/agent-hosts.ts";
import {
  AGENTS_STOP_TIMEOUT_MS,
  attestShutdown,
  ESSENTIALS_SEAL_MS,
  failedEssential,
  isShutdownRequest,
  isUpdateShutdownRequest,
  SHUTDOWN_DEADLINE_MS,
  shutdownDiagnostics,
  SIGNAL_STOP_DEADLINE_MS,
  stopForShutdown,
  unattestedEssential,
  type ShutdownEssentials,
} from "./runtime/shutdown.ts";
import { makeFakeAgentAdapter, makeFakeMcpCli, type FakeMcpServers } from "./runtime/fake-agent.ts";
import { plainTail } from "./terminal/plain-text.ts";
import { writeServerAgentGuide } from "./guide/agent-guide.ts";
import { usageHistoryRootsLayer } from "./usage/history-roots.ts";
import { keepServerFolders } from "./host/foreign-paths.ts";

const parentPort = (
  process as {
    parentPort?: {
      postMessage(message: unknown): void;
      on(event: "message", listener: (event: { readonly data: unknown }) => void): unknown;
    };
  }
).parentPort;

const config = {
  ...ServerConfig.fromEnv(),
  ...(parentPort === undefined ? {} : { shellOpensLinks: true }),
};
keepServerFolders(config.dataDir);

type AgentNeeds = GatewayCredentials | ManagedRuntimes;

const CodexAgent = Layer.unwrap(
  Effect.map(ManagedRuntimes, (managed) =>
    CodexHostLive({
      servers: {
        ownedHome: {
          prepare: (userEnv) => prepareOwnedCodexHome(config.dataDir, homedir(), userEnv),
          history: (userEnv) => prepareOwnedCodexHome(config.dataDir, homedir(), userEnv, false),
          refresh: (userEnv) =>
            Effect.asVoid(prepareOwnedCodexHome(config.dataDir, homedir(), userEnv)),
          provider: (userEnv) => ownedCodexProvider(homedir(), userEnv),
          rules: {
            install: (level) => installOutwardRules(config.dataDir, level, "owned"),
            remove: removeOutwardRules(config.dataDir, "owned"),
          },
        },
        gatewayHome: (userEnv) => prepareCodexHome(config.dataDir, homedir(), userEnv),
        releaseGatewayHome: releaseCodexHome(config.dataDir),
        gatewaySkillRoots: (userEnv) => codexSkillRoots(homedir(), userEnv),
        refreshGatewayHome: (userEnv) =>
          Effect.asVoid(syncCodexInstructions(config.dataDir, homedir(), userEnv)),
        gateRules: {
          install: (level) => installOutwardRules(config.dataDir, level),
          remove: removeOutwardRules(config.dataDir),
        },
        runtime: managed.codexSource,
      },
    }),
  ),
);

const ClaudeAgents: Layer.Layer<AgentHosts, never, AgentNeeds> = Layer.effect(
  AgentHosts,
  Effect.gen(function* () {
    return AgentHosts.fromHosts([
      yield* ClaudeHost,
      yield* CodexHost,
      yield* OpenCodeHost,
      yield* GrokHost,
      yield* AntigravityHost,
    ]);
  }),
).pipe(
  Layer.provide(ClaudeHostLive()),
  Layer.provide(CodexAgent),
  Layer.provide(OpenCodeHostLive()),
  Layer.provide(
    GrokHostLive({
      ownedHome: (userEnv) => prepareOwnedGrokHome(config.dataDir, homedir(), userEnv),
    }),
  ),
  Layer.provide(
    AntigravityHostLive({
      ownedHome: (userEnv) => prepareOwnedAntigravityHome(config.dataDir, homedir(), userEnv),
      geminiDir: antigravityGeminiDir(config.dataDir),
    }),
  ),
  Layer.provide(GatewayCredentials.layerProvider),
);

const fakeAgent = process.env["GRAM_FAKE_AGENT"] === "1";
const fakeMcpServers: FakeMcpServers = new Map();

const Agents: Layer.Layer<AgentHosts, never, AgentNeeds> = config.headless
  ? AgentHosts.layerNone
  : fakeAgent
    ? makeFakeAgentAdapter({
        ...(process.env["GRAM_FAKE_AGENT_REPLY"] === "echo" ? { reply: "echo" as const } : {}),
        mcpServers: fakeMcpServers,
      })
    : ClaudeAgents;

const McpCliLayer = fakeAgent ? Layer.succeed(McpCli, makeFakeMcpCli(fakeMcpServers)) : McpCliLive;
const McpCatalogueLayer = Layer.empty;

const dataDirTightened = securePrivateDir(config.dataDir);
const logDir = logDirFor(config.dataDir);
const { logger } = createLogger({ dir: logDir, name: "server", echo: parentPort === undefined });
if (dataDirTightened)
  logger.warn(
    { dataDir: config.dataDir },
    "data folder was readable by others; made it owner-only",
  );

const LogLive = serverLogLayer({
  logger,
  logDir,
  setLevel: (level) =>
    Effect.sync(() => {
      logger.level = level;
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Electron MessagePortMain
      parentPort?.postMessage({ type: "logLevel", level });
    }),
});

const activeResourceCounts = (): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const kind of process.getActiveResourcesInfo()) counts[kind] = (counts[kind] ?? 0) + 1;
  return counts;
};

const shutdownRequested = Promise.withResolvers<void>();
let shutdownRequestedAt: number | undefined;
let ownedChildrenOrderly = () => false;
let sessionsStopped: boolean | undefined;
let forUpdate = false;
const agentsStopped = Promise.withResolvers<number | undefined>();
let essentialsSealed = false;

const sealEssentials = async (requestedAt: number) => {
  const left = await agentsStopped.promise;
  const failed = await failedEssential({
    sessions: sessionsStopped === true,
    agents: left === 0 && runningOwnedAgents() === 0 && ownedChildrenOrderly(),
    database: () => Effect.runPromise(sealForUpdate),
  });
  const ms = Date.now() - requestedAt;
  let message: ShutdownEssentials;
  if (failed === undefined) {
    essentialsSealed = true;
    message = { type: "shutdownEssentials", success: true, waitingOn: activeResourceCounts() };
    logger.warn(
      { ms, waitingOn: message.waitingOn },
      "shutdown: essentials attested; main kills the rest of the teardown",
    );
  } else {
    message = { type: "shutdownEssentials", success: false, failed };
    logger.error(
      { ms, failed, ...(failed === "agents" ? { notOrderly: notOrderlyExits() } : {}) },
      "shutdown: essential not attested; update refused",
    );
  }
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Electron MessagePortMain
  parentPort?.postMessage(message);
};

let signalled = false;

if (parentPort === undefined) {
  const onSignal = () => {
    if (shutdownRequestedAt !== undefined) return;
    const requestedAt = Date.now();
    shutdownRequestedAt = requestedAt;
    signalled = true;
    ownedChildrenOrderly = beginChildShutdownCheck();
    setTimeout(() => {
      logger.warn(
        { ms: Date.now() - requestedAt, waitingOn: activeResourceCounts() },
        "shutdown overran its deadline",
      );
    }, SHUTDOWN_DEADLINE_MS).unref();
    setTimeout(() => {
      logger.error(
        { ms: Date.now() - requestedAt, waitingOn: activeResourceCounts() },
        "shutdown: teardown didn't end in time; exiting",
      );
      process.exit(1);
    }, SIGNAL_STOP_DEADLINE_MS).unref();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
}

parentPort?.on("message", ({ data }) => {
  if (!isShutdownRequest(data) || shutdownRequestedAt !== undefined) return;
  const requestedAt = Date.now();
  shutdownRequestedAt = requestedAt;
  forUpdate = isUpdateShutdownRequest(data);
  ownedChildrenOrderly = beginChildShutdownCheck();
  shutdownRequested.resolve();
  if (forUpdate) setTimeout(() => void sealEssentials(requestedAt), ESSENTIALS_SEAL_MS).unref();
  setTimeout(() => {
    logger.warn(
      { ms: Date.now() - requestedAt, waitingOn: activeResourceCounts() },
      "shutdown overran its deadline",
    );
  }, SHUTDOWN_DEADLINE_MS).unref();
});

const program = Effect.gen(function* () {
  const server = yield* HttpServer.HttpServer;
  const { token } = yield* LaunchToken;
  const port = serverPort(server);
  const { logLevel } = yield* (yield* ThreadStore).getSettings;
  yield* (yield* ServerLog).setLevel(logLevel);
  logger.info(
    {
      version: config.appVersion,
      platform: process.platform,
      arch: process.arch,
      port,
      logDir,
      ...(config.headless ? { headless: true } : {}),
    },
    "server started",
  );
  yield* writeServerAgentGuide(config);
  if (process.env["GRAM_SMOKE"] === "1") {
    const { text } = yield* Effect.promise(() => plainTail("emulator \x1b[1mok\x1b[0m", 1));
    if (text !== "emulator ok") return yield* Effect.die(`terminal emulator read "${text}"`);
    logger.info("terminal emulator loaded");
  }
  const fronted = config.frontedIdentity !== undefined && (yield* embeddingEnabled);
  if (config.frontedIdentity !== undefined && !fronted)
    logger.warn(
      "sign-in through a proxy is configured but hosted features are off: the launch token signs people in (set GRAM_EMBEDDING=1)",
    );
  yield* Effect.sync(() => {
    if (parentPort === undefined) {
      console.log(fronted ? `boot http://127.0.0.1:${port}/` : bootLine(port, token));
    } else {
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Electron MessagePortMain
      parentPort.postMessage({ type: "boot", url: `http://127.0.0.1:${port}/?boot=${token}` });
      console.log(`boot http://127.0.0.1:${port}/`);
    }
  });
  const stopSessions = stopForShutdown((progress) => {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Electron MessagePortMain
    parentPort?.postMessage(progress);
  }).pipe(
    Effect.tap((complete) =>
      Effect.sync(() => {
        sessionsStopped = complete;
      }),
    ),
    Effect.onExit((exit) =>
      Exit.isFailure(exit) ? Effect.sync(() => agentsStopped.resolve(undefined)) : Effect.void,
    ),
  );
  yield* Effect.promise(() => shutdownRequested.promise).pipe(
    Effect.onInterrupt(() => (signalled ? Effect.asVoid(Effect.exit(stopSessions)) : Effect.void)),
  );
  const stopped = yield* stopSessions;
  if (forUpdate) {
    const left = yield* Effect.promise(() => stopOwnedAgentsForUpdate(AGENTS_STOP_TIMEOUT_MS));
    agentsStopped.resolve(left);
  }
  return stopped;
});

program.pipe(
  Effect.provide(
    ServerLayer.pipe(
      Layer.provide(Agents),
      Layer.provide(McpCliLayer),
      Layer.provide(McpCatalogueLayer),
      Layer.provideMerge(GatewayCredentials.layer),
      Layer.provideMerge(ManagedRuntimes.layer),
      Layer.provide(GitTurnHooksLive),
      Layer.provide(GitPlatformLive),
      Layer.provide(ServerConfig.layer(config)),
      Layer.provide(
        usageHistoryRootsLayer(
          config.dataDir,
          fakeAgent ? {} : process.env,
          fakeAgent ? config.dataDir : homedir(),
        ),
      ),
      Layer.provideMerge(LogLive),
      Layer.provide(TailscaleLive),
      Layer.provide(
        OpenerLive(
          (pid) => {
            // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Electron MessagePortMain
            parentPort?.postMessage({ type: "launched", pid });
          },
          { fenced: openerFenced(config) },
        ),
      ),
    ),
  ),
  Effect.provideService(ServerWork, true),
  Effect.onExit((ended) =>
    essentialsSealed
      ? Effect.sync(() =>
          logger.info(
            { ms: Date.now() - (shutdownRequestedAt ?? Date.now()) },
            "shutdown: teardown ended after the seal; waiting for main",
          ),
        ).pipe(Effect.andThen(Effect.never))
      : Effect.sync(() => {
          if (shutdownRequestedAt === undefined) return;
          agentsStopped.resolve(undefined);
          const exit =
            signalled && Exit.isFailure(ended) && Cause.hasInterruptsOnly(ended.cause)
              ? Exit.succeed(sessionsStopped === true)
              : ended;
          const orderly = ownedChildrenOrderly();
          const diagnostics = shutdownDiagnostics(exit, sessionsStopped, orderly);
          const fields = {
            ms: Date.now() - shutdownRequestedAt,
            ...diagnostics,
            ...(orderly ? {} : { notOrderly: notOrderlyExits() }),
          };
          if (diagnostics.result === "complete") logger.info(fields, "shutdown: completed");
          else logger.error(fields, "shutdown: incomplete or failed; update refused");
          const failed = forUpdate
            ? unattestedEssential(exit, sessionsStopped, orderly)
            : undefined;
          if (failed !== undefined) {
            const message: ShutdownEssentials = {
              type: "shutdownEssentials",
              success: false,
              failed,
            };
            // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Electron MessagePortMain
            parentPort?.postMessage(message);
          }
          process.exit(
            attestShutdown(exit, orderly, (message) => {
              // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Electron MessagePortMain
              parentPort?.postMessage(message);
            }),
          );
        }),
  ),
  NodeRuntime.runMain,
);
