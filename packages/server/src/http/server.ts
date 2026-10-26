import { UsageLimitPoller } from "../usage/limit-poller.ts";
import { PlanKeeperLive } from "../plans/keeper.ts";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { GramRpcs } from "@gram/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as ByteSize from "effect/ByteSize";
import * as Layer from "effect/Layer";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { McpRoute } from "../app-tools/http-mcp.ts";
import { ClaudeAiSeenLive } from "../connectors/claude-ai-seen.ts";
import { McpTokens } from "../app-tools/mcp-tokens.ts";
import { OrchestrationAppToolsLive } from "../app-tools/orchestration-tools.ts";
import { SettingsAppToolsLive } from "../settings/chat-tools.ts";
import { PrAppToolsLive } from "../app-tools/pr-tools.ts";
import { ReadAppToolsLive } from "../app-tools/read-tools.ts";
import { WrapUpAppToolsLive } from "../app-tools/wrap-up-tool.ts";
import { ReviewRequestAppToolsLive } from "../app-tools/review-request-tools.ts";
import { AppToolRegistry } from "../app-tools/registry.ts";
import { ReviewAppToolsLive } from "../babysit/review-tools.ts";
import { PanePort } from "../browser/pane-port.ts";
import { BrowserAppToolsLive } from "../browser/tools.ts";
import { DevServerAppToolsLive } from "../browser/dev-server-tools.ts";
import { BabysitLive } from "../babysit/service.ts";
import { HiddenPrsLive } from "../git/hidden-prs.ts";
import { WorktreeSweepLive } from "../git/worktree-gc.ts";
import { ThreadArchive, ThreadArchiverLive } from "../orchestration/archive.ts";
import { DreamFiles } from "../orchestration/dream-files.ts";
import { DreamsLive } from "../orchestration/dreams.ts";
import { OrchestrationMemory } from "../orchestration/memory.ts";
import { OrchestrationLive } from "../orchestration/service.ts";
import { ComposerPresence } from "../runtime/composer-presence.ts";
import { OrchestratorAppToolsLive } from "../orchestration/tools.ts";
import { ServerConfig } from "../config.ts";
import { EventHub } from "../events/event-hub.ts";
import { TerminalGate } from "../terminal/gate.ts";
import { GitCheckoutLive, GitStatePublisherLive } from "../git/index.ts";
import { LocalCheckRunner, LocalChecksLive } from "../git/local-checks.ts";
import { MergeWhenReadyLive } from "../git/merge-when-ready.ts";
import { RunMonitorLive } from "../git/run-monitor.ts";
import { IssueReporter } from "../issues/reporter.ts";
import { IssueAppToolsLive } from "../issues/tools.ts";
import { LaunchChecksCache } from "../launch-checks/handler.ts";
import { ReviewRequestsLive } from "../github/review-requests.ts";
import { PrDependenciesLive } from "../wakes/pr-dependencies.ts";
import { ThreadWakesLive } from "../wakes/thread-wakes.ts";
import { AppActivityLive } from "../git/activity.ts";
import { ThreadVisibility } from "../git/visibility.ts";
import type { GitPlatform } from "../git/platform.ts";
import { LoopStallLog } from "../logging/loop-stalls.ts";
import { serverDatabaseFile } from "../persistence/database-file.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { PreviewFiles } from "../preview/files.ts";
import { ProcessRoots, ThreadPorts } from "../ports/service.ts";
import {
  HttpPlatform,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
  HttpStaticServer,
  type Rpc,
  type RpcGroup,
  RpcSerialization,
  RpcServer,
} from "../platform/unstable.ts";
import { ThreadAssistLive } from "../helper/assist.ts";
import { HelperScheduler } from "../helper/scheduler.ts";
import { RpcHandlersLayer } from "../rpc/handlers/index.ts";
import type { AgentHosts } from "../runtime/agent-hosts.ts";
import type { TurnHooks } from "../runtime/hooks.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { UsageLimitReadings } from "../usage/limit-readings.ts";
import { WorkspaceOutputs } from "../outputs/workspace-outputs.ts";
import {
  createRemoteAccess,
  pairingCsp,
  pairingDocument,
  REMOTE_PAIR_PATH,
  SESSION_LIFETIME_MS,
  REMOTE_CONNECT_PATH,
  REMOTE_CLAIM_PATH,
  remoteCookieName,
} from "./remote-access.ts";
import { fileRemoteSessionStore } from "./remote-sessions.ts";
import { authTarget } from "./auth-target.ts";
import { authorize, contentSecurityPolicy, makeLaunchToken, tokenCookieName } from "./auth.ts";

