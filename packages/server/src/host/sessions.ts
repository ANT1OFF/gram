import {
  type AgentHost,
  type McpEndpoint,
  type RemoteAppTools,
  type AgentSession,
  type ConnectorsSeen,
  type EventLog,
  type OpenSessionOptions,
  type SequencedEvent,
  sequenceEvents,
} from "@gram/agents";
import {
  type AgentEvent,
  type AgentKind,
  type AgentStatus,
  AgentUnavailable,
  HostFailed,
  type HostAgentReload,
  NotFound,
  type HostSessionOpen,
  type HostSessionOpened,
} from "@gram/contracts";
import * as Cause from "effect/Cause";
import * as Queue from "effect/Queue";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { lstat, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MachineMcpServer } from "./machine-mcp-server.ts";
import { appToolsAt } from "./remote-app-tools.ts";

/** The agents a host runs sessions for, by kind. */
export type HostAgents = (kind: AgentKind) => Effect.Effect<AgentHost, AgentUnavailable>;

/**
 * A machine's agent sessions as its host serves them, each under the handle the control plane
 * named it by. Each session's events are numbered and kept until the control plane confirms them
 * (`EventLog`), so a subscription that stopped picks up where it was.
 */
export interface HostSessionsService {
  readonly accountScope?: (agent: AgentKind) => Effect.Effect<string | undefined, AgentUnavailable>;
  readonly open: (
    request: HostSessionOpen,
  ) => Effect.Effect<HostSessionOpened, AgentUnavailable | HostFailed>;
  /** `NotFound` for a session that isn't open (any more). */
  readonly events: (handle: string, afterSeq: number) => Stream.Stream<SequencedEvent, NotFound>;
  readonly ack: (handle: string, seq: number) => Effect.Effect<void>;
  readonly connectorsSeen: (handle: string) => Stream.Stream<ConnectorsSeen>;
  /** The open session under `handle`, for the calls that act on it. */
  readonly session: (handle: string) => Effect.Effect<AgentSession, HostFailed>;
  /**
   * Points the session's app tools at `mcp` from now on: a Gram opened again after it quit, at
   * its own address and with its own token. A call already running finishes where it started.
   */
  readonly retarget: (handle: string, mcp: McpEndpoint) => Effect.Effect<void, HostFailed>;
  /**
   * How many open sessions have events the control plane hasn't confirmed: what a Gram that quit
   * hasn't seen yet. A host kept running after it quit stays up for them.
   */
  readonly unconfirmed: () => number;
  /**
   * Hands the session under `handle` input once per `deliveryId` (a send or a steer). A repeat, from
   * a control plane whose connection dropped before it heard back, waits for the first and answers
   * as it did, so the agent never takes the input twice; one that failed is forgotten, so a repeat
   * tries again. It runs in the session's scope, so a caller that goes mid-call doesn't cut it off.
   */
  readonly deliver: (
    handle: string,
    deliveryId: string,
    deliver: (session: AgentSession) => Effect.Effect<void>,
  ) => Effect.Effect<void, HostFailed>;
  /** Ends the session and waits for its agent to stop; a handle not yet open stays closed. */
  readonly close: (handle: string) => Effect.Effect<void>;
  readonly reload: (agent: AgentKind, reload: HostAgentReload) => Effect.Effect<void>;
  /**
   * How many sessions are at work now: opening, in a turn, waiting on a question or a permission,
   * or with background tasks running. A restart of the host would cut each of them off.
   */
  readonly busy: () => number;
}

interface Activity {
  status: AgentStatus | undefined;
  background: number;
}

const AT_REST: ReadonlySet<AgentStatus | undefined> = new Set([
  undefined,
  "starting",
  "idle",
  "error",
]);

const noteActivity = (activity: Activity, event: AgentEvent) => {
  if (event.type === "status") activity.status = event.status;
  else if (event.type === "turnEnd") activity.status = "idle";
  else if (event.type === "backgroundTasks") activity.background = event.tasks.length;
  else if (event.type === "ended") {
    activity.status = undefined;
    activity.background = 0;
  }
};

type Entry =
  | {
      readonly state: "opening";
      readonly scope: Scope.Closeable;
      fiber?: Fiber.Fiber<unknown, unknown>;
    }
  | {
      readonly state: "open";
      readonly scope: Scope.Closeable;
      readonly session: AgentSession;
      readonly log: EventLog;
      readonly seen: {
        last?: ConnectorsSeen;
        readonly changes: PubSub.PubSub<ConnectorsSeen>;
      };
      readonly closed: Deferred.Deferred<void>;
      readonly tools: MovableTools | undefined;
      readonly progress: { read: number; confirmed: number };
      readonly threadId: string | undefined;
      followers: number;
      unfollowedSince: number | undefined;
      readonly deliveries: Map<string, Deferred.Deferred<void>>;
    };

