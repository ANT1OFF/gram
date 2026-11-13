import { randomUUID } from "node:crypto";
import type { AgentConnectors, AgentHost, AgentSession, OpenSessionOptions } from "@gram/agents";
import {
  type AgentEvent,
  type AgentKind,
  type HostSessionOpened,
  type ThreadId,
  AgentUnavailable,
  AnswerUndelivered,
  HostFailed,
  type HostSessionOpen,
  ModeRefused,
  type UserInput,
} from "@gram/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { LocalHostProcess } from "../host/local-process.ts";
import * as Option from "effect/Option";
import { KeptSessions } from "./kept-sessions.ts";
import { REATTACH_WITHIN_MS } from "../host/following-sessions.ts";
import { HOST_MCP_PATH } from "../host/machine-keys.ts";
import { type AttachmentsOnMachine, carryAttachments } from "../host/carry-attachments.ts";
import type { HostSessionsConnection } from "../host/protocol.ts";
import { AgentHosts } from "./agent-hosts.ts";
import { InputUndelivered } from "./undelivered.ts";

/** The event a session whose host went ends with. */
export const HOST_STOPPED_ENDED: AgentEvent = {
  type: "ended",
  reason: "This machine's host stopped, and the agent with it.",
};

/**
 * How a taken-up session's app tools are pointed at this Gram: again every second for up to ten
 * minutes; its MCP endpoint answers once the server is up.
 */
const RETARGET_RETRY = Schedule.spaced("1 second").pipe(
  Schedule.upTo({ duration: Duration.minutes(10) }),
);

/** How often the events a session's consumer has received are confirmed to its host. */
const ACK_EVERY = "250 millis";

/** The event a session ends with when its host no longer has it. */
const HOST_SESSION_GONE_ENDED: AgentEvent = {
  type: "ended",
  reason: "This machine's host no longer has the session.",
};

/**
 * The event a joined machine's session ends with when the machine came back without it: its host
 * restarted (an update, a reboot, a crash), and the agent with it. The runtime can resume the
 * conversation there (`restartedMachine`).
 */
export const machineRestartedEnded = (machine: string): AgentEvent => ({
  type: "ended",
  reason: `${machine} restarted, and the agent with it.`,
  restartedMachine: machine,
});

/** The event a joined machine's session ends with when the machine didn't come back in time. */
export const machineAwayEnded = (machine: string): AgentEvent => ({
  type: "ended",
  reason: `${machine} stopped or restarted and didn't come back within ${Math.round(
    REATTACH_WITHIN_MS / 60_000,
  )} minutes, so the agent stopped with it.`,
});

/**
 * Whether a session can open in the host process. What can't cross as data keeps it in the server:
 * a gateway profile (its keys live here), Codex (its homes and shared servers live here), a
 * workspace switch or a wait for a previous child (their proof is the server's own child), a dream
 * (its file bridge is in-process), and app tools with no MCP endpoint to reach them over.
 */
export const opensOnHost = (agent: AgentKind, options: OpenSessionOptions): boolean =>
  agent === "claude" &&
  options.model?.profileId === undefined &&
  options.switchStartup === undefined &&
  options.waitForPreviousSession === undefined &&
  options.audience !== "dream" &&
  options.dreamFilesOnly !== true &&
  options.dreamGuided !== true &&
  (options.appTools === undefined || options.mcp !== undefined);

const defined = <A extends object>(value: A): A =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as A;

/** The options as the host takes them: data only, the app tools over the MCP endpoint. */
const openRequest = (handle: string, agent: AgentKind, o: OpenSessionOptions): HostSessionOpen =>
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
    mcp: o.mcp === undefined ? undefined : { url: o.mcp.url, headers: { ...o.mcp.headers } },
    additionalDirectories: o.additionalDirectories,
    audience: o.audience,
    instructions: o.instructions,
    outwardGate: o.outwardGate,
    gateConnectors: o.gateConnectors,
    confineWrites: o.confineWrites,
    pinCwd: o.pinCwd,
    mcpAllowlist: o.mcpAllowlist,
    mcpDenylist: o.mcpDenylist,
    mcpServer: o.mcpServer === undefined ? undefined : { ...o.mcpServer },
    mcpNoneWithoutToolSearch: o.mcpNoneWithoutToolSearch,
    noBlockingAsk: o.noBlockingAsk,
    peerMessaging: o.peerMessaging,
    browser: o.browser,
    browserSurfaces: o.browserSurfaces === undefined ? undefined : { ...o.browserSurfaces },
  }) as HostSessionOpen;