/** The per-launch secret carried by the boot URL. */
export class LaunchToken extends Context.Service<LaunchToken, { readonly token: string }>()(
  "@gram/server/LaunchToken",
) {
  static readonly layer = Layer.sync(LaunchToken, () => ({ token: makeLaunchToken() }));
}

export const serverPort = (server: HttpServer.HttpServer["Service"]): number =>
  "port" in server.address ? server.address.port : 0;

/** `boot http://127.0.0.1:<port>/?boot=<token>`; desktop main and the e2e harness parse it. */
export const bootLine = (port: number, token: string): string =>
  `boot http://127.0.0.1:${port}/?boot=${token}`;

/** Host/Origin allowlist, then the launch cookie, or a thread's bearer token on `/mcp`. */
export const AuthMiddleware = HttpRouter.middleware(
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const { token } = yield* LaunchToken;
    const config = yield* ServerConfig;
    const mcpTokens = yield* McpTokens;
    const port = serverPort(server);
    const remote =
      config.remoteOrigin === undefined
        ? undefined
        : createRemoteAccess(
            config.remoteOrigin,
            port,
            Date.now,
            fileRemoteSessionStore(config.dataDir, config.remoteOrigin, port),
          );
    const securityHeaders = {
      "content-security-policy": contentSecurityPolicy(port),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    };
    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const authRequest = {
          method: request.method,
          url: request.url,
          headers: request.headers,
          cookies: request.cookies,
        };
        const target = authTarget(request.url);
        const path = target?.path;
        const isRemote = remote !== undefined && request.headers["host"] === remote.host;
        const secureResponse = (response: HttpServerResponse.HttpServerResponse) =>
          HttpServerResponse.setHeaders(response, {
            ...securityHeaders,
            ...(isRemote
              ? { "content-security-policy": contentSecurityPolicy(port, remote.origin) }
              : {}),
          });
        if (request.headers["tailscale-funnel-request"] !== undefined)
          return secureResponse(
            HttpServerResponse.text("forbidden: private access only", { status: 403 }),
          );
        if (target === undefined || (isRemote && target.searchParams.has("boot")))
          return secureResponse(
            HttpServerResponse.text("forbidden: request target", { status: 403 }),
          );
        // Remote bootstrap has no app assets and exposes no data. The secret is a fragment.
        if (isRemote && path === REMOTE_CONNECT_PATH && request.method === "GET") {
          if (
            request.headers["origin"] !== undefined &&
            request.headers["origin"] !== remote.origin
          )
            return secureResponse(HttpServerResponse.text("forbidden", { status: 403 }));
          return HttpServerResponse.setHeaders(HttpServerResponse.html(pairingDocument), {
            ...securityHeaders,
            "content-security-policy": pairingCsp,
          });
        }
        if (isRemote && path === REMOTE_CLAIM_PATH) {
          if (
            request.method !== "POST" ||
            request.headers["origin"] !== remote.origin ||
            request.headers["content-type"] !== "text/plain" ||
            Number(request.headers["content-length"]) > 64
          )
            return secureResponse(HttpServerResponse.text("forbidden", { status: 403 }));
          const code = yield* request.text.pipe(
            Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.bytes(64)),
            Effect.catch(() => Effect.succeed("")),
          );
          const session = code.length === 64 ? remote.claim(authRequest, code) : undefined;
          if (session === undefined)
            return secureResponse(HttpServerResponse.text("pairing refused", { status: 403 }));
          const response = yield* HttpServerResponse.text("paired").pipe(
            HttpServerResponse.setCookie(remoteCookieName(port), session, {
              maxAge: SESSION_LIFETIME_MS,
              secure: true,
              httpOnly: true,
              sameSite: "strict",
              path: "/",
            }),
            Effect.orDie,
          );
          return secureResponse(response);
        }
        const decision = isRemote
          ? remote.authorize(authRequest)
          : authorize(
              { port, token, extraOrigins: config.extraOrigins },
              {
                method: request.method,
                url: request.url,
                headers: request.headers,
                cookies: request.cookies,
              },
            );
        let response: HttpServerResponse.HttpServerResponse;
        switch (decision.kind) {
          case "pass":
            response =
              path === REMOTE_PAIR_PATH
                ? remote !== undefined &&
                  request.method === "POST" &&
                  request.headers["origin"] !== undefined &&
                  !isRemote
                  ? HttpServerResponse.jsonUnsafe(remote.mint())
                  : HttpServerResponse.text("pairing unavailable", { status: 403 })
                : yield* httpEffect;
            break;
          case "boot":
            response = yield* HttpServerResponse.redirect("/", { status: 302 }).pipe(
              HttpServerResponse.setCookie(tokenCookieName(port), token, {
                httpOnly: true,
                sameSite: "strict",
                path: "/",
              }),
              Effect.orDie,
            );
            break;
          case "bearer":
            response =
              (yield* mcpTokens.threadFor(decision.token)) === undefined
                ? HttpServerResponse.text("unauthorized: invalid bearer token", { status: 401 })
                : yield* httpEffect;
            break;
          case "reject":
            response = HttpServerResponse.text(decision.message, { status: decision.status });
            break;
        }
        return secureResponse(response);
      });
  }),
  { global: true },
);

