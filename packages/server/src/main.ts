import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import {
  beginChildShutdownCheck,
  notOrderlyExits,
  runningOwnedAgents,
  stopOwnedAgentsForUpdate,
} from "@gram/agents";
import { ClaudeHost, ClaudeHostLive } from "@gram/agents/claude";
import { CodexHost, CodexHostLive } from "@gram/agents/codex";
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
import { prepareOwnedCodexHome } from "./gateway/codex-owned-home.ts";
import { GatewayCredentials } from "./gateway/credentials.ts";
import { GitPlatformLive } from "./git/platform.ts";
import { GitTurnHooksLive } from "./git/turn-hooks.ts";
import { bootLine, LaunchToken, serverPort, ServerLayer } from "./http/server.ts";
import { createLogger, logDirFor } from "./logging/logger.ts";
import { ServerLog, serverLogLayer } from "./logging/service.ts";
import { ThreadStore } from "./persistence/thread-store.ts";
import { sealForUpdate } from "./persistence/update-seal.ts";
import { OpenerLive } from "./platform/opener.ts";
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
  stopForShutdown,
  unattestedEssential,
  type ShutdownEssentials,
} from "./runtime/shutdown.ts";
import { makeFakeAgentAdapter, makeFakeMcpCli, type FakeMcpServers } from "./runtime/fake-agent.ts";
import { plainTail } from "./terminal/plain-text.ts";
import { usageHistoryRootsLayer } from "./usage/history-roots.ts";

/** Present when Electron runs the server as a `utilityProcess`. */
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

/** Codex and Claude Code use installed subscription CLIs or an explicitly selected gateway.
 * Gateway keys and child homes remain separate from the developer's subscription credentials.
 * ManagedRuntimes supplies Codex only when the user explicitly chose that runtime.
 */
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
    return AgentHosts.fromHosts([yield* ClaudeHost, yield* CodexHost]);
  }),
).pipe(
  Layer.provide(ClaudeHostLive()),
  Layer.provide(CodexAgent),
  Layer.provide(GatewayCredentials.layerProvider),
);

const fakeAgent = process.env["GRAM_FAKE_AGENT"] === "1";
/** Servers the fake `claude mcp` holds, so a live check can add one and see the session list it. */
const fakeMcpServers: FakeMcpServers = new Map();

const Agents: Layer.Layer<AgentHosts, never, AgentNeeds> = fakeAgent
  ? makeFakeAgentAdapter({
      ...(process.env["GRAM_FAKE_AGENT_REPLY"] === "echo" ? { reply: "echo" as const } : {}),
      mcpServers: fakeMcpServers,
    })
  : ClaudeAgents;

// The fake never writes a real Claude Code config.
const McpCliLayer = fakeAgent ? Layer.succeed(McpCli, makeFakeMcpCli(fakeMcpServers)) : McpCliLive;
// Nor does it reach GitHub for the platform's catalogue.
// A public connector catalogue will be configured separately. No private repo lookups.
const McpCatalogueLayer = Layer.empty;

const logDir = logDirFor(config.dataDir);
// Standalone (dev, headless) runs echo to stdout; under Electron the file is the only sink.
const { logger } = createLogger({ dir: logDir, name: "server", echo: parentPort === undefined });

const LogLive = serverLogLayer({
  logger,
  logDir,
  setLevel: (level) =>
    Effect.sync(() => {
      logger.level = level;
      // The desktop shell mirrors the level for its own log.
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Electron MessagePortMain
      parentPort?.postMessage({ type: "logLevel", level });
    }),
});

/**
 * How many of each kind of handle keeps the process up (`TCPSocketWrap`, `ProcessWrap`, `Timeout`):
 * kinds and counts only, so an overrun says whether teardown waits on sockets, children or workers.
 */
const activeResourceCounts = (): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const kind of process.getActiveResourcesInfo()) counts[kind] = (counts[kind] ?? 0) + 1;
  return counts;
};

