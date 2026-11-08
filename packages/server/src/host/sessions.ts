import {
  type AgentHost,
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
  type HostSessionOpen,
  type HostSessionOpened,
} from "@gram/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

/** The agents a host runs sessions for, by kind. */
export type HostAgents = (
  kind: AgentKind,
) => Effect.Effect<AgentHost, AgentUnavailable>;

/**
 * A machine's agent sessions as its host serves them, each under the handle the control plane
 * named it by. Each session's events are numbered and kept until the control plane confirms them
 * (`EventLog`), so a subscription that stopped picks up where it was.
 */
export interface HostSessionsService {
  readonly open: (
    request: HostSessionOpen,
  ) => Effect.Effect<HostSessionOpened, AgentUnavailable | HostFailed>;
  readonly events: (
    handle: string,
    afterSeq: number,
  ) => Stream.Stream<SequencedEvent, HostFailed>;
  readonly ack: (handle: string, seq: number) => Effect.Effect<void>;
  readonly connectorsSeen: (handle: string) => Stream.Stream<ConnectorsSeen>;
  /** The open session under `handle`, for the calls that act on it. */
  readonly session: (handle: string) => Effect.Effect<AgentSession, HostFailed>;
  /** Ends the session and waits for its agent to stop; a handle not yet open stays closed. */
  readonly close: (handle: string) => Effect.Effect<void>;
  readonly reload: (
    agent: AgentKind,
    reload: HostAgentReload,
  ) => Effect.Effect<void>;
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
    };

/** How many handles closed before their open arrived are remembered. */
const CLOSED_EARLY_KEPT = 256;

const noSession = (handle: string) =>
  new HostFailed({ message: `No agent session ${handle}.` });

/** The request as the agent's own options. Its app tools come over `mcp`, never in-process. */
const optionsFor = (
  request: HostSessionOpen,
  onConnectorsSeen: (seen: ConnectorsSeen) => void,
): OpenSessionOptions => {
  const { handle: _handle, agent: _agent, mcp, ...rest } = request;
  return {
    ...rest,
    ...(mcp === undefined
      ? {}
      : { mcp: { url: mcp.url, headers: mcp.headers } }),
    onConnectorsSeen,
  };
};

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
 * own: when the control plane goes, the host exits and its sessions with it.
 */
export const sessionsOnHost = (
  agents: HostAgents,
): Effect.Effect<HostSessionsService, never, Scope.Scope> =>
  Effect.gen(function* () {
    const root = yield* Effect.scope;
    const entries = new Map<string, Entry>();
    /** Handles closed before their open came in, so the open, when it does, is refused. */
    const closedEarly = new Set<string>();

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

    const openEntry = (handle: string) =>
      Effect.suspend(() => {
        const entry = entries.get(handle);
        return entry?.state === "open"
          ? Effect.succeed(entry)
          : Effect.fail(noSession(handle));
      });

    const open: HostSessionsService["open"] = (request) =>
      Effect.suspend(
        (): Effect.Effect<HostSessionOpened, AgentUnavailable | HostFailed> => {
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
            const scope = yield* Scope.fork(root);
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
            const fiber = yield* agents(request.agent).pipe(
              Effect.flatMap((host) =>
                host.open(
                  optionsFor(request, (report) => {
                    seen.last = report;
                    PubSub.publishUnsafe(changes, report);
                  }),
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
            });
            return openedFrom(exit.value.session);
          }).pipe(
            // A caller that gave up on the open has no session to close: the host closes it.
            Effect.onInterrupt(() => close(handle)),
          );
        },
      );

    return {
      open,
      events: (handle, afterSeq) =>
        Stream.unwrap(
          Effect.map(openEntry(handle), (entry) =>
            entry.log
              .subscribe(afterSeq)
              .pipe(Stream.interruptWhen(Deferred.await(entry.closed))),
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
      session: (handle) =>
        Effect.map(openEntry(handle), (entry) => entry.session),
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
  Effect.fail(
    new AgentUnavailable({ agent, message: `No ${agent} on this host.` }),
  );