/**
 * A send or steer the host didn't take, or can't say it took, dies as `InputUndelivered`, so the
 * runtime keeps the input rather than count it taken.
 */
const undelivered = (error: HostFailed) =>
  Effect.die(
    new InputUndelivered({ message: `The agent's machine didn't take it: ${error.message}` }),
  );

const logFailed = (call: string) => (error: HostFailed) =>
  Effect.logWarning("worker host: a session call didn't reach the agent").pipe(
    Effect.annotateLogs({ call, reason: error.message }),
  );

/**
 * A session of this machine's host kept running after Gram quits, as the app records it, so the
 * Gram that opens next can follow it on from where this one left it.
 */
export interface KeptSession {
  readonly threadId: ThreadId;
  readonly handle: string;
  readonly opened: HostSessionOpened;
  /**
   * The host's last event this Gram handled with the agent at rest (between turns): what it has
   * confirmed. The next Gram replays everything after it, the open turn whole.
   */
  readonly confirmed: number;
}

/** How a session in a kept-running host tells the app's record of it how it stands. */
export interface KeepHooks {
  readonly record: (kept: KeptSession) => void;
  readonly forget: (threadId: ThreadId, handle: string) => void;
  /** True once the app is quitting: its sessions are left running, not closed. */
  readonly detaching: () => boolean;
}

/** The statuses of an agent between turns. */
const AT_REST: ReadonlySet<string> = new Set(["idle", "error", "starting"]);

/** Whether `event` leaves the agent between turns, or mid-turn. */
const turnStateAfter = (event: AgentEvent, inTurn: boolean): boolean =>
  event.type === "turnEnd" ? false : event.type === "status" ? !AT_REST.has(event.status) : inTurn;

/**
 * A session opened in the host process, as the runtime holds it. Its events come numbered, and the
 * ones received are confirmed to the host, which keeps the rest for a stream that picks up again
 * (as a reconnecting host's will). A host that goes ends the session with an `ended` event, which
 * names the joined `machine` the session ran on, if it ran on one.
 *
 * A session on a joined `machine` has no process id here: its agent's is that machine's, so the
 * port chips never look for it among this machine's processes.
 */