/**
 * How long an open session may go without an event stream following it before the host ends it.
 * Longer than the control plane waits for a dropped connection to come back (`REATTACH_WITHIN_MS`),
 * so a session waiting out a redial is still there when it does.
 */
export const UNFOLLOWED_GRACE_MS = 3 * 60_000;
const UNFOLLOWED_SWEEP_MS = 30_000;

const CLOSED_EARLY_KEPT = 256;

const DELIVERIES_KEPT = 256;

const noSession = (handle: string) => new HostFailed({ message: `No agent session ${handle}.` });

const optionsFor = (
  request: HostSessionOpen,
  remoteAppTools: RemoteAppTools | undefined,
  onConnectorsSeen: (seen: ConnectorsSeen) => void,
  machineMcpServer: MachineMcpServer | undefined,
): OpenSessionOptions => {
  const { handle: _handle, agent: _agent, mcp, waitForPrevious, ...rest } = request;
  return {
    ...rest,
    ...(rest.mcpServer === undefined && machineMcpServer !== undefined
      ? { mcpServer: { name: machineMcpServer.name, url: machineMcpServer.url } }
      : {}),
    ...(waitForPrevious === true ? { waitForPreviousSession: { onWait: Effect.void } } : {}),
    ...(mcp === undefined ? {} : { mcp: { url: mcp.url, headers: mcp.headers } }),
    ...(remoteAppTools === undefined ? {} : { remoteAppTools }),
    onConnectorsSeen,
  };
};

const sessionFolder = (request: HostSessionOpen): Effect.Effect<string, AgentUnavailable> =>
  request.dreamFilesOnly !== true
    ? Effect.succeed(request.cwd)
    : request.agent !== "claude"
      ? Effect.fail(
          new AgentUnavailable({
            agent: request.agent,
            reason: "startup-failed",
            message: "This machine runs memory updates in Claude Code only.",
          }),
        )
      : Effect.tryPromise({
          try: async () => {
            const folder = join(tmpdir(), `gram-dream-${request.threadId.replace(/[^\w-]/g, "_")}`);
            await mkdir(folder, { recursive: true, mode: 0o700 });
            const made = await lstat(folder);
            if (
              !made.isDirectory() ||
              (process.getuid !== undefined && made.uid !== process.getuid())
            )
              throw new Error(`${folder} isn't a folder of this user's`);
            return folder;
          },
          catch: (error) =>
            new AgentUnavailable({
              agent: request.agent,
              reason: "startup-failed",
              message: `A folder for the memory update couldn't be made: ${error instanceof Error ? error.message : String(error)}`,
            }),
        });

/** Reaches a thread's app tools at the server's MCP endpoint. */
export type AppToolsAt = (
  endpoint: McpEndpoint,
) => Effect.Effect<RemoteAppTools, Error, Scope.Scope>;

interface MovableTools {
  readonly tools: RemoteAppTools;
  readonly moveTo: (endpoint: McpEndpoint) => Effect.Effect<void, Error>;
}

const movableTools = (
  toolsAt: AppToolsAt,
  first: McpEndpoint,
  scope: Scope.Scope,
): Effect.Effect<MovableTools, Error> =>
  Effect.gen(function* () {
    let current = yield* toolsAt(first).pipe(Scope.provide(scope));
    return {
      tools: {
        tools: current.tools,
        call: (name, args, signal) => current.call(name, args, signal),
      },
      moveTo: (endpoint) =>
        toolsAt(endpoint).pipe(
          Scope.provide(scope),
          Effect.map((next) => {
            current = next;
          }),
        ),
    };
  });

const openedFrom = (session: AgentSession): HostSessionOpened => ({
  closeToolGate: session.closeToolGate !== undefined,
  stopBackgroundTasks: session.stopBackgroundTasks !== undefined,
  stopTask: session.stopTask !== undefined,
  addDirectories: session.addDirectories !== undefined,
  processId: session.processId !== undefined,
  ...(session.connectors === undefined
    ? {}
    : {
        connectors: {
          authenticate: session.connectors.authenticate !== undefined,
          ...(session.connectors.allowlist === undefined
            ? {}
            : { allowlist: session.connectors.allowlist }),
          ...(session.connectors.denylist === undefined
            ? {}
            : { denylist: session.connectors.denylist }),
          ...(session.connectors.claudeAiUnavailable === undefined
            ? {}
            : { claudeAiUnavailable: session.connectors.claudeAiUnavailable }),
        },
      }),
});

