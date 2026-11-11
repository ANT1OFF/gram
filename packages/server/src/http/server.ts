import { DecisionHook } from "../embedding/decision-hook.ts";
import { EventSink } from "../embedding/event-sink.ts";
import { UsageLimitPoller } from "../usage/limit-poller.ts";
import { PlanKeeperLive } from "../plans/keeper.ts";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { GramRpcs } from "@gram/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Option from "effect/Option";
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
import { WorkspaceAppToolsLive } from "../settings/workspace-tools.ts";
import { PrAppToolsLive } from "../app-tools/pr-tools.ts";
import { ReadAppToolsLive } from "../app-tools/read-tools.ts";
import { WrapUpAppToolsLive } from "../app-tools/wrap-up-tool.ts";
import { DocAppToolsLive } from "../app-tools/doc-tools.ts";
import { Docs } from "../docs/docs.ts";
import { ReviewRequestAppToolsLive } from "../app-tools/review-request-tools.ts";
import { AppToolRegistry } from "../app-tools/registry.ts";
import { ReviewAppToolsLive } from "../babysit/review-tools.ts";
import { PanePort } from "../browser/pane-port.ts";
import { BrowserAppToolsLive } from "../browser/tools.ts";
import { DevServerAppToolsLive } from "../browser/dev-server-tools.ts";
import { PrCommentWakesLive } from "../babysit/pr-comments.ts";
import { PrCommentReads } from "../git/pr-comments.ts";
import { BabysitLive } from "../babysit/service.ts";
import { HiddenPrsLive } from "../git/hidden-prs.ts";
import { WorktreeSweepLive } from "../git/worktree-gc.ts";
import { ThreadArchive, ThreadArchiverLive } from "../orchestration/archive.ts";
import { DreamFiles } from "../orchestration/dream-files.ts";
import { DreamsLive } from "../orchestration/dreams.ts";
import { OrchestrationMemory } from "../orchestration/memory.ts";
import { OrchestrationLive } from "../orchestration/service.ts";
import { RoutineEventSourcesLive } from "../routines/events.ts";
import { RoutinesLive } from "../routines/routines.ts";
import { RoutineAppToolsLive } from "../routines/tools.ts";
import { ComposerPresence } from "../runtime/composer-presence.ts";
import { OrchestratorAppToolsLive } from "../orchestration/tools.ts";
import { LOOPBACK_HOST, ServerConfig } from "../config.ts";
import { EventHub } from "../events/event-hub.ts";
import { TerminalGate } from "../terminal/gate.ts";
import { HostTerminals } from "../terminal/host-terminals.ts";
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
import { BranchHeadsLive } from "../wakes/branch-heads.ts";
import { CiJobsLive } from "../wakes/ci-stuck.ts";
import { wakeConditionsLayer } from "../wakes/condition-sources.ts";
import { InstalledVersionsLive } from "../wakes/installed-versions.ts";
import { UpstreamReleasesLive } from "../wakes/upstream-releases.ts";
import { MachineStateLive } from "../wakes/machine.ts";
import { AutoMergesLive } from "../git/auto-merges.ts";
import { AppActivityLive } from "../git/activity.ts";
import { ThreadVisibility } from "../git/visibility.ts";
import type { GitPlatform } from "../git/platform.ts";
import { LoopStallLog } from "../logging/loop-stalls.ts";
import { serverDatabaseFile } from "../persistence/database-file.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { embeddingEnabled, withEmbeddingSeed } from "../settings/embedding.ts";
import { ActorGuard, FrontedSignIn } from "../rpc/actor-guard.ts";
import { markActor, unmarkActor } from "./actor.ts";
import {
  IDENTITY_HEADER,
  SOCKET_LIFETIME_MS,
  verifyIdentity,
  type Actor,
} from "./fronted-identity.ts";
import { PreviewFiles } from "../preview/files.ts";
import { agentHostsOrHeadless, withHeadlessCheck } from "../host/headless.ts";
import { LocalHostProcess } from "../host/local-process.ts";
import { AgentHostsThroughHost } from "../runtime/host-agent-sessions.ts";
import { WorkerHosts } from "../host/worker-host.ts";
import { markLocalApp, unmarkLocalApp } from "./local-app.ts";
import { ProcessRoots, ThreadPorts } from "../ports/service.ts";
import {
  Headers,
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
import { HOST_STOP_PATHS, hostStopRoute } from "./host-stop-routes.ts";
import { UsageLimitReadings } from "../usage/limit-readings.ts";
import { WorkspaceOutputs } from "../outputs/workspace-outputs.ts";
import {
  pairingCsp,
  pairingDocument,
  unpairedCsp,
  unpairedDocument,
  SESSION_LIFETIME_MS,
  REMOTE_CONNECT_PATH,
  REMOTE_CLAIM_PATH,
} from "./remote-access.ts";
import { closedOnRevoke, REMOTE_MANAGEMENT_PATHS, remoteManagement } from "./remote-routes.ts";
import { RemoteControl } from "./remote-control.ts";
import { WORKSPACE_TRANSFER_PATHS, WorkspaceTransferRoutes } from "../transfer/routes.ts";
import { WorkspaceTransfer } from "../transfer/workspace-transfer.ts";
import {
  claudeTokenCaptureFor,
  HOST_PATHS,
  hostRoute,
  MACHINE_MANAGEMENT_PATHS,
  provisionedRoute,
  machineManagement,
  placedOnMachine,
} from "./machine-routes.ts";
import { releaseOfConfig, RemoteHosts } from "../host/remote-hosts.ts";
import { authTarget } from "./auth-target.ts";
import {
  authorize,
  contentSecurityPolicy,
  makeLaunchToken,
  MCP_PATH,
  tokenCookieName,
} from "./auth.ts";
import { HOST_MCP_PATH } from "../host/machine-keys.ts";
import {
  ProvisionedListener,
  ViaProvisionedListener,
  withProvisionedListener,
} from "./provisioned-listener.ts";

/** How often the provisioned-host listener and its hosts are held to the hosted-features switch. */
const PROVISIONED_SWITCH_POLL = Duration.seconds(3);

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
    const control = yield* RemoteControl;
    // Absent only in tests that serve the middleware alone: no machine can join or dial in then.
    const remoteHosts = Option.getOrUndefined(yield* Effect.serviceOption(RemoteHosts));
    // A joined machine's folders for the one-off chat's picker, reached only from the local app.
    const workerHosts = Option.getOrUndefined(yield* Effect.serviceOption(WorkerHosts));
    const tokenCapture =
      remoteHosts === undefined ? undefined : yield* claudeTokenCaptureFor(remoteHosts);
    // Access opened, closed or moved, by the switch or by recovery: joined machines' connections
    // and dials follow it, so none outlives the address it came in on.
    if (remoteHosts !== undefined) control.watch((origin) => remoteHosts.keepOrigin(origin));
    const store = Option.getOrUndefined(yield* Effect.serviceOption(ThreadStore));
    /**
     * Whether provisioned hosts are on: one of the hosted features, read at each dial and each
     * registration so the switch holds at once.
     */
    const provisionedOn =
      store === undefined
        ? Effect.succeed(false)
        : Effect.provideService(embeddingEnabled, ThreadStore, store);
    // The listener is bound only while the switch is on, and hosts connected when it goes off
    // are dropped: both within a few seconds of the change. They stay registered. A switch that
    // can't be read counts as off.
    const listener = Option.getOrUndefined(yield* Effect.serviceOption(ProvisionedListener));
    if (remoteHosts?.provisionedOrigin !== undefined)
      yield* provisionedOn.pipe(
        Effect.catchCause(() => Effect.succeed(false)),
        Effect.tap((on) => (on ? Effect.void : Effect.sync(remoteHosts.closeProvisioned))),
        Effect.tap((on) => listener?.setOpen(on) ?? Effect.void),
        Effect.catchCause(() => Effect.void),
        Effect.repeat(Schedule.spaced(PROVISIONED_SWITCH_POLL)),
        Effect.forkScoped,
      );
    // Stopping a joined machine and resuming its threads: a hosted feature, local app only.
    const runtimes = Option.getOrUndefined(yield* Effect.serviceOption(ThreadRuntimes));
    const stopDeps =
      remoteHosts === undefined || store === undefined || runtimes === undefined
        ? undefined
        : { hosts: remoteHosts, store, runtimes, settings: store };
    // Absent only in tests that serve the middleware alone, which take the launch token.
    const fronted = Option.getOrUndefined(yield* Effect.serviceOption(FrontedSignIn));
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
        // The provisioned-host listener serves a host's dial and its sessions' app tools, by their
        // own proofs, and nothing a browser or the local app reaches: decided before any of it.
        if (yield* ViaProvisionedListener)
          return HttpServerResponse.setHeaders(
            yield* provisionedRoute(remoteHosts, path, yield* provisionedOn, (origin) =>
              Effect.gen(function* () {
                return remoteHosts !== undefined &&
                  (yield* placedOnMachine(mcpTokens, store, remoteHosts, request.headers, origin))
                  ? yield* httpEffect
                  : HttpServerResponse.text("unauthorized: not a thread on a provisioned host", {
                      status: 401,
                    });
              }),
            ),
            securityHeaders,
          );
        const remote = control.current();
        const isRemote = remote !== undefined && request.headers["host"] === remote.host;
        // People sign in through a fronting proxy: its signed statement, on every request, in
        // place of the launch cookie and of a phone's pairing. A thread's agent on this machine
        // still reaches its app tools by its own token over loopback, and a joined machine's host
        // by its own proof, below.
        const identity =
          fronted?.config !== undefined &&
          (yield* fronted.active) &&
          // A person's request never goes there, so one that names a person isn't let by.
          !(path === MCP_PATH && !isRemote && request.headers[IDENTITY_HEADER] === undefined) &&
          !(
            isRemote &&
            path !== undefined &&
            (path === HOST_MCP_PATH || HOST_PATHS.has(path)) &&
            request.headers[IDENTITY_HEADER] === undefined
          )
            ? fronted.config
            : undefined;
        const secureResponse = (response: HttpServerResponse.HttpServerResponse) =>
          HttpServerResponse.setHeaders(response, {
            ...securityHeaders,
            ...(identity !== undefined
              ? { "content-security-policy": contentSecurityPolicy(port, identity.origin) }
              : isRemote
                ? { "content-security-policy": contentSecurityPolicy(port, remote.origin) }
                : {}),
          });
        if (identity !== undefined) {
          if (target === undefined)
            return secureResponse(
              HttpServerResponse.text("forbidden: request target", { status: 403 }),
            );
          // A browser names the page a request comes from; only the proxy's own origin may ask.
          const origin = request.headers["origin"];
          if (origin !== undefined && origin !== identity.origin)
            return secureResponse(
              HttpServerResponse.text("forbidden: foreign origin", { status: 403 }),
            );
          const stated = verifyIdentity(identity, request.headers[IDENTITY_HEADER]);
          if (!stated.ok) {
            // Why is for the log alone: a caller learns nothing about what a statement lacked.
            yield* Effect.logInfo("refused a request without a valid signed identity").pipe(
              Effect.annotateLogs({ reason: stated.reason }),
            );
            return secureResponse(
              HttpServerResponse.text("unauthorized: signed identity required", { status: 401 }),
            );
          }
          // Phone access, joining machines and moving a workspace are for this machine's own
          // sign-in, which a fronted server doesn't have. The agents' and hosts' routes take a thread's token or a host's
          // proof, never a person: a person let through to them would act with neither a role
          // nor a record.
          if (
            REMOTE_MANAGEMENT_PATHS.has(target.path) ||
            MACHINE_MANAGEMENT_PATHS.has(target.path) ||
            WORKSPACE_TRANSFER_PATHS.has(target.path) ||
            HOST_PATHS.has(target.path) ||
            target.path === MCP_PATH ||
            target.path === HOST_MCP_PATH
          )
            return secureResponse(
              HttpServerResponse.text("forbidden: not available behind a proxy", { status: 403 }),
            );
          const served = asCaller(
            httpEffect,
            unmarkLocalApp(
              request.modify({ headers: Headers.remove(request.headers, IDENTITY_HEADER) }),
            ),
            stated.actor,
          );
          return secureResponse(
            target.path === "/ws"
              ? // A socket keeps the person and role it opened with, so it is closed after a
                // while: the app connects again, and the proxy states who they are now.
                yield* Effect.raceFirst(
                  served,
                  Effect.as(
                    Effect.sleep(identity.socketLifetimeMs ?? SOCKET_LIFETIME_MS),
                    HttpServerResponse.text("signed out", { status: 401 }),
                  ),
                )
              : yield* served,
          );
        }
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
          // The access this request came in on must still be the one serving: access closed or
          // reopened while the body was read (even at the same address) refuses the claim.
          const session =
            code.length === 64 && control.current() === remote
              ? remote.claim(authRequest, code)
              : undefined;
          if (session === undefined)
            return secureResponse(HttpServerResponse.text("pairing refused", { status: 403 }));
          const response = yield* HttpServerResponse.text("paired").pipe(
            HttpServerResponse.setCookie(remote.cookieName, session, {
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
        // A session on a joined machine reaching its thread's app tools: the thread's own token,
        // let through only while that thread is placed on a machine that is online now.
        if (isRemote && path === HOST_MCP_PATH) {
          const allowed =
            request.method === "POST" &&
            request.headers["origin"] === undefined &&
            remoteHosts !== undefined &&
            (yield* placedOnMachine(mcpTokens, store, remoteHosts, request.headers, remote.origin));
          return secureResponse(
            allowed
              ? yield* httpEffect
              : HttpServerResponse.text("unauthorized: not a thread on a joined machine", {
                  status: 401,
                }),
          );
        }
        // A joined machine's host joining or dialling in: its own proof, never a browser's cookie.
        if (isRemote && path !== undefined && HOST_PATHS.has(path))
          return secureResponse(
            remoteHosts === undefined
              ? HttpServerResponse.text("forbidden", { status: 403 })
              : yield* hostRoute(
                  remoteHosts,
                  remote,
                  path,
                  // A release is downloaded only for a packaged build, whose build is a commit.
                  config.appBuild !== undefined && /^[a-f0-9]{40}$/.test(config.appBuild)
                    ? config.appVersion
                    : undefined,
                ),
          );
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
              path !== undefined && REMOTE_MANAGEMENT_PATHS.has(path)
                ? yield* remoteManagement(control, path, isRemote ? remote : undefined)
                : path !== undefined && HOST_STOP_PATHS.has(path)
                  ? isRemote || stopDeps === undefined
                    ? HttpServerResponse.text("forbidden: local access only", { status: 403 })
                    : yield* hostStopRoute(stopDeps, path)
                  : // A workspace's bundle leaves and arrives through the local app only.
                    isRemote && path !== undefined && WORKSPACE_TRANSFER_PATHS.has(path)
                    ? HttpServerResponse.text("forbidden: local access only", { status: 403 })
                    : path !== undefined && MACHINE_MANAGEMENT_PATHS.has(path)
                      ? isRemote || remoteHosts === undefined
                        ? HttpServerResponse.text("forbidden: local access only", { status: 403 })
                        : yield* machineManagement(
                            remoteHosts,
                            control.current(),
                            path,
                            releaseOfConfig(config),
                            undefined,
                            tokenCapture,
                            control.dialAccess(),
                            workerHosts === undefined
                              ? undefined
                              : (id) => workerHosts.machine(id).folders,
                            yield* provisionedOn,
                          )
                      : isRemote && path === "/ws"
                        ? yield* closedOnRevoke(
                            remote,
                            remote.sessionOf(authRequest),
                            asCaller(httpEffect, unmarkLocalApp(request)),
                          )
                        : // The local app's own connection, which the RPC handlers can tell apart
                          // from a phone's (`isLocalApp`); anything else says nothing of itself.
                          yield* asCaller(
                            httpEffect,
                            !isRemote && path === "/ws"
                              ? markLocalApp(request)
                              : unmarkLocalApp(request),
                          );
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
            // A phone opening Gram unpaired, or after it was removed, gets a page saying so.
            if (
              isRemote &&
              decision.status === 401 &&
              request.method === "GET" &&
              (request.headers["accept"] ?? "").includes("text/html")
            )
              return HttpServerResponse.setHeaders(
                HttpServerResponse.text(unpairedDocument, {
                  status: 401,
                  contentType: "text/html; charset=utf-8",
                }),
                { ...securityHeaders, "content-security-policy": unpairedCsp },
              );
            response = HttpServerResponse.text(decision.message, { status: decision.status });
            break;
        }
        return secureResponse(response);
      });
  }),
  { global: true },
);