/**
 * Gives a file response's stream an `'error'` listener as soon as it exists. Effect's Node
 * `fileResponse` opens a `ReadStream` that the response's `pipeline` only listens to once it is
 * written, so an `open` failing in between had no listener and Node killed the server: on a
 * machine out of descriptors (EMFILE) it died serving a page's script, and the page never loaded. With a
 * listener the error stays on the stream, and `pipeline` fails that one response with it.
 */
export const guardFileBody = (
  response: HttpServerResponse.HttpServerResponse,
): HttpServerResponse.HttpServerResponse => {
  const body = response.body;
  if (body._tag === "Raw" && body.body instanceof Readable) {
    body.body.on("error", () => {
      // Reported by the response's pipeline, which reads the error the stream keeps.
    });
  }
  return response;
};

/**
 * Node's `HttpPlatform` with {@link guardFileBody} on every file response. It runs in the step that
 * made the stream, and the `open` it guards can only fail once the event loop turns.
 */
export const GuardedHttpPlatform = Layer.effect(HttpPlatform.HttpPlatform)(
  Effect.gen(function* () {
    const platform = yield* HttpPlatform.HttpPlatform;
    return HttpPlatform.HttpPlatform.of({
      ...platform,
      fileResponse: (path, options) =>
        Effect.map(platform.fileResponse(path, options), guardFileBody),
    });
  }),
).pipe(Layer.provide(NodeHttpPlatform.layer));

const StaticRoutes = Layer.unwrap(
  Effect.gen(function* () {
    const { webRoot } = yield* ServerConfig;
    return webRoot === undefined
      ? HttpRouter.add(
          "GET",
          "/*",
          HttpServerResponse.text("Gram server: no web root configured", { status: 404 }),
        )
      : HttpStaticServer.layer({ root: webRoot, index: "index.html", spa: true }).pipe(
          Layer.provide(GuardedHttpPlatform),
        );
  }),
);

/**
 * Serves `group` as JSON over the `/ws` WebSocket. A handler's defect fails only its own request:
 * by default the RPC server sends it to the whole connection, and the client then fails every call
 * and stream on the socket, so one bad request reconnects every open thread.
 */
export const rpcRoutes = <Rpcs extends Rpc.Any, E, R>(
  group: RpcGroup.RpcGroup<Rpcs>,
  handlers: Layer.Layer<Rpc.ToHandler<Rpcs>, E, R>,
) =>
  RpcServer.layer(group, { disableTracing: true, disableFatalDefects: true }).pipe(
    Layer.provide(handlers),
    Layer.provide(RpcServer.layerProtocolWebsocket({ path: "/ws" })),
    Layer.provide(RpcSerialization.layerJson),
  );

const RpcRoutes = rpcRoutes(GramRpcs, RpcHandlersLayer);