/**
 * The host's agent sessions. Every one still open is closed with the scope, which is the host's
 * own: for this machine's host process, when the server goes; for a joined machine's, once it has
 * been without a connection for `DETACHED_GRACE_MS` (`dialForever`).
 */
export const sessionsOnHost = (
  agents: HostAgents,
  toolsAt: AppToolsAt = appToolsAt,
  timing: {
    readonly unfollowedMs?: number;
    readonly sweepMs?: number;
    /**
     * From when an unfollowed session's grace counts at the earliest, or `undefined` while it
     * doesn't count at all. This machine's host kept running after the app quit (`serveLocal`)
     * passes when the app last connected, and nothing while none is: a closed app's sessions wait
     * for it, approvals included, and one that comes back gets the whole grace to follow them.
     */
    readonly graceFrom?: () => number | undefined;
  } = {},
  machine: {
    /**
     * The machine's own MCP server (`GRAM_HOST_MCP_SERVER`), given to each session the control
     * plane names none for, as `OpenSessionOptions.mcpServer`. It is subject to the session's
     * lists like any, and a confined session never gets it.
     */
    readonly mcpServer?: MachineMcpServer;
  } = {},
): Effect.Effect<HostSessionsService, never, Scope.Scope> =>
  Effect.gen(function* () {
    const root = yield* Effect.scope;
    const unfollowedMs = timing.unfollowedMs ?? UNFOLLOWED_GRACE_MS;
    const eagerly = (events: Stream.Stream<AgentEvent>) =>
      timing.graceFrom === undefined
        ? Effect.succeed(events)
        : Effect.gen(function* () {
            const queue = yield* Queue.unbounded<AgentEvent, Cause.Done>();
            yield* Stream.runIntoQueue(events, queue).pipe(Effect.forkScoped);
            return Stream.fromQueue(queue);
          });
    const givenUp = (since: number | undefined, now: number) => {
      if (since === undefined) return false;
      if (timing.graceFrom === undefined) return now - since >= unfollowedMs;
      const from = timing.graceFrom();
      return from !== undefined && now - Math.max(since, from) >= unfollowedMs;
    };
    const entries = new Map<string, Entry>();
    const activities = new Map<string, Activity>();
    const closedEarly = new Set<string>();

    yield* Effect.addFinalizer(() =>
      Effect.suspend(() =>
        Effect.forEach([...entries.keys()], (handle) => close(handle), {
          concurrency: "unbounded",
          discard: true,
        }),
      ),
    );

    const close = (handle: string): Effect.Effect<void> =>
      Effect.suspend(() => {
        const entry = entries.get(handle);
        if (entry === undefined) {
          closedEarly.add(handle);
          if (closedEarly.size > CLOSED_EARLY_KEPT) {
            const oldest = closedEarly.values().next().value;
            if (oldest !== undefined) closedEarly.delete(oldest);
          }
          return Effect.void;
        }
        entries.delete(handle);
        activities.delete(handle);
        return Effect.gen(function* () {
          if (entry.state === "opening") {
            if (entry.fiber !== undefined) yield* Fiber.interrupt(entry.fiber);
          } else {
            yield* Deferred.succeed(entry.closed, undefined);
          }
          yield* Scope.close(entry.scope, Exit.void);
        });
      });

    const leftBehind = (threadId: string | undefined): ReadonlyArray<string> =>
      threadId === undefined
        ? []
        : [...entries].flatMap(([handle, entry]) =>
            entry.state === "open" && entry.threadId === threadId && entry.followers === 0
              ? [handle]
              : [],
          );

    yield* Effect.forkScoped(
      Effect.suspend(() => {
        const now = Date.now();
        const stale = [...entries].flatMap(([handle, entry]) =>
          entry.state === "open" && givenUp(entry.unfollowedSince, now) ? [handle] : [],
        );
        return Effect.forEach(
          stale,
          (handle) =>
            Effect.suspend(() => {
              const entry = entries.get(handle);
              if (entry?.state !== "open" || !givenUp(entry.unfollowedSince, Date.now()))
                return Effect.void;
              return Effect.logInfo("gram-host: ending a session nothing follows any more").pipe(
                Effect.andThen(close(handle)),
              );
            }),
          { discard: true },
        );
      }).pipe(
        Effect.repeat(Schedule.spaced(Duration.millis(timing.sweepMs ?? UNFOLLOWED_SWEEP_MS))),
      ),
    );

    const openEntry = (handle: string) =>
      Effect.suspend(() => {
        const entry = entries.get(handle);
        return entry?.state === "open" ? Effect.succeed(entry) : Effect.fail(noSession(handle));
      });

    const open: HostSessionsService["open"] = (request) =>
      Effect.suspend((): Effect.Effect<HostSessionOpened, AgentUnavailable | HostFailed> => {
        const handle = request.handle;
        if (closedEarly.delete(handle))
          return Effect.fail(
            new AgentUnavailable({
              agent: request.agent,
              message: "The session was closed.",
            }),
          );
        if (entries.has(handle))
          return Effect.fail(
            new HostFailed({
              message: `Agent session ${handle} is already open.`,
            }),
          );
        return Effect.gen(function* () {
          yield* Effect.forEach(
            leftBehind(request.threadId),
            (stale) =>
              Effect.logInfo("gram-host: ending a session its thread left behind").pipe(
                Effect.andThen(close(stale)),
              ),
            { discard: true },
          );
          const scope = yield* Scope.make();
          const entry: Entry = { state: "opening", scope };
          entries.set(handle, entry);
          activities.set(handle, { status: undefined, background: 0 });
          const changes = yield* PubSub.unbounded<ConnectorsSeen>();
          const seen: {
            last?: ConnectorsSeen;
            readonly changes: PubSub.PubSub<ConnectorsSeen>;
          } = {
            changes,
          };
          const mcp = request.mcp;
          const progress = { read: 0, confirmed: 0 };
          let movable: MovableTools | undefined;
          const fiber = yield* agents(request.agent).pipe(
            Effect.flatMap((host) =>
              Effect.flatMap(
                mcp === undefined
                  ? Effect.succeed(undefined)
                  : movableTools(toolsAt, mcp, scope).pipe(
                      Effect.map((made) => {
                        movable = made;
                        return made.tools;
                      }),
                      Effect.mapError(
                        (error) =>
                          new AgentUnavailable({
                            agent: request.agent,
                            reason: "startup-failed",
                            message: `Gram's app tools couldn't be reached: ${error.message}`,
                          }),
                      ),
                    ),
                (remoteAppTools) =>
                  Effect.flatMap(sessionFolder(request), (cwd) =>
                    host.open(
                      optionsFor(
                        { ...request, cwd },
                        remoteAppTools,
                        (report) => {
                          seen.last = report;
                          PubSub.publishUnsafe(changes, report);
                        },
                        machine.mcpServer,
                      ),
                    ),
                  ),
              ),
            ),
            Effect.flatMap((session) =>
              Effect.flatMap(
                eagerly(
                  Stream.tap(session.events, (event) =>
                    Effect.sync(() => {
                      progress.read += 1;
                      const activity = activities.get(handle);
                      if (activity !== undefined) noteActivity(activity, event);
                    }),
                  ),
                ),
                (events) =>
                  Effect.map(sequenceEvents(events), (log) => ({
                    session,
                    log,
                  })),
              ),
            ),
            Scope.provide(scope),
            Effect.forkIn(root),
          );
          entry.fiber = fiber;
          const exit = yield* Fiber.await(fiber);
          const stillOpening = entries.get(handle) === entry;
          if (Exit.isFailure(exit) || !stillOpening) {
            if (stillOpening) {
              entries.delete(handle);
              activities.delete(handle);
            }
            yield* Scope.close(scope, Exit.void);
            if (Exit.isFailure(exit)) {
              const failure = Cause.findErrorOption(exit.cause);
              if (failure._tag === "Some") return yield* failure.value;
            }
            return yield* new AgentUnavailable({
              agent: request.agent,
              message: "The session was closed while it opened.",
            });
          }
          const closed = yield* Deferred.make<void>();
          entries.set(handle, {
            state: "open",
            scope,
            session: exit.value.session,
            log: exit.value.log,
            seen,
            closed,
            tools: movable,
            progress,
            threadId: request.threadId,
            followers: 0,
            unfollowedSince: Date.now(),
            deliveries: new Map(),
          });
          return openedFrom(exit.value.session);
        }).pipe(Effect.onInterrupt(() => close(handle)));
      });

    return {
      open,
      busy: () =>
        [...entries].filter(([handle, entry]) => {
          if (entry.state === "opening") return true;
          const activity = activities.get(handle);
          return (
            activity !== undefined && (!AT_REST.has(activity.status) || activity.background > 0)
          );
        }).length,
      events: (handle, afterSeq) =>
        Stream.unwrap(
          Effect.map(
            openEntry(handle).pipe(
              Effect.mapError(() => new NotFound({ entity: "session", id: handle })),
            ),
            (entry) =>
              Stream.unwrap(
                Effect.acquireRelease(
                  Effect.sync(() => {
                    entry.followers += 1;
                    entry.unfollowedSince = undefined;
                  }),
                  () =>
                    Effect.sync(() => {
                      entry.followers -= 1;
                      if (entry.followers === 0) entry.unfollowedSince = Date.now();
                    }),
                ).pipe(
                  Effect.as(
                    entry.log
                      .subscribe(afterSeq)
                      .pipe(Stream.interruptWhen(Deferred.await(entry.closed))),
                  ),
                ),
              ),
          ),
        ),
      ack: (handle, seq) =>
        Effect.suspend(() => {
          const entry = entries.get(handle);
          if (entry?.state !== "open") return Effect.void;
          entry.progress.confirmed = Math.max(entry.progress.confirmed, seq);
          return entry.log.ack(seq);
        }),
      retarget: (handle, endpoint) =>
        Effect.flatMap(openEntry(handle), (entry) =>
          entry.tools === undefined
            ? Effect.fail(new HostFailed({ message: "The session has no app tools to point." }))
            : entry.tools.moveTo(endpoint).pipe(
                Effect.mapError(
                  (error) =>
                    new HostFailed({
                      message: `Gram's app tools couldn't be reached: ${error.message}`,
                    }),
                ),
              ),
        ),
      unconfirmed: () =>
        [...entries.values()].filter(
          (entry) => entry.state === "open" && entry.progress.read > entry.progress.confirmed,
        ).length,
      connectorsSeen: (handle) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const entry = entries.get(handle);
            if (entry?.state !== "open") return Stream.empty;
            const subscription = yield* PubSub.subscribe(entry.seen.changes);
            const last = entry.seen.last;
            return Stream.concat(
              Stream.fromIterable(last === undefined ? [] : [last]),
              Stream.fromSubscription(subscription),
            ).pipe(Stream.interruptWhen(Deferred.await(entry.closed)));
          }),
        ),
      session: (handle) => Effect.map(openEntry(handle), (entry) => entry.session),
      deliver: (handle, deliveryId, deliver) =>
        Effect.flatMap(openEntry(handle), (entry) =>
          Effect.gen(function* () {
            let taken = entry.deliveries.get(deliveryId);
            if (taken === undefined) {
              const done = yield* Deferred.make<void>();
              taken = done;
              entry.deliveries.set(deliveryId, done);
              if (entry.deliveries.size > DELIVERIES_KEPT) {
                const oldest = entry.deliveries.keys().next().value;
                if (oldest !== undefined) entry.deliveries.delete(oldest);
              }
              yield* deliver(entry.session).pipe(
                Effect.onExit((exit) =>
                  Effect.andThen(
                    Effect.sync(() => {
                      if (Exit.isFailure(exit) && entry.deliveries.get(deliveryId) === done) {
                        entry.deliveries.delete(deliveryId);
                      }
                    }),
                    Deferred.done(done, exit),
                  ),
                ),
                Effect.forkIn(entry.scope),
              );
            }
            return yield* Effect.raceFirst(
              Deferred.await(taken),
              Deferred.await(entry.closed).pipe(Effect.andThen(Effect.fail(noSession(handle)))),
            ).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.fail(noSession(handle))
                  : Effect.failCause(cause),
              ),
            );
          }),
        ),
      close,
      accountScope: (agent) =>
        agents(agent).pipe(
          Effect.flatMap((host) => host.readAccountScope ?? Effect.succeed(undefined)),
        ),
      reload: (agent, reload) =>
        agents(agent).pipe(
          Effect.flatMap((host): Effect.Effect<void> => {
            switch (reload.kind) {
              case "runtime":
                return host.invalidateRuntime ?? Effect.void;
              case "config":
                return host.reloadConfig?.(reload.profileId) ?? Effect.void;
              default:
                return host.reloadAllConfig ?? Effect.void;
            }
          }),
          Effect.ignore,
        ),
    } satisfies HostSessionsService;
  });

/** A host that runs no agents: every open is refused. */
export const noAgents: HostAgents = (agent) =>
  Effect.fail(new AgentUnavailable({ agent, message: `No ${agent} on this host.` }));
