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
  type AgentKind,
  AgentUnavailable,
  HostFailed,
  type HostAgentReload,
  NotFound,
  type HostSessionOpen,
  type HostSessionOpened,
} from "@gram/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { appToolsAt } from "./remote-app-tools.ts";

/** The agents a host runs sessions for, by kind. */
export type HostAgents = (kind: AgentKind) => Effect.Effect<AgentHost, AgentUnavailable>;

/**
 * A machine's agent sessions as its host serves them, each under the handle the control plane
 * named it by. Each session's events are numbered and kept until the control plane confirms them
 * (`EventLog`), so a subscription that stopped picks up where it was.
 */
export interface HostSessionsService {
  readonly open: (
    request: HostSessionOpen,
  ) => Effect.Effect<HostSessionOpened, AgentUnavailable | HostFailed>;
  /** `NotFound` for a session that isn't open (any more). */
  readonly events: (handle: string, afterSeq: number) => Stream.Stream<SequencedEvent, NotFound>;
  readonly ack: (handle: string, seq: number) => Effect.Effect<void>;
  readonly connectorsSeen: (handle: string) => Stream.Stream<ConnectorsSeen>;
  /** The open session under `handle`, for the calls that act on it. */
  readonly session: (handle: string) => Effect.Effect<AgentSession, HostFailed>;
  /** Ends the session and waits for its agent to stop; a handle not yet open stays closed. */
  readonly close: (handle: string) => Effect.Effect<void>;
  readonly reload: (agent: AgentKind, reload: HostAgentReload) => Effect.Effect<void>;
}

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
      /** The thread it was opened for, when the request named one. */
      readonly threadId: string | undefined;
      /** Event streams following it now: none once the control plane that opened it let go. */
      followers: number;
      /** Epoch ms since when no stream has followed it; `undefined` while one does. */
      unfollowedSince: number | undefined;
    };

/**
 * How long an open session may go without an event stream following it before the host ends it.
 * Longer than the control plane waits for a dropped connection to come back (`REATTACH_WITHIN_MS`),
 * so a session waiting out a redial is still there when it does.
 */
export const UNFOLLOWED_GRACE_MS = 3 * 60_000;
/** How often sessions are looked over for that. */
const UNFOLLOWED_SWEEP_MS = 30_000;

/** How many handles closed before their open arrived are remembered. */
const CLOSED_EARLY_KEPT = 256;

const noSession = (handle: string) => new HostFailed({ message: `No agent session ${handle}.` });

/**
 * The request as the agent's own options. Its app tools are the ones the server's MCP endpoint
 * lists, served to the agent in-process and called through the endpoint.
 */
const optionsFor = (
  request: HostSessionOpen,
  remoteAppTools: RemoteAppTools | undefined,
  onConnectorsSeen: (seen: ConnectorsSeen) => void,
): OpenSessionOptions => {
  const { handle: _handle, agent: _agent, mcp, ...rest } = request;
  return {
    ...rest,
    ...(mcp === undefined ? {} : { mcp: { url: mcp.url, headers: mcp.headers } }),
    ...(remoteAppTools === undefined ? {} : { remoteAppTools }),
    onConnectorsSeen,
  };
};

