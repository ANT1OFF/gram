import { join } from "node:path";
import { NOBODY, ReadingAs, SERVER } from "../embedding/readable-by.ts";
import { KeptSessions } from "../runtime/kept-sessions.ts";
import { answerAsk, ASK_ANSWER_PATH } from "../embedding/ask-answer.ts";
import { DecisionHook } from "../embedding/decision-hook.ts";
import { GitHubRelayLive } from "../embedding/github-relay.ts";
import { type AnswerNote, EventSink } from "../embedding/event-sink.ts";
import { UsageLimitPoller } from "../usage/limit-poller.ts";
import { PlanKeeperLive } from "../plans/keeper.ts";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { GramRpcs, type RequestId } from "@gram/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schedule from "effect/Schedule";
import * as Option from "effect/Option";
import * as ByteSize from "effect/ByteSize";
import * as Layer from "effect/Layer";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { McpRoute } from "../app-tools/http-mcp.ts";
import { ClaudeAiSeenLive } from "../connectors/claude-ai-seen.ts";
import { McpTokens } from "../app-tools/mcp-tokens.ts";
import { OrchestrationAppToolsLive } from "../app-tools/orchestration-tools.ts";
import { ConversationAppToolsLive } from "../app-tools/conversation-tools.ts";
import { Conversations } from "../embedding/conversations.ts";
import { SentWorkPort } from "../embedding/sent-work-port.ts";
import { SentWorkersLive } from "../orchestration/sent-workers.ts";
import { SettingsAppToolsLive } from "../settings/chat-tools.ts";
import { McpProposeAppToolsLive } from "../connectors/mcp-propose.ts";
import { ConnectorConfigs } from "../rpc/handlers/connectors.ts";
import { WorkspaceAppToolsLive } from "../settings/workspace-tools.ts";
import { PrAppToolsLive } from "../app-tools/pr-tools.ts";
import { ReadAppToolsLive } from "../app-tools/read-tools.ts";
import { WrapUpAppToolsLive } from "../app-tools/wrap-up-tool.ts";
import { DocAppToolsLive } from "../app-tools/doc-tools.ts";
import { PageAppToolsLive } from "../app-tools/page-tools.ts";
import { Docs } from "../docs/docs.ts";
import { ReviewRequestAppToolsLive } from "../app-tools/review-request-tools.ts";
import { AppToolRegistry } from "../app-tools/registry.ts";
import { ReviewAppToolsLive } from "../babysit/review-tools.ts";
import { BrowserFamilyAppToolsLive } from "../browser/app-tools.ts";
import { VerifyAppToolsLive, VerifyStatusLive } from "../verify/verify-tools.ts";
import { PrCommentWakesLive } from "../babysit/pr-comments.ts";
import { PrCommentReads } from "../git/pr-comments.ts";
import { BabysitLive } from "../babysit/service.ts";
import { HiddenPrsLive } from "../git/hidden-prs.ts";
import { WorktreeSweepLive } from "../git/worktree-gc.ts";
import { ThreadArchive, ThreadArchiverLive } from "../orchestration/archive.ts";
import { DreamFiles } from "../orchestration/dream-files.ts";
import { DreamsLive } from "../orchestration/dreams.ts";
import { OrchestrationMemory } from "../orchestration/memory.ts";
import { questionAnswerer } from "../orchestration/dream-handler.ts";
import { Orchestration, OrchestrationLive } from "../orchestration/service.ts";
import { WorkerMachineReleaseLive } from "../embedding/worker-machine-release.ts";
import { IdleMeasureLive } from "../embedding/idle-measure-live.ts";
import { WorkerMachineSourcesLive } from "../embedding/worker-machine-sources.ts";
import { RoutineEventSourcesLive } from "../routines/events.ts";
import { RoutinesLive } from "../routines/routines.ts";
import { RoutineAppToolsLive } from "../routines/tools.ts";
import { ComposerPresence } from "../runtime/composer-presence.ts";
import { OrchestratorAppToolsLive } from "../orchestration/tools.ts";
import { TranscriptSearchAppToolsLive } from "../orchestration/transcript-search-tool.ts";
import { TranscriptReadAppToolsLive } from "../orchestration/transcript-read-tool.ts";
import { LOOPBACK_HOST, ServerConfig } from "../config.ts";
import { Embedding } from "../embedding/embedding.ts";
import { EmbedInbound, EMBED_PREFIX } from "../embedding/inbound.ts";
import { RepoEventsInboundLive } from "../embedding/repo-events.ts";
import { OnDemand, ON_DEMAND_PATHS, onDemandRequest } from "../embedding/on-demand.ts";
import { ThreadMessagesInboundLive } from "../embedding/thread-messages.ts";
import { ConversationFilesInboundLive } from "../embedding/conversation-files.ts";
import { ThreadImportsInboundLive } from "../embedding/thread-imports.ts";
import { ThreadStartsInboundLive } from "../embedding/thread-starts.ts";
import { ThreadNotesInboundLive } from "../embedding/thread-notes.ts";
import { IdleStopInboundLive } from "../embedding/idle-stop.ts";
import { ObjectStoreLive } from "../embedding/object-store.ts";
import { TimersLive } from "../embedding/timers.ts";
import { SuppliedSettingsLive } from "../settings/supplied.ts";
import { EventHub } from "../events/event-hub.ts";
import { TerminalGate } from "../terminal/gate.ts";
import { HostTerminals } from "../terminal/host-terminals.ts";
import { GitCheckoutLive, GitStatePublisherLive } from "../git/index.ts";
import { LocalCheckRunner, LocalChecksLive } from "../git/local-checks.ts";
import { MergeWhenReadyLive } from "../git/merge-when-ready.ts";
import { RunMonitorLive } from "../git/run-monitor.ts";
import { MainWatchLive } from "../wakes/main-watch.ts";
import { IssueReporter } from "../issues/reporter.ts";
import { IssueAppToolsLive } from "../issues/tools.ts";
import { LaunchChecksCache } from "../launch-checks/handler.ts";
import { ReviewRequestsLive } from "../github/review-requests.ts";
import { PrDependenciesLive } from "../wakes/pr-dependencies.ts";
import { ThreadWakesLive } from "../wakes/thread-wakes.ts";
import { MachinePreWake } from "../host/pre-wake.ts";
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
import { DEVICE_CONNECT_PATH } from "../device/devices.ts";
import { deviceStatement, LentDevices, NOT_A_DEVICE } from "../device/service.ts";
import { LentDevicesLive } from "../device/tools.ts";
import { markActor, unmarkActor } from "./actor.ts";
import {
  IDENTITY_HEADER,
  SERVICE_ROLE,
  SOCKET_LIFETIME_MS,
  verifyIdentity,
  type Actor,
} from "./fronted-identity.ts";
import { PreviewFiles } from "../preview/files.ts";
import { PageFiles } from "../pages/page-files.ts";
import { Pages } from "../pages/pages.ts";
import { agentHostsOrHeadless, withHeadlessCheck } from "../host/headless.ts";
import { LocalHostProcess } from "../host/local-process.ts";
import { AgentHostsThroughHost } from "../runtime/host-agent-sessions.ts";
import { WorkerHosts } from "../host/worker-host.ts";
import { mayReachThread, ownersOf, ServerWork } from "../host/ownership.ts";
import { AppShell, StaticRoutes } from "./app-shell.ts";
import { markLocalApp, unmarkLocalApp } from "./local-app.ts";
import { ProcessRoots, ThreadPorts } from "../ports/service.ts";
import {
  Headers,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
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
import { startMachineUpkeep } from "./machine-upkeep.ts";
import { makeMachineJobs } from "../host/machine-jobs.ts";
import { UsageLimitReadings } from "../usage/limit-readings.ts";
import { WorkspaceOutputs } from "../outputs/workspace-outputs.ts";
import { SharedFolders } from "../shared/shared-folders.ts";
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
import {
  SentWorkRoutes,
  THREAD_SEND_CHECK_PATH,
  THREAD_SEND_PATH,
  THREAD_SEND_MACHINE_PATH,
} from "../orchestration/sent-work-routes.ts";
import {
  PROFILE_MOVE_PATH,
  PROFILE_START_PATH,
  PROFILE_WAIT_PATH,
  PROFILE_START_RECORD,
  THREAD_READERS_PATH,
  ProfileStartRoutes,
} from "../thread-profiles/routes.ts";
import { ProfileStarters } from "../thread-profiles/service.ts";
import { ThreadTransfer } from "../transfer/thread-transfer.ts";
import { WorkspaceTransfer } from "../transfer/workspace-transfer.ts";
import {
  claudeTokenCaptureFor,
  HOST_PATHS,
  hostRoute,
  MACHINE_MANAGEMENT_PATHS,
  MACHINES_LIST_PATH,
  MACHINES_PROVISION_PATH,
  MACHINES_REMOVE_PATH,
  provisionedRoute,
  machineManagement,
  placedOnMachine,
} from "./machine-routes.ts";
import { releaseOfConfig } from "../host/releases.ts";
import { RemoteHosts, type RemoteHostsShape } from "../host/remote-hosts.ts";
import { authTarget } from "./auth-target.ts";
import {
  authorize,
  ORIGIN_KEY_FRAGMENT,
  contentSecurityPolicy,
  type LaunchSecrets,
  makeLaunchSecrets,
  MCP_PATH,
  tokenCookieName,
} from "./auth.ts";
import { HOST_MCP_PATH } from "../host/machine-keys.ts";
import {
  ProvisionedListener,
  ViaProvisionedListener,
  withProvisionedListener,
} from "./provisioned-listener.ts";

const PROVISIONED_SWITCH_POLL = Duration.seconds(3);

/**
 * What a fronting platform's own statement (`role` `service`) reaches, and all it reaches: the
 * hosts it provisions and stops, and a workspace's way in and out. A person's statement reaches none of
 * them. Before naming another path here, see that its handler needs no person: nothing behind
 * these has a role to check or a window to answer.
 */
export const SERVICE_PATHS: ReadonlySet<string> = new Set([
  MACHINES_PROVISION_PATH,
  MACHINES_REMOVE_PATH,
  MACHINES_LIST_PATH,
  ...HOST_STOP_PATHS,
  ...WORKSPACE_TRANSFER_PATHS,
  PROFILE_START_PATH,
  PROFILE_MOVE_PATH,
  PROFILE_WAIT_PATH,
  THREAD_READERS_PATH,
]);

const recordOf = (response: HttpServerResponse.HttpServerResponse): Record<string, unknown> => {
  const thread = response.headers[PROFILE_START_RECORD.thread];
  if (thread === undefined) return {};
  const host = response.headers[PROFILE_START_RECORD.host];
  const moved = response.headers[PROFILE_START_RECORD.moved];
  return {
    threadId: thread,
    ...(moved === undefined
      ? { created: response.headers[PROFILE_START_RECORD.created] === "true" }
      : { moved: moved === "true" }),
    ...(host === undefined ? {} : { hostId: host }),
  };
};

/** This launch's boot token, cookie and origin key (`LaunchSecrets`). */
export class LaunchToken extends Context.Service<LaunchToken, LaunchSecrets>()(
  "@gram/server/LaunchToken",
) {
  static readonly layer = Layer.sync(LaunchToken, makeLaunchSecrets);
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
    const { token, cookie: launchCookie, originKey } = yield* LaunchToken;
    const shell = yield* Effect.serviceOption(AppShell);
    const config = yield* ServerConfig;
    const mcpTokens = yield* McpTokens;
    const port = serverPort(server);
    const control = yield* RemoteControl;
    const remoteHosts = Option.getOrUndefined(yield* Effect.serviceOption(RemoteHosts));
    const workerHosts = Option.getOrUndefined(yield* Effect.serviceOption(WorkerHosts));
    const tokenCapture =
      remoteHosts === undefined ? undefined : yield* claudeTokenCaptureFor(remoteHosts);
    if (remoteHosts !== undefined) control.watch((origin) => remoteHosts.keepOrigin(origin));
    remoteHosts?.accessFrom(control.dialAccess);
    const store = Option.getOrUndefined(yield* Effect.serviceOption(ThreadStore));
    const embedInbound = Option.getOrUndefined(yield* Effect.serviceOption(EmbedInbound));
    const onDemand = Option.getOrUndefined(yield* Effect.serviceOption(OnDemand));
    const provisionedOn =
      store === undefined
        ? Effect.succeed(false)
        : Effect.provideService(embeddingEnabled, ThreadStore, store);
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
    const runtimes = Option.getOrUndefined(yield* Effect.serviceOption(ThreadRuntimes));
    const orchestration = Option.getOrUndefined(yield* Effect.serviceOption(Orchestration));
    const eventSink = Option.getOrUndefined(yield* Effect.serviceOption(EventSink));
    const hub = Option.getOrUndefined(yield* Effect.serviceOption(EventHub));
    const answerQuestionAsUser =
      orchestration === undefined ||
      hub === undefined ||
      store === undefined ||
      runtimes === undefined
        ? undefined
        : questionAnswerer({ questions: orchestration.memoryQuestions, store, hub, runtimes });
    const sharedFolders = Option.getOrUndefined(yield* Effect.serviceOption(SharedFolders));
    const machineJobs = yield* makeMachineJobs();
    const stopDeps =
      remoteHosts === undefined || store === undefined || runtimes === undefined
        ? undefined
        : {
            hosts: remoteHosts,
            store,
            runtimes,
            settings: store,
            jobs: machineJobs,
            ...(sharedFolders === undefined ? {} : { sharedFlush: sharedFolders.flush }),
          };
    if (stopDeps !== undefined) yield* startMachineUpkeep(stopDeps);
    const fronted = Option.getOrUndefined(yield* Effect.serviceOption(FrontedSignIn));
    const devices = Option.getOrUndefined(yield* Effect.serviceOption(LentDevices));
    const securityHeaders = {
      "content-security-policy": contentSecurityPolicy(port),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    };
    const manageMachines = (hosts: RemoteHostsShape, path: string, provisionedOnly = false) =>
      Effect.flatMap(provisionedOn, (on) =>
        machineManagement(
          hosts,
          control.current(),
          path,
          releaseOfConfig(config),
          undefined,
          tokenCapture,
          control.dialAccess(),
          workerHosts === undefined ? undefined : (id) => workerHosts.machine(id).folders,
          on,
          provisionedOnly,
        ),
      );
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
        if (yield* ViaProvisionedListener)
          return HttpServerResponse.setHeaders(
            yield* Effect.provideService(
              ReadingAs,
              SERVER,
            )(
              provisionedRoute(remoteHosts, path, yield* provisionedOn, (origin) =>
                Effect.gen(function* () {
                  return remoteHosts !== undefined &&
                    (yield* placedOnMachine(mcpTokens, store, remoteHosts, request.headers, origin))
                    ? yield* httpEffect
                    : HttpServerResponse.text("unauthorized: not a thread on a provisioned host", {
                        status: 401,
                      });
                }),
              ),
            ),
            securityHeaders,
          );
        const remote = control.current();
        const isRemote = remote !== undefined && request.headers["host"] === remote.host;
        const identity =
          fronted?.config !== undefined &&
          (yield* fronted.active) &&
          !(path === MCP_PATH && !isRemote && request.headers[IDENTITY_HEADER] === undefined) &&
          !(
            embedInbound !== undefined &&
            !isRemote &&
            path !== undefined &&
            path.startsWith(EMBED_PREFIX) &&
            request.headers[IDENTITY_HEADER] === undefined
          ) &&
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
          const origin = request.headers["origin"];
          if (origin !== undefined && origin !== identity.origin)
            return secureResponse(
              HttpServerResponse.text("forbidden: foreign origin", { status: 403 }),
            );
          const stated = verifyIdentity(identity, request.headers[IDENTITY_HEADER]);
          if (!stated.ok) {
            yield* Effect.logInfo("refused a request without a valid signed identity").pipe(
              Effect.annotateLogs({ reason: stated.reason }),
            );
            return secureResponse(
              HttpServerResponse.text("unauthorized: signed identity required", { status: 401 }),
            );
          }
          if ("device" in stated)
            return secureResponse(
              yield* deviceStatement(devices, target.path, identity.origin, stated.device),
            );
          if (target.path === DEVICE_CONNECT_PATH) return secureResponse(NOT_A_DEVICE);
          if ("service" in stated) {
            const servicePath = target.path;
            if (
              !SERVICE_PATHS.has(servicePath) ||
              stated.service.path !== servicePath ||
              origin !== identity.origin
            ) {
              yield* Effect.logWarning("refused a service statement where it has no business").pipe(
                Effect.annotateLogs({ caller: stated.service.id, path: servicePath }),
              );
              return secureResponse(
                HttpServerResponse.text("forbidden: not for a service", { status: 403 }),
              );
            }
            const { id: serviceId, name: serviceName } = stated.service;
            const asService = unmarkLocalApp(
              request.modify({ headers: Headers.remove(request.headers, IDENTITY_HEADER) }),
            );
            const answered = yield* Effect.provideService(
              ReadingAs,
              SERVER,
            )(
              HOST_STOP_PATHS.has(servicePath)
                ? stopDeps === undefined
                  ? Effect.succeed(
                      HttpServerResponse.text("forbidden: no machines here", { status: 403 }),
                    )
                  : hostStopRoute(stopDeps, servicePath).pipe(
                      Effect.provideService(HttpServerRequest.HttpServerRequest, asService),
                    )
                : MACHINE_MANAGEMENT_PATHS.has(servicePath)
                  ? remoteHosts === undefined
                    ? Effect.succeed(
                        HttpServerResponse.text("forbidden: no machines here", { status: 403 }),
                      )
                    : manageMachines(remoteHosts, servicePath, true).pipe(
                        Effect.provideService(HttpServerRequest.HttpServerRequest, asService),
                      )
                  : asCaller(httpEffect, asService),
            ).pipe(
              Effect.onExit((exit) =>
                store === undefined
                  ? Effect.void
                  : store
                      .appendActorEvents([
                        {
                          at: Date.now(),
                          actor: { id: serviceId, name: serviceName, role: SERVICE_ROLE },
                          action: servicePath,
                          data: Exit.isSuccess(exit)
                            ? { status: exit.value.status, ...recordOf(exit.value) }
                            : Cause.hasInterruptsOnly(exit.cause)
                              ? { interrupted: true }
                              : { failed: true },
                        },
                      ])
                      .pipe(
                        Effect.catchCause((cause) =>
                          Effect.logError("a service call went unrecorded", cause),
                        ),
                      ),
              ),
            );
            return secureResponse(answered);
          }
          if (
            ON_DEMAND_PATHS.has(target.path) &&
            onDemand !== undefined &&
            remoteHosts !== undefined
          )
            return secureResponse(
              yield* onDemandRequest(
                onDemand,
                () => remoteHosts.list(),
                request,
                target.path,
                stated.actor,
                request.headers[IDENTITY_HEADER] ?? "",
              ),
            );
          if (target.path === ASK_ANSWER_PATH && runtimes !== undefined && store !== undefined)
            return secureResponse(
              yield* answerAsk(
                {
                  runtimes,
                  store,
                  ...(eventSink === undefined
                    ? {}
                    : {
                        noteAnswer: (askId: string, note: AnswerNote | undefined) =>
                          eventSink.noteAnswer(askId as RequestId, note),
                      }),
                  ...(answerQuestionAsUser === undefined || orchestration === undefined
                    ? {}
                    : {
                        orchestratorQuestions: {
                          find: (workspaceId, questionId) =>
                            Effect.gen(function* () {
                              const state = yield* store.getWorkspace(workspaceId);
                              const threadId = state.workspace.orchestratorThreadId;
                              if (threadId === undefined) return undefined;
                              const listed = yield* orchestration.memoryQuestions.list(workspaceId);
                              const question = listed.find((each) => each.id === questionId);
                              return question === undefined ? undefined : { question, threadId };
                            }).pipe(Effect.orElseSucceed(() => undefined)),
                          answer: answerQuestionAsUser,
                          mayReach: (_workspaceId, threadId) =>
                            mayReachThread(
                              store.getThread,
                              ownersOf(remoteHosts?.machines),
                              threadId,
                            ),
                        },
                      }),
                  ...(orchestration === undefined
                    ? {}
                    : {
                        workerQuestions: {
                          find: (workspaceId, questionId) =>
                            orchestration.ledger(workspaceId).pipe(
                              Effect.map((ledger) =>
                                (ledger.questions ?? []).find(
                                  (question) => question.id === questionId,
                                ),
                              ),
                              Effect.orElseSucceed(() => undefined),
                            ),
                          answer: (input, options) =>
                            orchestration.answerQuestionAsUser(input, options),
                          mayReach: (workspaceId, threadId) =>
                            Effect.gen(function* () {
                              const ownerOf = ownersOf(remoteHosts?.machines);
                              const state = yield* store
                                .getWorkspace(workspaceId)
                                .pipe(Effect.option);
                              const holder =
                                state._tag === "Some"
                                  ? state.value.workspace.orchestratorThreadId
                                  : undefined;
                              for (const id of holder === undefined
                                ? [threadId]
                                : [threadId, holder]) {
                                if (!(yield* mayReachThread(store.getThread, ownerOf, id)))
                                  return false;
                              }
                              return true;
                            }),
                        },
                      }),
                },
                request,
                stated.actor,
                request.headers[IDENTITY_HEADER] ?? "",
              ),
            );
          if (
            REMOTE_MANAGEMENT_PATHS.has(target.path) ||
            MACHINE_MANAGEMENT_PATHS.has(target.path) ||
            HOST_STOP_PATHS.has(target.path) ||
            WORKSPACE_TRANSFER_PATHS.has(target.path) ||
            target.path === THREAD_SEND_CHECK_PATH ||
            target.path === THREAD_SEND_PATH ||
            target.path === THREAD_SEND_MACHINE_PATH ||
            target.path === PROFILE_START_PATH ||
            target.path === PROFILE_MOVE_PATH ||
            target.path === PROFILE_WAIT_PATH ||
            target.path === THREAD_READERS_PATH ||
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
              ? yield* Effect.raceFirst(
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
        if (
          embedInbound !== undefined &&
          !isRemote &&
          request.headers["tailscale-user-login"] === undefined &&
          path !== undefined &&
          path.startsWith(EMBED_PREFIX)
        ) {
          const answered = yield* embedInbound
            .respond(request, path)
            .pipe(Effect.provideService(ReadingAs, SERVER));
          if (answered !== undefined) return secureResponse(answered);
        }
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
        if (isRemote && path !== undefined && HOST_PATHS.has(path))
          return secureResponse(
            remoteHosts === undefined
              ? HttpServerResponse.text("forbidden", { status: 403 })
              : yield* hostRoute(
                  remoteHosts,
                  remote,
                  path,
                  config.appBuild !== undefined && /^[a-f0-9]{40}$/.test(config.appBuild)
                    ? config.appVersion
                    : undefined,
                ).pipe(Effect.provideService(ReadingAs, SERVER)),
          );
        const decision = isRemote
          ? remote.authorize(authRequest)
          : authorize(
              { port, token, cookie: launchCookie, originKey, extraOrigins: config.extraOrigins },
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
                  : isRemote &&
                      path !== undefined &&
                      (WORKSPACE_TRANSFER_PATHS.has(path) ||
                        path === THREAD_SEND_CHECK_PATH ||
                        path === THREAD_SEND_PATH ||
                        path === THREAD_SEND_MACHINE_PATH)
                    ? HttpServerResponse.text("forbidden: local access only", { status: 403 })
                    : path !== undefined && MACHINE_MANAGEMENT_PATHS.has(path)
                      ? isRemote || remoteHosts === undefined
                        ? HttpServerResponse.text("forbidden: local access only", { status: 403 })
                        : yield* manageMachines(remoteHosts, path)
                      : isRemote && path === "/ws"
                        ? yield* closedOnRevoke(
                            remote,
                            remote.sessionOf(authRequest),
                            asCaller(httpEffect, unmarkLocalApp(request)),
                          )
                        : yield* asCaller(
                            httpEffect,
                            !isRemote && path === "/ws"
                              ? markLocalApp(request)
                              : unmarkLocalApp(request),
                          );
            break;
          case "shell":
            response = Option.isSome(shell)
              ? yield* shell.value.serve
              : HttpServerResponse.text("unauthorized: this page's key is missing", {
                  status: 401,
                });
            break;
          case "boot":
            response = yield* HttpServerResponse.redirect(`/#${ORIGIN_KEY_FRAGMENT}${originKey}`, {
              status: 302,
            }).pipe(
              HttpServerResponse.setCookie(tokenCookieName(port), launchCookie, {
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
      }).pipe(Effect.provideService(ReadingAs, NOBODY));
  }),
  { global: true },
);

const asCaller = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  request: HttpServerRequest.HttpServerRequest,
  actor?: Actor,
) =>
  Effect.provideService(
    actor === undefined ? effect : Effect.provideService(effect, ReadingAs, { subject: actor.id }),
    HttpServerRequest.HttpServerRequest,
    actor === undefined ? unmarkActor(request) : markActor(request, actor),
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

const RpcRoutes = rpcRoutes(GramRpcs.middleware(ActorGuard), RpcHandlersLayer).pipe(
  Layer.provide(ActorGuard.layer),
);

/** Store, hub, runtimes, app tools and git checkouts; needs agents, hooks, git and config. */
export const ServerCore = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const databaseFile = config.databaseFile ?? (yield* serverDatabaseFile(config.dataDir));
    if (databaseFile !== ":memory:") mkdirSync(config.dataDir, { recursive: true });
    const keptTerminals =
      databaseFile === ":memory:" || config.headless === true
        ? undefined
        : join(config.dataDir, "kept-terminals");
    return Layer.mergeAll(
      HiddenPrsLive,
      PrAppToolsLive,
      ReviewAppToolsLive,
      ReadAppToolsLive,
      WrapUpAppToolsLive,
      DocAppToolsLive,
      PageAppToolsLive,
      ReviewRequestAppToolsLive,
      OrchestrationAppToolsLive.pipe(Layer.provide(SentWorkPort.layer)),
      OrchestratorAppToolsLive,
      SentWorkersLive.pipe(Layer.provide(SentWorkPort.layer)),
      TranscriptSearchAppToolsLive,
      TranscriptReadAppToolsLive,
      RoutineAppToolsLive,
      SettingsAppToolsLive,
      WorkspaceAppToolsLive,
      McpProposeAppToolsLive,
      IssueAppToolsLive,
      BrowserFamilyAppToolsLive,
      VerifyAppToolsLive,
      ThreadAssistLive,
      RepoEventsInboundLive,
      ThreadNotesInboundLive,
      IdleStopInboundLive,
      ThreadMessagesInboundLive,
      ConversationFilesInboundLive,
      ThreadStartsInboundLive,
      ThreadImportsInboundLive.pipe(Layer.provide(ThreadTransfer.layer)),
      ConversationAppToolsLive,
      SuppliedSettingsLive,
    )
      .pipe(Layer.provideMerge(PrDependenciesLive))
      .pipe(Layer.provideMerge(VerifyStatusLive))
      .pipe(
        Layer.provideMerge(MergeWhenReadyLive),
        Layer.provideMerge(Layer.mergeAll(IssueReporter.layer, ConnectorConfigs.layer)),
        Layer.provideMerge(
          Layer.mergeAll(
            DreamsLive,
            RoutinesLive.pipe(
              Layer.provide(
                RoutineEventSourcesLive.pipe(
                  Layer.provide(Layer.mergeAll(BranchHeadsLive, UpstreamReleasesLive)),
                ),
              ),
            ),
            ThreadArchiverLive,
            WorktreeSweepLive,
            WorkerMachineReleaseLive,
            IdleMeasureLive,
            MainWatchLive.pipe(Layer.provide(BranchHeadsLive)),
          ),
        ),
        Layer.provideMerge(Layer.mergeAll(DreamFiles.layer, ThreadArchive.layer)),
        Layer.provideMerge(OrchestrationLive.pipe(Layer.provideMerge(WorkerMachineSourcesLive))),
        Layer.provideMerge(LocalChecksLive.pipe(Layer.provide(LocalCheckRunner.layer))),
        Layer.provideMerge(OrchestrationMemory.layer),
        Layer.provideMerge(
          Layer.mergeAll(BabysitLive, PrCommentWakesLive, RunMonitorLive, ThreadWakesLive).pipe(
            Layer.provide(PrCommentReads.layer),
          ),
        ),
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
        Layer.provideMerge(
          Layer.mergeAll(
            GitStatePublisherLive,
            config.headless === true ? LaunchChecksCache.layerNone : LaunchChecksCache.layer,
          ),
        ),
        Layer.provideMerge(ReviewRequestsLive),
        Layer.provideMerge(
          Layer.mergeAll(HelperScheduler.layer, ComposerPresence.layer, MachinePreWake.layer),
        ),
        Layer.provideMerge(ThreadVisibility.layer),
        Layer.provideMerge(ThreadPorts.layer),
        Layer.provideMerge(
          Layer.mergeAll(
            AppToolRegistry.layer,
            WorkspaceOutputs.layer,
            Docs.layer,
            Pages.layer,
            Conversations.layer,
          ),
        ),
        Layer.provideMerge(
          Layer.mergeAll(ThreadRuntimes.layer, UsageLimitPoller.layer).pipe(
            Layer.provideMerge(UsageLimitReadings.layer),
          ),
        ),
        Layer.provideMerge(
          Layer.mergeAll(WorkerHosts.placedCheckouts, ObjectStoreLive, SharedFolders.layer),
        ),
        Layer.provideMerge(
          WorkerHosts.layerLocalOn.pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                GitCheckoutLive.pipe(Layer.provide(LocalHostProcess.worktrees)),
                ClaudeAiSeenLive,
                HostTerminals.layerKeeping(keptTerminals),
                agentHostsOrHeadless(AgentHostsThroughHost),
              ),
            ),
            Layer.provideMerge(
              keptTerminals === undefined
                ? Layer.succeed(KeptSessions, KeptSessions.off)
                : KeptSessions.layer(config.dataDir),
            ),
            Layer.provideMerge(
              config.headless === true
                ? LocalHostProcess.layerWith({ hostProcess: false })
                : LocalHostProcess.layerKeeping(
                    keptTerminals,
                    keptTerminals === undefined
                      ? undefined
                      : { dataDir: config.dataDir, release: config.appVersion },
                  ),
            ),
          ),
        ),
        Layer.provideMerge(
          DecisionHook.layer.pipe(
            Layer.provideMerge(EventSink.layer),
            Layer.provideMerge(
              Layer.mergeAll(
                EventHub.layer,
                TerminalGate.layer,
                PreviewFiles.layer,
                PageFiles.layer,
                AppActivityLive,
                ProcessRoots.layer,
                TimersLive.pipe(
                  Layer.provideMerge(EmbedInbound.layer),
                  Layer.provideMerge(Embedding.layer),
                ),
                GitHubRelayLive,
              ),
            ),
          ),
        ),
        Layer.provideMerge(
          withHeadlessCheck(
            withEmbeddingSeed(
              ThreadStore.layerSqlite(databaseFile, {
                checkpointOffLoop: databaseFile !== ":memory:",
                writerOffLoop: databaseFile !== ":memory:",
              }),
            ),
          ),
        ),
      );
  }),
);

