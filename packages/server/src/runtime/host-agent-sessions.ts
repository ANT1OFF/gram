import { randomUUID } from "node:crypto";
import type {
  AgentConnectors,
  AgentHost,
  AgentSession,
  OpenSessionOptions,
} from "@gram/agents";
import {
  type AgentEvent,
  type AgentKind,
  AgentUnavailable,
  AnswerUndelivered,
  type HostFailed,
  type HostSessionOpen,
  ModeRefused,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { LocalHostProcess } from "../host/local-process.ts";
import type { HostSessionsConnection } from "../host/protocol.ts";
import { AgentHosts } from "./agent-hosts.ts";

/** The event a session whose host went ends with. */
export const HOST_STOPPED_ENDED: AgentEvent = {
  type: "ended",
  reason: "This machine's host stopped, and the agent with it.",
};

/** How often the events a session's consumer has received are confirmed to its host. */
const ACK_EVERY = "250 millis";

/** How many times an event stream that broke while its host still runs is picked up again. */
const EVENT_RESUMES = 3;

/**
 * Whether a session can open in the host process. What can't cross as data keeps it in the server:
 * a gateway profile (its keys live here), Codex (its homes and shared servers live here), a
 * workspace switch or a wait for a previous child (their proof is the server's own child), a dream
 * (its file bridge is in-process), and app tools with no MCP endpoint to reach them over.
 */
export const opensOnHost = (
  agent: AgentKind,
  options: OpenSessionOptions,
): boolean =>
  agent === "claude" &&
  options.model?.profileId === undefined &&
  options.switchStartup === undefined &&
  options.waitForPreviousSession === undefined &&
  options.audience !== "dream" &&
  options.dreamFilesOnly !== true &&
  options.dreamGuided !== true &&
  (options.appTools === undefined || options.mcp !== undefined);

const defined = <A extends object>(value: A): A =>
  Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as A;

/** The options as the host takes them: data only, the app tools over the MCP endpoint. */
const openRequest = (
  handle: string,
  agent: AgentKind,
  o: OpenSessionOptions,
): HostSessionOpen =>
  defined({
    handle,
    agent,
    threadId: o.threadId,
    cwd: o.cwd,
    resumeId: o.resumeId,
    fork: o.fork,
    resumeAt: o.resumeAt,
    sessionId: o.sessionId,
    model: o.model,
    permissionMode: o.permissionMode,
    mcp:
      o.mcp === undefined
        ? undefined
        : { url: o.mcp.url, headers: { ...o.mcp.headers } },
    additionalDirectories: o.additionalDirectories,
    audience: o.audience,
    instructions: o.instructions,
    outwardGate: o.outwardGate,
    confineWrites: o.confineWrites,
    pinCwd: o.pinCwd,
    mcpAllowlist: o.mcpAllowlist,
    mcpDenylist: o.mcpDenylist,
    mcpNoneWithoutToolSearch: o.mcpNoneWithoutToolSearch,
    noBlockingAsk: o.noBlockingAsk,
    peerMessaging: o.peerMessaging,
  }) as HostSessionOpen;

const logFailed = (call: string) => (error: HostFailed) =>
  Effect.logWarning("worker host: a session call didn't reach the agent").pipe(
    Effect.annotateLogs({ call, reason: error.message }),
  );

/**
 * A session opened in the host process, as the runtime holds it. Its events come numbered; the
 * ones received are confirmed to the host, and a stream that broke while the host still runs picks
 * up after the last one. A host that goes ends the session with an `ended` event.
 */
const openOnHost = (
  host: HostSessionsConnection,
  gone: () => boolean,
  agent: AgentKind,
  o: OpenSessionOptions,
) =>
  Effect.gen(function* () {
    const handle = randomUUID();
    // Added first, so a session whose open was given up on is closed on the host too.
    yield* Effect.addFinalizer(() => host.close(handle));
    const opened = yield* host
      .open(openRequest(handle, agent, o))
      .pipe(
        Effect.catchTag("HostFailed", (error) =>
          Effect.fail(
            new AgentUnavailable({
              agent,
              reason: "startup-failed",
              message: error.message,
            }),
          ),
        ),
      );
    const onSeen = o.onConnectorsSeen;
    if (onSeen !== undefined) {
      yield* host.connectorsSeen(handle).pipe(
        Stream.runForEach((seen) => Effect.sync(() => onSeen(seen))),
        Effect.forkScoped,
      );
    }
    let received = 0;
    let acked = 0;
    yield* Effect.suspend(() => {
      if (received <= acked) return Effect.void;
      acked = received;
      return host.ack(handle, acked);
    }).pipe(Effect.repeat(Schedule.spaced(ACK_EVERY)), Effect.forkScoped);

    const from = (resumes: number): Stream.Stream<AgentEvent> =>
      host.events(handle, received).pipe(
        // A stream picked up again may repeat what came before it broke.
        Stream.filter((next) => next.seq > received),
        Stream.map((next) => {
          received = next.seq;
          return next.event;
        }),
        Stream.catch((error) =>
          gone() || resumes >= EVENT_RESUMES
            ? Stream.make(HOST_STOPPED_ENDED)
            : Stream.unwrap(
                Effect.logWarning(
                  "worker host: a session's events broke; picking them up",
                ).pipe(
                  Effect.annotateLogs({
                    reason: error.message,
                    after: received,
                  }),
                  Effect.as(from(resumes + 1)),
                ),
              ),
        ),
      );

    const connectors: AgentConnectors | undefined =
      opened.connectors === undefined
        ? undefined
        : {
            status: host.connectors
              .status(handle)
              .pipe(
                Effect.catchTag("HostFailed", (e) =>
                  Effect.fail(unavailable(agent, e)),
                ),
              ),
            reconnect: (name) =>
              host.connectors
                .reconnect(handle, name)
                .pipe(
                  Effect.catchTag("HostFailed", (e) =>
                    Effect.fail(unavailable(agent, e)),
                  ),
                ),
            setEnabled: (name, enabled) =>
              host.connectors
                .setEnabled(handle, name, enabled)
                .pipe(
                  Effect.catchTag("HostFailed", (e) =>
                    Effect.fail(unavailable(agent, e)),
                  ),
                ),
            ...(opened.connectors.authenticate
              ? {
                  authenticate: (name: string) =>
                    host.connectors
                      .authenticate(handle, name)
                      .pipe(
                        Effect.catchTag("HostFailed", (e) =>
                          Effect.fail(unavailable(agent, e)),
                        ),
                      ),
                }
              : {}),
            ...(opened.connectors.allowlist === undefined
              ? {}
              : { allowlist: opened.connectors.allowlist }),
            ...(opened.connectors.denylist === undefined
              ? {}
              : { denylist: opened.connectors.denylist }),
            ...(opened.connectors.claudeAiUnavailable === undefined
              ? {}
              : { claudeAiUnavailable: opened.connectors.claudeAiUnavailable }),
          };

    const session: AgentSession = {
      events: Stream.suspend(() => from(0)),
      send: (input, sendOptions) =>
        host
          .send(handle, input, sendOptions)
          .pipe(Effect.catch(logFailed("send"))),
      steer: (input) =>
        host.steer(handle, input).pipe(Effect.catch(logFailed("steer"))),
      // A host that went has no turn left to stop.
      interrupt: host
        .interrupt(handle)
        .pipe(Effect.catchTag("HostFailed", logFailed("interrupt"))),
      respond: (requestId, answer) =>
        host
          .respond(handle, requestId, answer)
          .pipe(
            Effect.catchTag("HostFailed", (e) =>
              Effect.fail(new AnswerUndelivered({ message: e.message })),
            ),
          ),
      setMode: (mode) =>
        host
          .setMode(handle, mode)
          .pipe(
            Effect.catchTag("HostFailed", (e) =>
              Effect.fail(new ModeRefused({ mode, message: e.message })),
            ),
          ),
      // As the agent's own does: a switch that didn't happen is a defect, never a model recorded
      // that the session isn't on.
      setModel: (model) => host.setModel(handle, model).pipe(Effect.orDie),
      ...(opened.closeToolGate
        ? {
            closeToolGate: host
              .closeToolGate(handle)
              .pipe(Effect.catch(logFailed("closeToolGate"))),
          }
        : {}),
      ...(opened.stopBackgroundTasks
        ? {
            stopBackgroundTasks: host
              .stopBackgroundTasks(handle)
              .pipe(
                Effect.catch((e) =>
                  Effect.as(logFailed("stopBackgroundTasks")(e), 0),
                ),
              ),
          }
        : {}),
      ...(opened.stopTask
        ? {
            stopTask: (taskId: string) =>
              host
                .stopTask(handle, taskId)
                .pipe(
                  Effect.catch((e) =>
                    Effect.as(logFailed("stopTask")(e), false),
                  ),
                ),
          }
        : {}),
      ...(opened.addDirectories
        ? {
            addDirectories: (paths: ReadonlyArray<string>) =>
              host
                .addDirectories(handle, paths)
                .pipe(
                  Effect.catch((e) =>
                    Effect.as(logFailed("addDirectories")(e), false),
                  ),
                ),
          }
        : {}),
      ...(opened.processId
        ? {
            processId: host
              .processId(handle)
              .pipe(Effect.orElseSucceed((): number | undefined => undefined)),
          }
        : {}),
      ...(connectors === undefined ? {} : { connectors }),
    };
    return session;
  });

const unavailable = (agent: AgentKind, error: HostFailed) =>
  new AgentUnavailable({ agent, message: error.message });

/**
 * `inServer`'s agent with the sessions `opensOnHost` admits opened in the host process while it
 * runs. Everything else (models, past sessions, MCP config, helpers, every other session) stays
 * the server's. What the agent keeps across sessions is dropped on both sides alike. A host that
 * has gone, or goes while a session opens, leaves new sessions to the server.
 */
export const agentHostThroughHost = (
  host: HostSessionsConnection,
  gone: () => boolean,
  inServer: AgentHost,
): AgentHost => {
  const kind = inServer.kind;
  const invalidateRuntime = inServer.invalidateRuntime;
  const reloadConfig = inServer.reloadConfig;
  const reloadAllConfig = inServer.reloadAllConfig;
  return {
    ...inServer,
    open: (options) =>
      Effect.suspend(() =>
        gone() || !opensOnHost(kind, options)
          ? inServer.open(options)
          : openOnHost(host, gone, kind, options).pipe(
              // The host went before the session opened: the server opens it instead.
              Effect.catch((error) =>
                gone() ? inServer.open(options) : Effect.fail(error),
              ),
            ),
      ),
    ...(invalidateRuntime === undefined
      ? {}
      : {
          invalidateRuntime: Effect.andThen(
            invalidateRuntime,
            host.reload(kind, { kind: "runtime" }),
          ),
        }),
    ...(reloadConfig === undefined
      ? {}
      : {
          reloadConfig: (profileId) =>
            Effect.andThen(
              reloadConfig(profileId),
              host.reload(
                kind,
                profileId === undefined
                  ? { kind: "config" }
                  : { kind: "config", profileId },
              ),
            ),
        }),
    ...(reloadAllConfig === undefined
      ? {}
      : {
          reloadAllConfig: Effect.andThen(
            reloadAllConfig,
            host.reload(kind, { kind: "allConfig" }),
          ),
        }),
  };
};

/**
 * `AgentHosts` with Claude's sessions opened in this machine's host process while it runs
 * (`agentHostThroughHost`); the agents as they are when it doesn't.
 */
export const AgentHostsThroughHost: Layer.Layer<
  AgentHosts,
  never,
  AgentHosts | LocalHostProcess
> = Layer.effect(
  AgentHosts,
  Effect.gen(function* () {
    const inner = yield* AgentHosts;
    const connection = (yield* LocalHostProcess).connection;
    if (connection === undefined) return inner;
    // One wrapper per agent, so the runtime always holds the same object for it.
    const wrapped = new WeakMap<AgentHost, AgentHost>();
    return AgentHosts.of({
      get: (kind) =>
        Effect.map(inner.get(kind), (agent) => {
          if (kind !== "claude") return agent;
          const known = wrapped.get(agent);
          if (known !== undefined) return known;
          const through = agentHostThroughHost(
            connection.sessions,
            connection.gone,
            agent,
          );
          wrapped.set(agent, through);
          return through;
        }),
    });
  }),
);