/** Reaches a thread's app tools at the server's MCP endpoint. */
export type AppToolsAt = (
  endpoint: McpEndpoint,
) => Effect.Effect<RemoteAppTools, Error, Scope.Scope>;

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
  timing: { readonly unfollowedMs?: number; readonly sweepMs?: number } = {},
): Effect.Effect<HostSessionsService, never, Scope.Scope> =>
  Effect.gen(function* () {
    const root = yield* Effect.scope;
    const unfollowedMs = timing.unfollowedMs ?? UNFOLLOWED_GRACE_MS;
    const entries = new Map<string, Entry>();
    /** Handles closed before their open came in, so the open, when it does, is refused. */
    const closedEarly = new Set<string>();

    // Every session still open ends with the host, all at once, so their agents stop within the
    // host's own grace.
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
        return Effect.gen(function* () {
          if (entry.state === "opening") {
            if (entry.fiber !== undefined) yield* Fiber.interrupt(entry.fiber);
          } else {
            yield* Deferred.succeed(entry.closed, undefined);
          }
          yield* Scope.close(entry.scope, Exit.void);
        });
      });

    /** The open sessions of `threadId` that no event stream follows. */
    const leftBehind = (threadId: string | undefined): ReadonlyArray<string> =>
      threadId === undefined
        ? []
        : [...entries].flatMap(([handle, entry]) =>
            entry.state === "open" && entry.threadId === threadId && entry.followers === 0
              ? [handle]
              : [],
          );

    // A session no stream has followed for the grace was given up on: the control plane that
    // opened it restarted, or stopped waiting for this host to dial in again.
    yield* Effect.forkScoped(
      Effect.suspend(() => {
        const now = Date.now();
        const stale = [...entries].flatMap(([handle, entry]) =>
          entry.state === "open" &&
          entry.unfollowedSince !== undefined &&
          now - entry.unfollowedSince >= unfollowedMs
            ? [handle]
            : [],
        );
        return Effect.forEach(
          stale,
          (handle) =>
            Effect.suspend(() => {
              // Asked again: an earlier close took time, and a stream may have followed it since.
              const entry = entries.get(handle);
              if (
                entry?.state !== "open" ||
                entry.unfollowedSince === undefined ||
                Date.now() - entry.unfollowedSince < unfollowedMs
              )
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
          // A session the same thread left behind, kept through a dropped connection but never
          // followed again (the main Gram restarted and opened anew), ends before its successor
          // starts: one thread's agent runs once.
          yield* Effect.forEach(
            leftBehind(request.threadId),
            (stale) =>
              Effect.logInfo("gram-host: ending a session its thread left behind").pipe(
                Effect.andThen(close(stale)),
              ),
            { discard: true },
          );
          // Each its own, not the host's scope's child, so the host's end closes them all at once.
          const scope = yield* Scope.make();
          const entry: Entry = { state: "opening", scope };
          // Taken before the first wait, so a close that comes in meanwhile finds it.
          entries.set(handle, entry);
          const changes = yield* PubSub.unbounded<ConnectorsSeen>();
          const seen: {
            last?: ConnectorsSeen;
            readonly changes: PubSub.PubSub<ConnectorsSeen>;
          } = {
            changes,
          };
          const mcp = request.mcp;
          const fiber = yield* agents(request.agent).pipe(
            Effect.flatMap((host) =>
              Effect.flatMap(
                mcp === undefined
                  ? Effect.succeed(undefined)
                  : toolsAt(mcp).pipe(
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
                  host.open(
                    optionsFor(request, remoteAppTools, (report) => {
                      seen.last = report;
                      PubSub.publishUnsafe(changes, report);
                    }),
                  ),
              ),
            ),
            Effect.flatMap((session) =>
              Effect.map(sequenceEvents(session.events), (log) => ({
                session,
                log,
              })),
            ),
            Scope.provide(scope),
            Effect.forkIn(root),
          );
          entry.fiber = fiber;
          const exit = yield* Fiber.await(fiber);
          const stillOpening = entries.get(handle) === entry;
          if (Exit.isFailure(exit) || !stillOpening) {
            if (stillOpening) entries.delete(handle);
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
            threadId: request.threadId,
            followers: 0,
            unfollowedSince: Date.now(),
          });
          return openedFrom(exit.value.session);
        }).pipe(
          // A caller that gave up on the open has no session to close: the host closes it.
          Effect.onInterrupt(() => close(handle)),
        );
      });

    return {
      open,
      events: (handle, afterSeq) =>
        Stream.unwrap(
          Effect.map(
            openEntry(handle).pipe(
              Effect.mapError(() => new NotFound({ entity: "session", id: handle })),
            ),
            (entry) =>
              // Counted while it runs, so a session no one follows any more can be told apart.
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
          return entry?.state === "open" ? entry.log.ack(seq) : Effect.void;
        }),
      connectorsSeen: (handle) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const entry = entries.get(handle);
            if (entry?.state !== "open") return Stream.empty;
            // Subscribed before the last report is read, so none comes in unseen.
            const subscription = yield* PubSub.subscribe(entry.seen.changes);
            const last = entry.seen.last;
            return Stream.concat(
              Stream.fromIterable(last === undefined ? [] : [last]),
              Stream.fromSubscription(subscription),
            ).pipe(Stream.interruptWhen(Deferred.await(entry.closed)));
          }),
        ),
      session: (handle) => Effect.map(openEntry(handle), (entry) => entry.session),
      close,
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