/** Settles when main asks the server to shut down (`runtime/shutdown.ts`), which only main does. */
const shutdownRequested = Promise.withResolvers<void>();
let shutdownRequestedAt: number | undefined;
let ownedChildrenOrderly = () => false;
let sessionsStopped: boolean | undefined;
/** Set by an update's shutdown request; an ordinary quit never seals or attests essentials. */
let forUpdate = false;
/** Settles with how many owned agent processes were left once an update stopped them. */
const agentsStopped = Promise.withResolvers<number | undefined>();
/** Set once the essentials are sealed: from then on main kills the rest, so the server waits. */
let essentialsSealed = false;

/**
 * An update's teardown still running at `ESSENTIALS_SEAL_MS`: attests the essentials
 * (`UPDATE_ESSENTIALS`) and seals the database, so main may kill the rest at once, or names the
 * first essential that failed, which refuses the update as an overrun does.
 */
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

parentPort?.on("message", ({ data }) => {
  if (!isShutdownRequest(data) || shutdownRequestedAt !== undefined) return;
  const requestedAt = Date.now();
  shutdownRequestedAt = requestedAt;
  forUpdate = isUpdateShutdownRequest(data);
  ownedChildrenOrderly = beginChildShutdownCheck();
  shutdownRequested.resolve();
  if (forUpdate) setTimeout(() => void sealEssentials(requestedAt), ESSENTIALS_SEAL_MS).unref();
  // The layers' finalizers have no bound of their own. Past this, main kills the server with
  // everything under it (`process-tree.ts`); exiting here instead would leave its agents running,
  // out of that tree.
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
    },
    "server started",
  );
  // The emulator's WASM is read out of the package at runtime, so a packaging mistake that loses it
  // would otherwise show only when an agent first reads a terminal. A smoke run dies here instead.
  if (process.env["GRAM_SMOKE"] === "1") {
    const { text } = yield* Effect.promise(() => plainTail("emulator \x1b[1mok\x1b[0m", 1));
    if (text !== "emulator ok") return yield* Effect.die(`terminal emulator read "${text}"`);
    logger.info("terminal emulator loaded");
  }
  yield* Effect.sync(() => {
    if (parentPort === undefined) {
      console.log(bootLine(port, token));
    } else {
      // The desktop shell's stdout ends up in logs, so the token only travels over the parent port.
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Electron MessagePortMain
      parentPort.postMessage({ type: "boot", url: `http://127.0.0.1:${port}/?boot=${token}` });
      console.log(`boot http://127.0.0.1:${port}/`);
    }
  });
  yield* Effect.promise(() => shutdownRequested.promise);
  const stopped = yield* stopForShutdown((progress) => {
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
  // An update stops the owned agent processes before the layers close rather than after, so the
  // essentials don't wait on the HTTP and core teardown (`UPDATE_ESSENTIALS`).
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
      // One instance shared by the agents (readers) and the gateway handlers (installer).
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
      // Under the shell, so a forced quit spares the editors and file managers it opened.
      Layer.provide(
        OpenerLive((pid) => {
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Electron MessagePortMain
          parentPort?.postMessage({ type: "launched", pid });
        }),
      ),
    ),
  ),
  // After the layers have closed, so it times the whole teardown. The exit is explicit: `runMain`
  // leaves a program that ends without a signal to the event loop, which `parentPort` keeps alive.
  Effect.onExit((exit) =>
    essentialsSealed
      ? // Main is killing the server with the rest of its tree. Exiting, which `runMain` does after
        // a failure, would leave what is still under the server out of main's reach.
        Effect.sync(() =>
          logger.info(
            { ms: Date.now() - (shutdownRequestedAt ?? Date.now()) },
            "shutdown: teardown ended after the seal; waiting for main",
          ),
        ).pipe(Effect.andThen(Effect.never))
      : Effect.sync(() => {
          if (shutdownRequestedAt === undefined) return;
          agentsStopped.resolve(undefined);
          const orderly = ownedChildrenOrderly();
          const diagnostics = shutdownDiagnostics(exit, sessionsStopped, orderly);
          const fields = {
            ms: Date.now() - shutdownRequestedAt,
            ...diagnostics,
            ...(orderly ? {} : { notOrderly: notOrderlyExits() }),
          };
          if (diagnostics.result === "complete") logger.info(fields, "shutdown: completed");
          else logger.error(fields, "shutdown: incomplete or failed; update refused");
          // Ended before the seal: main still hears which essential refused the update.
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