/** Store, hub, runtimes, app tools and git checkouts; needs agents, hooks, git and config. */
export const ServerCore = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const databaseFile = config.databaseFile ?? (yield* serverDatabaseFile(config.dataDir));
    if (databaseFile !== ":memory:") mkdirSync(config.dataDir, { recursive: true });
    // The git app tools read the publisher and babysit observes it; the publisher and port chips
    // depend on the runtimes; the runtimes depend on checkouts. Orchestration sits under the app
    // tools because the cross-thread ones ask it whether a call is delegated, and over the launch
    // checks, which tell it whether a new orchestrator can start on Claude.
    return (
      Layer.mergeAll(
        HiddenPrsLive,
        PrAppToolsLive,
        ReviewAppToolsLive,
        ReadAppToolsLive,
        WrapUpAppToolsLive,
        ReviewRequestAppToolsLive,
        OrchestrationAppToolsLive,
        OrchestratorAppToolsLive,
        SettingsAppToolsLive,
        IssueAppToolsLive,
        BrowserAppToolsLive.pipe(Layer.provide(PanePort.layer)),
        DevServerAppToolsLive,
        ThreadAssistLive,
      )
        // Above the merges, which it asks again when a dependency merges; a `pipe` takes twenty.
        .pipe(Layer.provideMerge(PrDependenciesLive))
        .pipe(
          Layer.provideMerge(MergeWhenReadyLive),
          Layer.provideMerge(IssueReporter.layer),
          Layer.provideMerge(Layer.mergeAll(DreamsLive, ThreadArchiverLive, WorktreeSweepLive)),
          Layer.provideMerge(Layer.mergeAll(DreamFiles.layer, ThreadArchive.layer)),
          Layer.provideMerge(OrchestrationLive),
          // Gram's own full checks, which the solo merge policy accepts in place of CI, under the
          // orchestration whose ledger shows them.
          Layer.provideMerge(
            Layer.mergeAll(
              LocalChecksLive.pipe(Layer.provide(LocalCheckRunner.layer)),
              LaunchChecksCache.layer,
            ),
          ),
          Layer.provideMerge(OrchestrationMemory.layer),
          Layer.provideMerge(Layer.mergeAll(BabysitLive, RunMonitorLive, ThreadWakesLive)),
          Layer.provideMerge(PlanKeeperLive),
          Layer.provideMerge(GitStatePublisherLive),
          Layer.provideMerge(ReviewRequestsLive),
          Layer.provideMerge(Layer.mergeAll(HelperScheduler.layer, ComposerPresence.layer)),
          Layer.provideMerge(ThreadVisibility.layer),
          Layer.provideMerge(ThreadPorts.layer),
          Layer.provideMerge(ProcessRoots.layer),
          // The outputs service observes the runtimes for files their threads produce; the browser
          // tools record evidence there too.
          Layer.provideMerge(Layer.mergeAll(AppToolRegistry.layer, WorkspaceOutputs.layer)),
          // The runtimes read the limit readings, which a limit wait falls back on for its reset.
          Layer.provideMerge(
            Layer.mergeAll(ThreadRuntimes.layer, UsageLimitPoller.layer).pipe(
              Layer.provideMerge(UsageLimitReadings.layer),
            ),
          ),
          Layer.provideMerge(Layer.mergeAll(GitCheckoutLive, ClaudeAiSeenLive)),
          Layer.provideMerge(
            // Low enough for the port scan and the limit poll to rest while no window shows.
            Layer.mergeAll(EventHub.layer, TerminalGate.layer, PreviewFiles.layer, AppActivityLive),
          ),
          Layer.provideMerge(
            ThreadStore.layerSqlite(databaseFile, {
              checkpointOffLoop: databaseFile !== ":memory:",
            }),
          ),
        )
    );
  }),
);

// Pinned ws implements closeTimeout; its bundled @types/ws has not declared it yet.
const websocketOptions: NodeHttpServer.Options["websocket"] & { readonly closeTimeout: number } = {
  closeTimeout: 1_000,
};

/** Requests can arrive between removal of the scoped handler and the listener's final close. */
const createHttpListener = () => {
  const server = createServer();
  server.on("request", (_request, response) => {
    // NodeHttpServer owns the other request listener while serving. Once that scope closes,
    // a newly parsed request has no effect/response finalizer and would strand server.close.
    // Finish only these unhandled requests; the real handler keeps auth and request ownership.
    if (server.listenerCount("request") !== 1) return;
    response.writeHead(503, { connection: "close" });
    response.end();
  });
  return server;
};

/** The HTTP + WebSocket server on 127.0.0.1, with the core services it serves. */
export const ServerLayer: Layer.Layer<
  HttpServer.HttpServer | LaunchToken | McpTokens | ThreadRuntimes | ThreadStore | EventHub,
  unknown,
  AgentHosts | ServerConfig | GitPlatform | TurnHooks
> = Layer.unwrap(
  Effect.gen(function* () {
    const { port } = yield* ServerConfig;
    return HttpRouter.serve(Layer.mergeAll(RpcRoutes, StaticRoutes, McpRoute, AuthMiddleware), {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
      Layer.merge(LoopStallLog),
      Layer.provideMerge(ServerCore),
      Layer.provideMerge(McpTokens.layer),
      Layer.provideMerge(LaunchToken.layer),
      Layer.provideMerge(
        NodeHttpServer.layer(createHttpListener, {
          host: "127.0.0.1",
          port,
          // Close request/WebSocket scopes before awaiting the listener's final close. The
          // preemptive grace timeout interrupts a cached close effect; its later finalizer then
          // repeats that interruption even after the sockets close, failing orderly teardown.
          // Main's server-stop deadline still bounds the entire teardown and refuses updates on
          // timeout or any real close/finalizer failure.
          disablePreemptiveShutdown: true,
          // A hidden/suspended renderer may never answer the close frame. The ws default
          // waits 30 s, exceeding main's 10 s server deadline after sessions have stopped.
          // Bound only the peer handshake; request scopes and all service finalizers still
          // have to finish before shutdown can be attested.
          websocket: websocketOptions,
        }),
      ),
    );
  }),
);