const openOnHost = (
  host: HostSessionsConnection,
  agent: AgentKind,
  o: OpenSessionOptions,
  machine?: string,
  /** The input as the host's machine reads it; this machine's own host reads it as it is. */
  carry: (input: UserInput) => Effect.Effect<UserInput> = Effect.succeed,
  /**
   * This machine's host kept running after Gram quits: the record to keep, and with `attach`, the
   * session a Gram before this one left running, followed on instead of opening one.
   */
  keep?: { readonly hooks: KeepHooks; readonly attach?: KeptSession },
) =>
  Effect.gen(function* () {
    const attach = keep?.attach;
    const handle = attach?.handle ?? randomUUID();
    const threadId = o.threadId;
    // Added first, so a session whose open was given up on is closed on the host too. A Gram that
    // quits with the host kept running leaves it running there, for the next one.
    yield* Effect.addFinalizer(() =>
      keep?.hooks.detaching() === true
        ? Effect.void
        : host.close(handle).pipe(
            Effect.andThen(
              Effect.sync(() => {
                if (threadId !== undefined) keep?.hooks.forget(threadId, handle);
              }),
            ),
          ),
    );
    const opened =
      attach?.opened ??
      (yield* host.open(openRequest(handle, agent, o)).pipe(
        Effect.catchTag("HostFailed", (error) =>
          Effect.fail(
            new AgentUnavailable({
              agent,
              reason: "startup-failed",
              message: error.message,
            }),
          ),
        ),
      ));
    // Its app tools still point at the Gram that opened it, whose address and token are gone. At
    // a Gram's start the session is taken up before that Gram serves its MCP endpoint, so pointing
    // them here is tried again until it takes, for as long as the session lasts, rather than once.
    const mcp = o.mcp;
    if (attach !== undefined && mcp !== undefined) {
      const retarget = host.retarget;
      if (retarget === undefined) {
        yield* Effect.logWarning(
          "kept host: its host can't point a session's app tools here; they fail until it reopens",
        );
      } else {
        yield* retarget(handle, mcp).pipe(
          Effect.tapError((error) =>
            Effect.logDebug("kept host: a session's app tools aren't pointed here yet").pipe(
              Effect.annotateLogs({ reason: error.message }),
            ),
          ),
          Effect.retry(RETARGET_RETRY),
          Effect.tap(() => Effect.logInfo("kept host: a session's app tools point here")),
          Effect.catch((error) =>
            Effect.logWarning("kept host: a session's app tools couldn't be pointed here").pipe(
              Effect.annotateLogs({ reason: error.message }),
            ),
          ),
          Effect.forkScoped,
        );
      }
    }
    /** What a kept session confirmed: the host's last event handled with the agent at rest. */
    let confirmed = attach?.confirmed ?? 0;
    const remember = () => {
      if (keep !== undefined && threadId !== undefined)
        keep.hooks.record({ threadId, handle, opened, confirmed });
    };
    remember();
    const onSeen = o.onConnectorsSeen;
    if (onSeen !== undefined) {
      yield* host.connectorsSeen(handle).pipe(
        Stream.runForEach((seen) => Effect.sync(() => onSeen(seen))),
        Effect.forkScoped,
      );
    }
    /** Done once the session's events end: input still on its way to it has nowhere to go. */
    const over = yield* Deferred.make<void>();
    /** `call`, given up once the session has ended. */
    const whileOpen = (call: Effect.Effect<void, HostFailed>) =>
      Effect.raceFirst(
        call,
        Deferred.await(over).pipe(
          Effect.andThen(Effect.fail(new HostFailed({ message: "The session ended." }))),
        ),
      );
    let received = attach?.confirmed ?? 0;
    let acked = received;
    /** How many events this side has read, and those read with the agent at rest, in order. */
    let read = 0;
    let inTurn = attach !== undefined;
    const atRest: Array<{ readonly local: number; readonly host: number }> = [];
    // A kept session confirms only what was handled with the agent at rest, so the host keeps the
    // open turn whole for a Gram that opens after this one; any other confirms what arrived.
    yield* Effect.suspend(() => {
      const upTo = keep === undefined ? received : confirmed;
      if (upTo <= acked) return Effect.void;
      acked = upTo;
      return host.ack(handle, acked);
    }).pipe(Effect.repeat(Schedule.spaced(ACK_EVERY)), Effect.forkScoped);

    /**
     * The host's events after the last one received. A session the host no longer has ended there;
     * a host that went ended it too.
     */
    const events: Stream.Stream<AgentEvent> = Stream.suspend(() =>
      host.events(handle, received).pipe(
        Stream.map((next) => {
          received = next.seq;
          read += 1;
          if (keep !== undefined) {
            inTurn = turnStateAfter(next.event, inTurn);
            if (!inTurn) atRest.push({ local: read, host: next.seq });
          }
          return next.event;
        }),
        Stream.catch((error) =>
          Stream.make(
            machine === undefined
              ? error._tag === "NotFound"
                ? HOST_SESSION_GONE_ENDED
                : HOST_STOPPED_ENDED
              : // A machine that came back without the session restarted under it.
                error._tag === "NotFound"
                ? machineRestartedEnded(machine)
                : machineAwayEnded(machine),
          ),
        ),
        Stream.ensuring(Deferred.succeed(over, undefined)),
      ),
    );

    const connectors: AgentConnectors | undefined =
      opened.connectors === undefined
        ? undefined
        : {
            status: host.connectors
              .status(handle)
              .pipe(Effect.catchTag("HostFailed", (e) => Effect.fail(unavailable(agent, e)))),
            reconnect: (name) =>
              host.connectors
                .reconnect(handle, name)
                .pipe(Effect.catchTag("HostFailed", (e) => Effect.fail(unavailable(agent, e)))),
            setEnabled: (name, enabled) =>
              host.connectors
                .setEnabled(handle, name, enabled)
                .pipe(Effect.catchTag("HostFailed", (e) => Effect.fail(unavailable(agent, e)))),
            ...(opened.connectors.authenticate
              ? {
                  authenticate: (name: string) =>
                    host.connectors
                      .authenticate(handle, name)
                      .pipe(
                        Effect.catchTag("HostFailed", (e) => Effect.fail(unavailable(agent, e))),
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
      events,
      ...(attach === undefined ? {} : { reattached: true }),
      ...(keep === undefined
        ? {}
        : {
            handled: (count: number) => {
              let moved = false;
              while (atRest[0] !== undefined && atRest[0].local <= count) {
                confirmed = atRest.shift()!.host;
                moved = true;
              }
              if (moved) remember();
            },
          }),
      // Each under an id of its own, so the host takes it once however often it is asked.
      send: (input, sendOptions) =>
        carry(input).pipe(
          Effect.flatMap((carried) =>
            whileOpen(
              host.send(handle, carried, {
                ...sendOptions,
                deliveryId: sendOptions?.messageId ?? randomUUID(),
              }),
            ),
          ),
          Effect.catch(undelivered),
        ),
      steer: (input) =>
        carry(input).pipe(
          Effect.flatMap((carried) =>
            whileOpen(host.steer(handle, carried, { deliveryId: randomUUID() })),
          ),
          Effect.catch(undelivered),
        ),
      // A host that went has no turn left to stop.
      interrupt: host.interrupt(handle).pipe(Effect.catchTag("HostFailed", logFailed("interrupt"))),
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
              .pipe(Effect.catch((e) => Effect.as(logFailed("stopBackgroundTasks")(e), 0))),
          }
        : {}),
      ...(opened.stopTask
        ? {
            stopTask: (taskId: string) =>
              host
                .stopTask(handle, taskId)
                .pipe(Effect.catch((e) => Effect.as(logFailed("stopTask")(e), false))),
          }
        : {}),
      ...(opened.addDirectories
        ? {
            addDirectories: (paths: ReadonlyArray<string>) =>
              host
                .addDirectories(handle, paths)
                .pipe(Effect.catch((e) => Effect.as(logFailed("addDirectories")(e), false))),
          }
        : {}),
      ...(opened.processId && machine === undefined
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
  /** This machine's host kept running after Gram quits: its record, and what it kept. */
  keep?: {
    readonly hooks: KeepHooks;
    readonly take: (threadId: ThreadId) => KeptSession | undefined;
  },
): AgentHost => {
  const kind = inServer.kind;
  const invalidateRuntime = inServer.invalidateRuntime;
  const reloadConfig = inServer.reloadConfig;
  const reloadAllConfig = inServer.reloadAllConfig;
  return {
    ...inServer,
    open: (options) =>
      Effect.suspend(() =>
        // A host that can't hold the browser off (`browser-policy`) would run the CLI's own
        // Chrome default, so the server's own adapter, which holds it off, opens the session.
        gone() || !opensOnHost(kind, options) || host.browserPolicy !== true
          ? inServer.open(options)
          : openOnHost(
              host,
              kind,
              options,
              undefined,
              undefined,
              keep === undefined
                ? undefined
                : (() => {
                    const attach =
                      options.threadId === undefined ? undefined : keep.take(options.threadId);
                    return attach === undefined
                      ? { hooks: keep.hooks }
                      : { hooks: keep.hooks, attach };
                  })(),
            ).pipe(
              // The host went before the session opened: the server opens it instead.
              Effect.catch((error) => (gone() ? inServer.open(options) : Effect.fail(error))),
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
                profileId === undefined ? { kind: "config" } : { kind: "config", profileId },
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
export const AgentHostsThroughHost: Layer.Layer<AgentHosts, never, AgentHosts | LocalHostProcess> =
  Layer.effect(
    AgentHosts,
    Effect.gen(function* () {
      const inner = yield* AgentHosts;
      const connection = (yield* LocalHostProcess).connection;
      if (connection === undefined) return inner;
      // Absent in layers without it; off unless the host is the one kept running after Gram quits.
      const kept = Option.getOrUndefined(yield* Effect.serviceOption(KeptSessions));
      const keep = kept?.on === true ? { hooks: kept.hooks, take: kept.take } : undefined;
      // One wrapper per agent, so the runtime always holds the same object for it.
      const wrapped = new WeakMap<AgentHost, AgentHost>();
      return AgentHosts.of({
        get: (kind) =>
          Effect.map(inner.get(kind), (agent) => {
            if (kind !== "claude") return agent;
            const known = wrapped.get(agent);
            if (known !== undefined) return known;
            const through = agentHostThroughHost(connection.sessions, connection.gone, agent, keep);
            wrapped.set(agent, through);
            return through;
          }),
      });
    }),
  );

const isSignInProblem = (error: AgentUnavailable) =>
  error.reason === "not-logged-in" ||
  error.reason === "api-key-auth" ||
  error.reason === "third-party-provider";

/**
 * A session that couldn't start on `machine`, said of that machine: its sign-in problems with the
 * fix to make there, anything else with the machine's name before the agent's own words.
 */
export const onMachineUnavailable = (
  error: AgentUnavailable,
  machine: string,
): AgentUnavailable => {
  const agent = error.agent === "claude" ? "Claude Code" : error.agent;
  const message = (() => {
    switch (error.reason) {
      case "not-logged-in":
        return `${agent} isn't logged in on ${machine}. Run \`claude /login\` there, or choose Sign in under Settings → Machines.`;
      case "api-key-auth":
        return `${agent} on ${machine} is using API-key auth; Gram needs your subscription login. Run \`claude /login\` there.`;
      case "third-party-provider":
        return `${agent} on ${machine} is set up for a third-party API provider; Gram needs your subscription login there.`;
      default:
        return error.message.includes(machine) ? error.message : `On ${machine}: ${error.message}`;
    }
  })();
  return new AgentUnavailable({
    agent: error.agent,
    ...(error.reason === undefined ? {} : { reason: error.reason }),
    message,
  });
};

/**
 * `inServer`'s agent with its sessions opened on another machine's host, for a worker placed
 * there. Nothing opens here instead: a session the host can't run, or one asked for while the
 * machine is offline, is refused, since its folder is on that machine. Models and past sessions
 * stay the server's, as they do for this machine's host process.
 */
export const agentHostOnMachine = (
  host: HostSessionsConnection,
  gone: () => boolean,
  inServer: AgentHost,
  machineName: string,
  /** The tailnet address the machine reaches this Gram at, for its sessions' app tools. */
  origin: () => string | undefined,
  /** Told when a session there couldn't start for its sign-in, so the machine is asked again. */
  onSignInProblem?: () => void,
  /** Where the machine keeps what users attach, for each session's sends to carry them there. */
  attachments: AttachmentsOnMachine = () => Effect.fail(`${machineName} holds no attachments`),
): AgentHost => {
  const kind = inServer.kind;
  /** A start that failed there, named for the machine and logged here, where nothing else is. */
  const failedThere = (error: AgentUnavailable) =>
    Effect.gen(function* () {
      yield* Effect.logWarning("machines: an agent couldn't start on a joined machine").pipe(
        Effect.annotateLogs({
          machine: machineName,
          agent: kind,
          reason: error.reason ?? "",
        }),
      );
      if (isSignInProblem(error)) onSignInProblem?.();
      return yield* onMachineUnavailable(error, machineName);
    });
  /**
   * The app tools' endpoint as the machine reaches it: this Gram's tailnet address, where the
   * thread's own token is let through only for a thread placed on that machine.
   */
  const overTailnet = (options: OpenSessionOptions): OpenSessionOptions | undefined => {
    if (options.mcp === undefined) return options;
    const at = origin();
    return at === undefined
      ? undefined
      : { ...options, mcp: { ...options.mcp, url: `${at}${HOST_MCP_PATH}` } };
  };
  return {
    ...inServer,
    open: (options) =>
      Effect.suspend(() =>
        gone()
          ? Effect.fail(
              new AgentUnavailable({
                agent: kind,
                reason: "startup-failed",
                message: `${machineName} is offline; its workers start once it's back.`,
              }),
            )
          : !opensOnHost(kind, options)
            ? Effect.fail(
                new AgentUnavailable({
                  agent: kind,
                  reason: "startup-failed",
                  message: `This session can't run on ${machineName} yet.`,
                }),
              )
            : // A host there without `browser-policy` refuses the open itself
              // (`HOST_BROWSER_POLICY_MISSING`), checked against whichever host is connected then.
              Effect.suspend(() => {
                const reaching = overTailnet(options);
                return reaching === undefined
                  ? Effect.fail(
                      new AgentUnavailable({
                        agent: kind,
                        reason: "startup-failed",
                        message: `${machineName} is offline; its workers start once it's back.`,
                      }),
                    )
                  : openOnHost(host, kind, reaching, machineName, (input) =>
                      carryAttachments(options.threadId, input, machineName, attachments),
                    ).pipe(Effect.catch(failedThere));
              }),
      ),
  };
};