const websocketOptions: NodeHttpServer.Options["websocket"] & { readonly closeTimeout: number } = {
  closeTimeout: 1_000,
  perMessageDeflate: {
    threshold: 1024,
    zlibDeflateOptions: { level: 3 },
  },
};

/** The HTTP + WebSocket server on 127.0.0.1, with the core services it serves. */
export const ServerLayer: Layer.Layer<
  | HttpServer.HttpServer
  | ProvisionedListener
  | LaunchToken
  | McpTokens
  | ThreadRuntimes
  | ThreadStore
  | EventHub
  | AppToolRegistry,
  unknown,
  AgentHosts | ServerConfig | GitPlatform | TurnHooks
> = Layer.unwrap(
  Effect.gen(function* () {
    const { port, listenHost, provisionedHosts } = yield* ServerConfig;
    const listeners = (options: NodeHttpServer.Options) =>
      withProvisionedListener(
        NodeHttpServer.layerServer(() => createServer(), options),
        provisionedHosts,
        options,
      );
    return HttpRouter.serve(
      Layer.mergeAll(
        RpcRoutes,
        StaticRoutes,
        McpRoute,
        WorkspaceTransferRoutes.pipe(
          Layer.provide(Layer.mergeAll(WorkspaceTransfer.layer, ThreadTransfer.layer)),
        ),
        ProfileStartRoutes,
        SentWorkRoutes.pipe(Layer.provide(SentWorkPort.layer)),
        AuthMiddleware,
      ).pipe(Layer.provide(ProfileStarters.layer), Layer.provide(AppShell.layer)),
      {
        disableListenLog: true,
        disableLogger: true,
      },
    ).pipe(
      Layer.merge(LoopStallLog),
      Layer.provide(FrontedSignIn.layer),
      Layer.provide(LentDevicesLive.pipe(Layer.provide(FrontedSignIn.layer))),
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
          disablePreemptiveShutdown: true,
          websocket: websocketOptions,
        }),
      ),
    );
  }),
).pipe(Layer.provide(Layer.succeed(ServerWork)(true)));