/** `effect` served as `request`, the caller as the auth middleware decided it is. */
const asCaller = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  request: HttpServerRequest.HttpServerRequest,
  actor?: Actor,
) =>
  Effect.provideService(
    effect,
    HttpServerRequest.HttpServerRequest,
    // Only a verified statement names an actor: any other caller's word for one is taken off.
    actor === undefined ? unmarkActor(request) : markActor(request, actor),
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

// Every RPC behind the actor guard, which does nothing unless people sign in through a proxy.
const RpcRoutes = rpcRoutes(GramRpcs.middleware(ActorGuard), RpcHandlersLayer).pipe(
  Layer.provide(ActorGuard.layer),
);

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
        DocAppToolsLive,
        ReviewRequestAppToolsLive,
        OrchestrationAppToolsLive,
        OrchestratorAppToolsLive,
        RoutineAppToolsLive,
        SettingsAppToolsLive,
        WorkspaceAppToolsLive,
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
          Layer.provideMerge(
            Layer.mergeAll(
              DreamsLive,
              // Event routines read GitHub's branches and releases through their own readers.
              RoutinesLive.pipe(
                Layer.provide(
                  RoutineEventSourcesLive.pipe(
                    Layer.provide(Layer.mergeAll(BranchHeadsLive, UpstreamReleasesLive)),
                  ),
                ),
              ),
              ThreadArchiverLive,
              WorktreeSweepLive,
            ),
          ),
          Layer.provideMerge(Layer.mergeAll(DreamFiles.layer, ThreadArchive.layer)),
          Layer.provideMerge(OrchestrationLive),
          // Gram's own full checks, which the solo merge policy accepts in place of CI, under the
          // orchestration whose ledger shows them.
          Layer.provideMerge(LocalChecksLive.pipe(Layer.provide(LocalCheckRunner.layer))),
          Layer.provideMerge(OrchestrationMemory.layer),
          Layer.provideMerge(
            Layer.mergeAll(
              BabysitLive,
              PrCommentWakesLive.pipe(Layer.provide(PrCommentReads.layer)),
              RunMonitorLive,
              ThreadWakesLive,
            ),
          ),
          // The condition wakes' engine, under the wakes and the orchestration, which keep the
          // wakes its sources look at.
          Layer.provideMerge(
            Layer.mergeAll(
              PlanKeeperLive,
              wakeConditionsLayer(
                Layer.mergeAll(
                  BranchHeadsLive,
                  CiJobsLive,
                  MachineStateLive,
                  AutoMergesLive,
                  UpstreamReleasesLive,
                  InstalledVersionsLive,
                ),
              ),
            ),
          ),
          // Below the condition wakes, whose `versionChanged` reads a CLI's version off its runs.
          Layer.provideMerge(
            Layer.mergeAll(
              GitStatePublisherLive,
              // A headless server looks for no CLI on this machine: its agents are its machines'.
              config.headless === true ? LaunchChecksCache.layerNone : LaunchChecksCache.layer,
            ),
          ),
          Layer.provideMerge(ReviewRequestsLive),
          Layer.provideMerge(Layer.mergeAll(HelperScheduler.layer, ComposerPresence.layer)),
          Layer.provideMerge(ThreadVisibility.layer),
          Layer.provideMerge(ThreadPorts.layer),
          // The outputs service observes the runtimes for files their threads produce; the browser
          // tools record evidence there too.
          // The docs a workspace's threads publish (`publish_doc`), kept in Gram's state.
          Layer.provideMerge(
            Layer.mergeAll(AppToolRegistry.layer, WorkspaceOutputs.layer, Docs.layer),
          ),
          // The runtimes read the limit readings, which a limit wait falls back on for its reset.
          Layer.provideMerge(
            Layer.mergeAll(ThreadRuntimes.layer, UsageLimitPoller.layer).pipe(
              Layer.provideMerge(UsageLimitReadings.layer),
            ),
          ),
          // The machines work runs on: this one, over its agents, checkouts, git, files, terminals
          // and port scan, and the machines joined to it. One host process serves this machine's
          // worker host, the worktrees its checkouts make, and the Claude sessions it can run.
          // `CheckoutService` above here makes each thread's checkout on the machine it is placed on.
          Layer.provideMerge(WorkerHosts.placedCheckouts),
          Layer.provideMerge(
            WorkerHosts.layerLocalOn.pipe(
              Layer.provideMerge(
                Layer.mergeAll(
                  GitCheckoutLive.pipe(Layer.provide(LocalHostProcess.worktrees)),
                  ClaudeAiSeenLive,
                  HostTerminals.layer,
                  // A headless server has no agents of its own, whatever it was given.
                  agentHostsOrHeadless(AgentHostsThroughHost),
                ),
              ),
              // Nor a host process: nothing of a thread's runs on this machine.
              Layer.provideMerge(
                config.headless === true
                  ? LocalHostProcess.layerWith({ hostProcess: false })
                  : LocalHostProcess.layer,
              ),
            ),
          ),
          // The decision hook and event sink of an embedding deployment: both do nothing unless
          // their endpoint is configured and hosted features are on. Under the runtimes and the
          // orchestration, which ask the one and tell the other.
          Layer.provideMerge(
            DecisionHook.layer.pipe(
              Layer.provideMerge(EventSink.layer),
              Layer.provideMerge(
                // Low enough for the port scan and the limit poll to rest while no window shows.
                Layer.mergeAll(
                  EventHub.layer,
                  TerminalGate.layer,
                  PreviewFiles.layer,
                  AppActivityLive,
                  ProcessRoots.layer,
                ),
              ),
            ),
          ),
          Layer.provideMerge(
            // `GRAM_EMBEDDING` first, since a headless server needs the hosted features on.
            withHeadlessCheck(
              withEmbeddingSeed(
                ThreadStore.layerSqlite(databaseFile, {
                  checkpointOffLoop: databaseFile !== ":memory:",
                  writerOffLoop: databaseFile !== ":memory:",
                }),
              ),
            ),
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
  | HttpServer.HttpServer
  | ProvisionedListener
  | LaunchToken
  | McpTokens
  | ThreadRuntimes
  | ThreadStore
  | EventHub,
  unknown,
  AgentHosts | ServerConfig | GitPlatform | TurnHooks
> = Layer.unwrap(
  Effect.gen(function* () {
    const { port, listenHost, provisionedHosts } = yield* ServerConfig;
    /** The app's own listener, and the provisioned hosts' TLS one beside it when configured. */
    const listeners = (options: NodeHttpServer.Options) =>
      withProvisionedListener(
        NodeHttpServer.layerServer(createHttpListener, options),
        provisionedHosts,
        options,
      );
    return HttpRouter.serve(
      Layer.mergeAll(
        RpcRoutes,
        StaticRoutes,
        McpRoute,
        WorkspaceTransferRoutes.pipe(Layer.provide(WorkspaceTransfer.layer)),
        AuthMiddleware,
      ),
      {
        disableListenLog: true,
        disableLogger: true,
      },
    ).pipe(
      Layer.merge(LoopStallLog),
      Layer.provide(FrontedSignIn.layer),
      Layer.provideMerge(ServerCore),
      Layer.provide(RemoteControl.layer),
      Layer.provideMerge(RemoteHosts.layer),
      Layer.provideMerge(McpTokens.layer),
      Layer.provideMerge(LaunchToken.layer),
      Layer.provideMerge(NodeHttpServer.layerHttpServices),
      Layer.provideMerge(
        listeners({
          host: listenHost ?? LOOPBACK_HOST,
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
