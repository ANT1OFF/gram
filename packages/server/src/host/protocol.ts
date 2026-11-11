// The host protocol over one byte stream: the control plane's client on one end, a worker host's
// server on the other. Today the stream is a pipe to a child process on this machine; a paired
// machine's will be a connection over the tailnet, with the same messages.

import type {
  AgentSession,
  ConnectorSignInStart,
  ConnectorsSeen,
  ConnectorStatus,
  SendOptions,
  SequencedEvent,
} from "@gram/agents";
import {
  AgentUnavailable,
  AnswerUndelivered,
  type HostAgentReload,
  type HostStatus,
  type HostStopPrepared,
  type HostUpdateCheck,
  type HostUpdateProgress,
  HostUpdateRefused,
  type HostSessionOpen,
  type HostSessionOpened,
  HOST_PROTOCOL_VERSION,
  InterruptHung,
  ModeRefused,
  type HostCapability,
  type HostCheckResult,
  type HostRepoIdentity,
  HostCommandFailed,
  HostFailed,
  type HostHello,
  type HostId,
  type HostPortScan,
  HostRpcs,
  HostUnavailable,
  InvalidState,
  LOCAL_HOST_ID,
  HostWorktreeFailed,
  NotFound,
  type TerminalEvent,
  type UserInput,
} from "@gram/contracts";
import {
  type ProcError,
  ProcSpawnError,
  ProcTimeout,
  WorktreeError,
  type Worktrees,
} from "@gram/git";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { PortScan } from "../ports/scan.ts";
import {
  NetAddress,
  RpcClient,
  RpcSerialization,
  RpcServer,
  Socket,
  SocketServer,
} from "../platform/unstable.ts";
import type { HostAttachments, HostFileReads } from "./file-reads.ts";
import type { HostCheckRequest, HostChecks } from "./checks.ts";
import type { HostFiles } from "./files.ts";
import type { HostFolders } from "./folders.ts";
import { NOT_A_CLAUDE_TOKEN } from "./host-config.ts";
import type { HostGit } from "./git.ts";
import type { HostRepos } from "./repos.ts";
import { type Admission, UPDATING } from "./admission.ts";
import { type HostStop, type StopRequest, STOPPING } from "./stop.ts";
import type { HostSessionsService } from "./sessions.ts";
import type { HostTerminalsService, TerminalRoot } from "./terminals.ts";
import type {
  OpenSettings,
  OpenTerminal,
  Terminals,
  TerminalSnapshot,
} from "../terminal/terminals.ts";

/** A machine's worktrees, as a host serves them: the request's own options, all of them data. */
export interface HostWorktrees {
  readonly list: (
    repoPath: string,
    options: { readonly openCheckouts: ReadonlyArray<string> },
  ) => ReturnType<Worktrees["Service"]["list"]>;
  readonly baseBranches: Worktrees["Service"]["baseBranches"];
  readonly create: Worktrees["Service"]["create"];
  readonly remove: Worktrees["Service"]["remove"];
  readonly restore: Worktrees["Service"]["restore"];
  readonly pendingPermissions: Worktrees["Service"]["pendingPermissions"];
}

/**
 * The Claude token a joined machine keeps: one the user ran `claude setup-token` for on the main
 * machine and consented to send here. Its failures never carry the token.
 */
export interface HostClaudeToken {
  readonly setToken: (token: Redacted.Redacted<string>) => Effect.Effect<void, HostFailed>;
  /** True when there was one to delete. */
  readonly forgetToken: Effect.Effect<boolean, HostFailed>;
}

/** What a host serves: its folders, worktrees, git state and port scan, and who it says it is. */
export interface HostService {
  readonly hello: HostHello;
  readonly files: HostFiles;
  /**
   * Its folders for a one-off thread placed there: listed for the picker, checked to start in.
   * Every built host has them; a test's may leave them out, and its calls are then refused.
   */
  readonly folders?: HostFolders;
  /** Its threads' files scoped and read where they are. */
  readonly reads: HostFileReads;
  /** The files users attach to its sessions. */
  readonly attachments: HostAttachments;
  /** The clones it keeps of repositories, for the workers placed on it. */
  readonly repos: HostRepos;
  readonly worktrees: HostWorktrees;
  readonly git: HostGit;
  readonly terminals: HostTerminalsService;
  readonly sessions: HostSessionsService;
  readonly scan: Effect.Effect<PortScan, unknown>;
  /** A joined machine's; the main machine's own host keeps no token. */
  readonly claude?: HostClaudeToken;
  /** What it can run, checked afresh: its Claude sign-in and its tools. */
  readonly status?: Effect.Effect<HostStatus>;
  /** Project checks of pull requests, on a host that serves `checks`. */
  readonly checks?: HostChecks;
  /** Its own update, on a joined machine that runs as its service (`self-update.ts`). */
  readonly update?: HostUpdater;
  /** Whether it takes new work now; an update closes it before the restart (`admission.ts`). */
  readonly admission?: Admission;
  /** Its readiness to be stopped with its disk kept (`stop.ts`). */
  readonly stop?: HostStop;
}

/** A host's update of itself, as it serves `host.update.*`. */
export interface HostUpdater {
  readonly check: Effect.Effect<HostUpdateCheck>;
  readonly start: (release: string) => Stream.Stream<HostUpdateProgress, HostUpdateRefused>;
}

/** What a host without a token store answers. */
const NO_TOKEN_STORE = "This machine's host doesn't keep a Claude token.";

/** The capabilities a host must serve for this build to use it. */
export const HOST_CAPABILITIES: ReadonlyArray<HostCapability> = [
  "files",
  "ports",
  "worktrees",
  "git",
  "terminals",
  "sessions",
  "repos",
];

/**
 * The capabilities this build's host serves: the ones required, and those a control plane uses only
 * where a host advertises them, so a host on an older release still connects.
 */
export const HOST_SERVES: ReadonlyArray<HostCapability> = [
  ...HOST_CAPABILITIES,
  "deliveries",
  "file-reads",
  "attachments",
  "checks",
  "repo-identity",
  "folders",
];

const pairs = (map: ReadonlyMap<number, ReadonlyArray<number>>) =>
  [...map].map(([pid, values]) => [pid, [...values]] as const);

/** A scan as lists, for the wire. */
export const scanToWire = (scan: PortScan): HostPortScan => ({
  listening: pairs(scan.listening),
  children: pairs(scan.children),
  ...(scan.processes === undefined
    ? {}
    : {
        processes: [...scan.processes.values()].map((row) => ({
          pid: row.pid,
          ppid: row.ppid,
          ...(row.pgid === undefined ? {} : { pgid: row.pgid }),
          ...(row.tpgid === undefined ? {} : { tpgid: row.tpgid }),
          command: row.command,
        })),
      }),
});

/** A scan off the wire, as the port chips read it. */
export const scanFromWire = (wire: HostPortScan): PortScan => ({
  listening: new Map(wire.listening),
  children: new Map(wire.children),
  ...(wire.processes === undefined
    ? {}
    : { processes: new Map(wire.processes.map((row) => [row.pid, row] as const)) }),
});

const failureText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const worktreeToWire = (error: WorktreeError) =>
  new HostWorktreeFailed({ reason: error.reason, message: error.message, dirty: error.dirty });

const commandToWire = (error: ProcError) =>
  new HostCommandFailed({
    kind: error._tag === "ProcTimeout" ? "timeout" : "spawn",
    bin: error.bin,
    message: error.message,
  });

/** A connector's status for the wire, its optional keys absent rather than undefined. */
const connectorToWire = (status: ConnectorStatus) => defined({ ...status });

const seenToWire = (seen: ConnectorsSeen) => ({
  detailed: seen.detailed,
  whole: seen.whole,
  connectors: seen.connectors.map(connectorToWire),
});

/** `A` with each key that may be `undefined` made optional instead. */
type Defined<A> = {
  [K in keyof A as undefined extends A[K] ? never : K]: A[K];
} & {
  [K in keyof A as undefined extends A[K] ? K : never]?: Exclude<A[K], undefined>;
};

/** Drops keys whose value is `undefined`, for a payload whose optional keys must be absent. */
const defined = <A extends object>(value: A): Defined<A> =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Defined<A>;

const noFolders = new HostFailed({ message: "This host doesn't list its folders." });

/** The protocol's handlers over a host's own folders, worktrees, git state and scan. */
const handlersFor = (host: HostService) => {
  /** New work, refused while an update has closed the gate. */
  const admitted = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    host.admission === undefined
      ? effect
      : host.admission.admit(effect, () => new HostFailed({ message: UPDATING }));
  /** New work, refused too while the host is readied to stop. */
  const gated = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.suspend(() =>
      host.stop?.stopping() === true
        ? Effect.fail(new HostFailed({ message: STOPPING }))
        : admitted(effect),
    );
  return HostRpcs.toLayer(
    HostRpcs.of({
      "host.hello": () => Effect.succeed(host.hello),
      "host.files.list": ({ path, showHidden, limit }) =>
        host.files.list(path, { showHidden, limit }),
      "host.files.search": ({ root, query, regex, caseSensitive, offset, limit }) =>
        host.files.search(root, query, { regex, caseSensitive, offset, limit }),
      "host.files.names": ({ root }) => host.files.names(root),
      "host.files.scope": ({ path, roots }) => host.reads.scope(path, roots),
      "host.files.file": ({ path, roots, outside, maxBytes }) =>
        host.reads.file(path, roots, outside, maxBytes),
      "host.files.image": ({ path, roots, outside, maxBytes }) =>
        host.reads.image(path, roots, outside, maxBytes),
      "host.files.resolve": ({ paths, roots, outside }) =>
        host.reads.resolve(paths, roots, outside),
      "host.files.vocabulary": ({ root }) => host.reads.vocabulary(root),
      "host.folders.browse": ({ input, limit }) =>
        host.folders === undefined ? Effect.fail(noFolders) : host.folders.browse(input, limit),
      "host.folders.check": ({ path }) =>
        host.folders === undefined ? Effect.fail(noFolders) : host.folders.check(path),
      "host.files.fetch": ({ path, cwd, maxBytes }) => host.reads.fetch(path, cwd, maxBytes),
      "host.attachments.put": ({ threadId, name, data }) =>
        host.attachments.put(threadId, name, data),
      "host.attachments.remove": ({ threadId }) => host.attachments.remove(threadId),
      // Never a defect: one from a handler breaks the whole connection, not just this call.
      "host.status": () =>
        (host.status ?? Effect.succeed(UNKNOWN_STATUS)).pipe(
          Effect.catchCause(() => Effect.succeed(UNKNOWN_STATUS)),
        ),
      "host.update.check": () =>
        (host.update?.check ?? Effect.succeed({})).pipe(
          Effect.catchCause(() => Effect.succeed({})),
        ),
      "host.update.start": ({ release }) =>
        host.update?.start(release) ??
        Stream.fail(
          new HostUpdateRefused({
            reason: "unsupported",
            message: "This host doesn't update itself.",
          }),
        ),
      "host.stop.prepare": (request) =>
        host.stop === undefined
          ? Effect.fail(new HostFailed({ message: "This host can't be readied to stop." }))
          : host.stop.prepare(request),
      "host.stop.cancel": () => host.stop?.cancel ?? Effect.void,
      "host.ports.scan": () =>
        host.scan.pipe(
          Effect.map(scanToWire),
          Effect.mapError((error) => new HostFailed({ message: failureText(error) })),
        ),
      "host.repos.ensure": ({ url }) =>
        gated(host.repos.ensure(url).pipe(Effect.mapError(worktreeToWire))),
      "host.repos.identify": ({ repoRoot, path }) => host.repos.identify(repoRoot, path),
      "host.worktrees.list": ({ repoPath, openCheckouts }) =>
        host.worktrees.list(repoPath, { openCheckouts }).pipe(Effect.mapError(worktreeToWire)),
      "host.worktrees.baseBranches": ({ repoPath }) =>
        host.worktrees.baseBranches(repoPath).pipe(Effect.mapError(worktreeToWire)),
      "host.worktrees.create": (request) =>
        gated(host.worktrees.create(request).pipe(Effect.mapError(worktreeToWire))),
      "host.worktrees.remove": (request) =>
        host.worktrees.remove(request).pipe(Effect.mapError(worktreeToWire)),
      "host.worktrees.restore": (request) =>
        host.worktrees.restore(request).pipe(Effect.mapError(worktreeToWire)),
      "host.worktrees.pendingPermissions": ({ repoPath, worktreeDir }) =>
        host.worktrees
          .pendingPermissions(repoPath, worktreeDir)
          .pipe(Effect.mapError(worktreeToWire)),
      "host.checks.run": (request) =>
        host.checks === undefined
          ? Effect.fail(new HostFailed({ message: "This machine's host runs no local checks." }))
          : gated(host.checks.run(request)),
      "host.git.local": ({ cwd }) => host.git.local(cwd).pipe(Effect.mapError(commandToWire)),
      "host.git.present": ({ cwd }) => host.git.present(cwd),
      "host.git.watch": ({ paths, ...options }) => host.git.watch(paths, options),
      "host.terminals.open": ({ settingsShell, path, ...request }) =>
        gated(
          host.terminals.terminals
            .open(request, path === undefined ? undefined : { settingsShell, path })
            .pipe(
              // Every open names its folder, so no thread is looked up here.
              Effect.catchTag("ThreadNotFound", (error) =>
                Effect.fail(new InvalidState({ message: `No thread ${error.threadId}` })),
              ),
            ),
        ),
      // Typing into a shell can start a command in it.
      "host.terminals.input": ({ terminalId, data }) =>
        gated(host.terminals.terminals.input(terminalId, data)),
      "host.terminals.resize": ({ terminalId, cols, rows }) =>
        host.terminals.terminals.resize(terminalId, cols, rows),
      "host.terminals.close": ({ terminalId }) => host.terminals.terminals.close(terminalId),
      "host.terminals.list": ({ threadId }) => host.terminals.terminals.list(threadId),
      "host.terminals.subscribe": ({ terminalId }) =>
        host.terminals.terminals.subscribe(terminalId),
      "host.terminals.snapshot": ({ threadId }) => host.terminals.terminals.snapshot(threadId),
      "host.terminals.roots": () => host.terminals.roots,
      "host.sessions.open": (request) => gated(host.sessions.open(request)),
      "host.sessions.events": ({ handle, afterSeq }) => host.sessions.events(handle, afterSeq),
      "host.sessions.ack": ({ handle, seq }) => host.sessions.ack(handle, seq),
      "host.sessions.connectorsSeen": ({ handle }) =>
        host.sessions.connectorsSeen(handle).pipe(Stream.map(seenToWire)),
      "host.sessions.send": ({ handle, input, messageId, deliveryId }) =>
        gated(
          delivered(handle, deliveryId, (session) =>
            session.send(input, messageId === undefined ? undefined : { messageId }),
          ),
        ),
      "host.sessions.steer": ({ handle, input, deliveryId }) =>
        gated(delivered(handle, deliveryId, (session) => session.steer(input))),
      "host.sessions.interrupt": ({ handle }) =>
        withSession(handle, (session) => session.interrupt),
      "host.sessions.closeToolGate": ({ handle }) =>
        withSession(handle, (session) => session.closeToolGate ?? Effect.void),
      "host.sessions.stopBackgroundTasks": ({ handle }) =>
        withSession(handle, (session) => session.stopBackgroundTasks ?? Effect.succeed(0)),
      "host.sessions.stopTask": ({ handle, taskId }) =>
        withSession(handle, (session) => session.stopTask?.(taskId) ?? Effect.succeed(false)),
      "host.sessions.respond": ({ handle, requestId, answer }) =>
        withSession(handle, (session) => session.respond(requestId, answer)),
      "host.sessions.setMode": ({ handle, mode }) =>
        withSession(handle, (session) => session.setMode(mode)),
      "host.sessions.setModel": ({ handle, model }) =>
        withSession(handle, (session) => session.setModel(model)),
      "host.sessions.addDirectories": ({ handle, paths }) =>
        withSession(handle, (session) => session.addDirectories?.(paths) ?? Effect.succeed(false)),
      "host.sessions.processId": ({ handle }) =>
        withSession(handle, (session) =>
          (session.processId ?? Effect.succeed(undefined)).pipe(Effect.map((pid) => pid ?? null)),
        ),
      "host.sessions.connectorsStatus": ({ handle }) =>
        withConnectors(handle, (connectors) =>
          connectors.status.pipe(Effect.map((list) => list.map(connectorToWire))),
        ),
      "host.sessions.connectorsReconnect": ({ handle, name }) =>
        withConnectors(handle, (connectors) => connectors.reconnect(name)),
      "host.sessions.connectorsSetEnabled": ({ handle, name, enabled }) =>
        withConnectors(handle, (connectors) => connectors.setEnabled(name, enabled)),
      "host.sessions.connectorsAuthenticate": ({ handle, name }) =>
        withConnectors(
          handle,
          (connectors): Effect.Effect<ConnectorSignInStart, AgentUnavailable | HostFailed> =>
            connectors.authenticate === undefined
              ? Effect.fail(
                  new HostFailed({
                    message: "This agent can't start a sign-in.",
                  }),
                )
              : connectors.authenticate(name),
        ),
      "host.sessions.close": ({ handle }) => host.sessions.close(handle),
      "host.sessions.reload": ({ agent, reload }) => host.sessions.reload(agent, reload),
      "host.claude.setToken": ({ token }) =>
        host.claude === undefined
          ? Effect.fail(new HostFailed({ message: NO_TOKEN_STORE }))
          : host.claude.setToken(token),
      "host.claude.forgetToken": () =>
        host.claude === undefined ? Effect.succeed(false) : host.claude.forgetToken,
    }),
  );
  function withSession<A, E>(
    handle: string,
    f: (session: AgentSession) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | HostFailed> {
    return Effect.flatMap(host.sessions.session(handle), f);
  }
  /** Input for the session, taken once per delivery id when the caller named one. */
  function delivered(
    handle: string,
    deliveryId: string | undefined,
    f: (session: AgentSession) => Effect.Effect<void>,
  ): Effect.Effect<void, HostFailed> {
    return deliveryId === undefined
      ? withSession(handle, f)
      : host.sessions.deliver(handle, deliveryId, f);
  }
  function withConnectors<A, E>(
    handle: string,
    f: (connectors: NonNullable<AgentSession["connectors"]>) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | HostFailed> {
    return withSession(handle, (session): Effect.Effect<A, E | HostFailed> =>
      session.connectors === undefined
        ? Effect.fail(new HostFailed({ message: "This session has no connectors." }))
        : f(session.connectors),
    );
  }
};

/** What a stop of `serveHost` from this side does first, as its socket's owner says. */
export interface ServeHostOptions {
  /** Whether the owner saw the socket end already, so there is nothing left to close. */
  readonly socketEnded?: () => boolean;
  /**
   * Closes the socket before the RPC server ends the calls still running. Only the owner knows
   * how to close it well: a WebSocket with its close frame (`dialOnce`); a plain stream has none
   * here, since destroying one with data unread resets it under its peer.
   */
  readonly closeFirst?: Effect.Effect<void>;
}

/**
 * Serves `host` on `socket` until the other end closes it. One connection, one control plane: a
 * host never accepts a second caller on the same stream.
 *
 * Stopped from this side (the host process shutting down in order: `systemctl restart`, an
 * update, an installer rerun), `closeFirst` runs before the RPC server ends the calls still
 * running. Ended first, those calls would answer as interrupted over a connection still up, and
 * the control plane would take each session's events as over rather than wait for the host to dial
 * in again and resume the session there. Closed first, the connection drops as any other does.
 */
export const serveHost = (
  socket: Socket.Socket,
  host: HostService,
  options: ServeHostOptions = {},
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const closed = yield* Deferred.make<void>();
    /** Open, and no read has failed: a close can go out. Any other write waits for good. */
    let up = false;
    const downOnError = <A, E, R>(read: Effect.Effect<A, E, R>) =>
      Effect.tapError(read, () =>
        Effect.sync(() => {
          up = false;
        }),
      );
    const served: Socket.Socket = {
      ...socket,
      reader: downOnError(socket.reader).pipe(
        Effect.map((reader) => {
          up = true;
          return { ...reader, pull: downOnError(reader.pull) };
        }),
      ),
    };
    const oneConnection = Layer.succeed(SocketServer.SocketServer, {
      address: NetAddress.unixPathAddress("host-stream"),
      run: (handler) =>
        handler(served).pipe(
          Effect.ignore,
          Effect.andThen(Deferred.succeed(closed, undefined)),
          Effect.andThen(Effect.never),
        ),
    });
    yield* Layer.build(
      RpcServer.layer(HostRpcs).pipe(
        Layer.provide(handlersFor(host)),
        Layer.provide(RpcServer.layerProtocolSocketServer),
        Layer.provide(oneConnection),
        Layer.provide(RpcSerialization.layerNdjson),
      ),
    );
    // Run before the scope closes the server. Bounded, for a stream that went unseen.
    const closeFirst = Effect.suspend(() =>
      options.closeFirst === undefined || !up || options.socketEnded?.() === true
        ? Effect.void
        : options.closeFirst.pipe(
            Effect.interruptible,
            Effect.timeoutOrElse({ duration: "1 second", orElse: () => Effect.void }),
            Effect.ignore,
          ),
    );
    yield* Deferred.await(closed).pipe(Effect.onInterrupt(() => closeFirst));
  }).pipe(Effect.scoped);

/** A host's git state as the control plane reaches it: a watch ends when the host goes. */
export interface HostGitConnection {
  readonly local: HostGit["local"];
  readonly present: HostGit["present"];
  readonly watch: (
    ...args: Parameters<HostGit["watch"]>
  ) => Stream.Stream<Stream.Success<ReturnType<HostGit["watch"]>>, HostUnavailable>;
}

/**
 * A host's terminals as the control plane reaches them. The control plane chooses each one's folder
 * and reads its settings. A host that has gone has no terminals: its reads come back empty, a
 * close finds nothing to do, and a subscription ends with its shell's exit.
 */
export interface HostTerminalsConnection {
  /** Without `settings`, the host's own default shell on its own PATH. */
  readonly open: (
    request: OpenTerminal & { readonly cwd: string },
    settings: OpenSettings | undefined,
  ) => Effect.Effect<Effect.Success<ReturnType<Terminals["open"]>>, NotFound | InvalidState>;
  readonly input: Terminals["input"];
  readonly resize: Terminals["resize"];
  readonly close: Terminals["close"];
  readonly list: Terminals["list"];
  readonly subscribe: Terminals["subscribe"];
  readonly snapshot: (
    threadId: Parameters<Terminals["snapshot"]>[0],
  ) => Effect.Effect<ReadonlyArray<TerminalSnapshot>>;
  /** The host's threads' shells as they start and end; fails once the host has gone. */
  readonly roots: Stream.Stream<TerminalRoot, HostUnavailable>;
}

/**
 * A host's agent sessions as the control plane reaches them, each by the handle it chose. A call
 * the host couldn't answer fails with `HostFailed`, whatever the reason; the errors an agent itself
 * gives keep their own tags. A host that has gone has no sessions: their events end, a close finds
 * nothing to do.
 */
export interface HostSessionsConnection {
  readonly open: (
    request: HostSessionOpen,
  ) => Effect.Effect<HostSessionOpened, AgentUnavailable | HostFailed>;
  readonly events: (
    handle: string,
    afterSeq: number,
  ) => Stream.Stream<SequencedEvent, HostUnavailable | NotFound>;
  readonly ack: (handle: string, seq: number) => Effect.Effect<void>;
  readonly connectorsSeen: (handle: string) => Stream.Stream<ConnectorsSeen>;
  /**
   * A send or a steer with a `deliveryId` is taken once by a host that serves `deliveries`, so it
   * can be asked again when its answer was lost.
   */
  readonly send: (
    handle: string,
    input: UserInput,
    options?: SendOptions & { readonly deliveryId?: string },
  ) => Effect.Effect<void, HostFailed>;
  readonly steer: (
    handle: string,
    input: UserInput,
    options?: { readonly deliveryId?: string },
  ) => Effect.Effect<void, HostFailed>;
  readonly interrupt: (handle: string) => Effect.Effect<void, InterruptHung | HostFailed>;
  readonly closeToolGate: (handle: string) => Effect.Effect<void, HostFailed>;
  readonly stopBackgroundTasks: (handle: string) => Effect.Effect<number, HostFailed>;
  readonly stopTask: (handle: string, taskId: string) => Effect.Effect<boolean, HostFailed>;
  readonly respond: (
    handle: string,
    ...args: Parameters<AgentSession["respond"]>
  ) => Effect.Effect<void, AnswerUndelivered | HostFailed>;
  readonly setMode: (
    handle: string,
    ...args: Parameters<AgentSession["setMode"]>
  ) => Effect.Effect<void, ModeRefused | HostFailed>;
  readonly setModel: (
    handle: string,
    ...args: Parameters<AgentSession["setModel"]>
  ) => Effect.Effect<void, HostFailed>;
  readonly addDirectories: (
    handle: string,
    paths: ReadonlyArray<string>,
  ) => Effect.Effect<boolean, HostFailed>;
  readonly processId: (handle: string) => Effect.Effect<number | undefined, HostFailed>;
  readonly connectors: {
    readonly status: (
      handle: string,
    ) => Effect.Effect<ReadonlyArray<ConnectorStatus>, AgentUnavailable | HostFailed>;
    readonly reconnect: (
      handle: string,
      name: string,
    ) => Effect.Effect<void, AgentUnavailable | HostFailed>;
    readonly setEnabled: (
      handle: string,
      name: string,
      enabled: boolean,
    ) => Effect.Effect<"applied" | "restart", AgentUnavailable | HostFailed>;
    readonly authenticate: (
      handle: string,
      name: string,
    ) => Effect.Effect<
      { readonly authorizationUrl: string } | "started",
      AgentUnavailable | HostFailed
    >;
  };
  readonly close: (handle: string) => Effect.Effect<void>;
  readonly reload: (
    agent: HostSessionOpen["agent"],
    reload: HostAgentReload,
  ) => Effect.Effect<void>;
}

/**
 * What a worker's worktree on the host is now, as its host reads it there: for confirming what the
 * control plane recorded when it made it, never as a grant of its own.
 */
export type HostRepoIdentify = (
  repoRoot: string,
  path: string,
) => Effect.Effect<HostRepoIdentity, HostFailed | HostUnavailable>;

/** A host's project checks as the control plane reaches them. */
export interface HostChecksConnection {
  /**
   * Runs the check of `request.id`, or joins the one under way. `HostFailed` is the host's own
   * refusal; `HostUnavailable` means the connection went before it answered, so how the check
   * ended is unknown, and asking again under the same id finds it.
   */
  readonly run: (
    request: HostCheckRequest,
  ) => Effect.Effect<HostCheckResult, HostFailed | HostUnavailable>;
}

/** A connected host, as the control plane reaches it. */
export interface HostConnection {
  readonly hello: HostHello;
  readonly files: HostFiles;
  /** Absent for a host from a build that doesn't serve `folders`. */
  readonly folders: HostFolders | undefined;
  /** Absent for a host from a build that doesn't serve `file-reads`. */
  readonly reads: HostFileReads | undefined;
  /** Absent for a host from a build that doesn't serve `attachments`. */
  readonly attachments: HostAttachments | undefined;
  readonly repos: {
    readonly ensure: (url: string) => Effect.Effect<{ readonly path: string }, WorktreeError>;
    /** Absent for a host from a build that doesn't serve `repo-identity`. */
    readonly identify?: HostRepoIdentify | undefined;
  };
  readonly worktrees: HostWorktrees;
  readonly git: HostGitConnection;
  readonly terminals: HostTerminalsConnection;
  readonly sessions: HostSessionsConnection;
  readonly scan: Effect.Effect<PortScan, unknown>;
  /**
   * The machine's Claude token. A host built before these calls, or one that doesn't answer,
   * fails with `HostFailed` saying so; no failure carries the token.
   */
  readonly claude: HostClaudeToken;
  /**
   * What the machine can run as its host reads it now: unknown, with no tools, when the host
   * doesn't answer, is too old to know the call, or has gone.
   */
  readonly status?: Effect.Effect<HostStatus>;
  /** Its project checks; absent on a host that doesn't serve `checks`, an older one say. */
  readonly checks?: HostChecksConnection;
  /** Its own update, when it serves `update`. */
  readonly update?: {
    readonly check: Effect.Effect<HostUpdateCheck, HostUnavailable>;
    readonly start: (
      release: string,
    ) => Stream.Stream<HostUpdateProgress, HostUpdateRefused | HostUnavailable>;
  };
  /**
   * Readies it to be stopped with its disk kept, and takes that back. A host built before these
   * calls, or one that doesn't answer, fails with `HostFailed` or `HostUnavailable`.
   */
  readonly stop: {
    readonly prepare: (
      request: StopRequest,
    ) => Effect.Effect<HostStopPrepared, HostFailed | HostUnavailable>;
    readonly cancel: Effect.Effect<void, HostFailed | HostUnavailable>;
  };
  /** Whether the host has gone: its process ended or its stream closed. Calls fail at once then. */
  readonly gone: () => boolean;
}

/** What a token call says when the host didn't answer it, the token left out. */
export const HOST_TOKEN_UNANSWERED =
  "This machine's gram-host didn't take the token. It may be older than this Gram: update it there and try again.";

/** What a token call says when the host refused it in words this side doesn't pass on. */
export const HOST_TOKEN_REFUSED = "This machine's gram-host refused the token.";

/** The file errors a joined host's token store reports, by code; any other code isn't passed on. */
const STORE_ERROR_CODES: ReadonlySet<string> = new Set([
  "EACCES",
  "EPERM",
  "ENOSPC",
  "EDQUOT",
  "EROFS",
  "EEXIST",
  "ENOENT",
  "ENOTDIR",
  "EISDIR",
  "ELOOP",
  "EMFILE",
  "ENFILE",
  "EIO",
  "EBUSY",
]);

/** How a joined host's store words a failed step: the step and a code, nothing else. */
const STORE_REFUSAL = /^Couldn't (keep|delete) the Claude token: ([A-Z]{2,12}|file error)\.$/;

/**
 * A host's refusal as this side passes it on: a message built here from a known step and a known
 * error code, never text the host chose, which could carry part of the token it was sent.
 */
export const publicTokenRefusal = (message: string): string => {
  if (message === NOT_A_CLAUDE_TOKEN) return NOT_A_CLAUDE_TOKEN;
  if (message === NO_TOKEN_STORE) return NO_TOKEN_STORE;
  const parts = STORE_REFUSAL.exec(message);
  if (parts === null) return HOST_TOKEN_REFUSED;
  const step = parts[1] === "keep" ? "keep" : "delete";
  const code = STORE_ERROR_CODES.has(parts[2]!) ? parts[2]! : "file error";
  return `Couldn't ${step} the Claude token: ${code}.`;
};

/** How long a token call waits for the host. */
const TOKEN_CALL_TIMEOUT = "20 seconds";

/** What the Files panel shows when the host doesn't answer; the detail goes to the log. */
export const HOST_NOT_ANSWERING = "This machine's host isn't answering.";

/**
 * A file read the host couldn't answer reads as the Files panel's own refusal: a missing file
 * stays `NotFound` and a refused one `InvalidState`, with the host's words. A host that failed
 * says why; a stream that broke reads as the host not answering, its detail logged.
 */
const asInvalid = (error: { readonly _tag: string; readonly message?: string }) =>
  error._tag === "HostFailed"
    ? Effect.succeed(
        new InvalidState({ message: `This machine's host couldn't do it: ${error.message ?? ""}` }),
      )
    : Effect.logWarning("worker host: a call failed on the stream").pipe(
        Effect.annotateLogs({ reason: failureText(error) }),
        Effect.as(new InvalidState({ message: HOST_NOT_ANSWERING })),
      );

const keepFileErrors = <E extends { readonly _tag: string; readonly message?: string }>(
  error: E,
): Effect.Effect<NotFound | InvalidState> =>
  error instanceof NotFound || error instanceof InvalidState
    ? Effect.succeed(error)
    : asInvalid(error);

/** A worktree call the host couldn't answer reads as the worktree layer's own error. */
const worktreeFromWire = <E extends { readonly _tag: string; readonly message?: string }>(
  error: E,
): Effect.Effect<WorktreeError> =>
  error instanceof HostWorktreeFailed
    ? Effect.succeed(
        new WorktreeError({ reason: error.reason, message: error.message, dirty: error.dirty }),
      )
    : Effect.map(
        asInvalid(error),
        (invalid) =>
          new WorktreeError({ reason: "failed", message: invalid.message, dirty: false }),
      );

/**
 * A git read the host couldn't answer reads as the command layer's own error: a host whose
 * command overran stays a timeout, so its state reads as unknown rather than clean.
 */
const commandFromWire = <E extends { readonly _tag: string; readonly message?: string }>(
  error: E,
): Effect.Effect<ProcError> =>
  error instanceof HostCommandFailed
    ? Effect.succeed(
        error.kind === "timeout"
          ? new ProcTimeout({ bin: error.bin, message: error.message })
          : new ProcSpawnError({ bin: error.bin, message: error.message }),
      )
    : Effect.map(
        asInvalid(error),
        (invalid) => new ProcSpawnError({ bin: "gram-host", message: invalid.message }),
      );

const keepInvalid = <E extends { readonly _tag: string; readonly message?: string }>(
  error: E,
): Effect.Effect<InvalidState> =>
  error instanceof InvalidState ? Effect.succeed(error) : asInvalid(error);

/** For a session call that keeps none of the errors it can fail with. */
const none = (error: unknown): error is never => error === none;
const isAgentUnavailable = (error: unknown): error is AgentUnavailable =>
  error instanceof AgentUnavailable;

/** How long a host's status (its `claude auth status`, its tools) gets before it reads as unknown. */
const STATUS_TIMEOUT = "30 seconds";

/** A host that can't say what it can run. */
export const UNKNOWN_STATUS: HostStatus = { claudeSignIn: "unknown", tools: [] };

/** What a stop call says when the host didn't take it. */
export const HOST_STOP_UNANSWERED =
  "This machine's gram-host can't be readied to stop. It may be older than this Gram.";

/** How long a host gets to commit and push its threads' work in progress before a stop. */
const STOP_TIMEOUT = "10 minutes";

/** How long a host gets to say hello before it counts as not answering. */
const HELLO_TIMEOUT = "5 seconds";

export interface ConnectOptions {
  /** The host this connection should reach; a hello from any other is refused. */
  readonly hostId: HostId;
  /**
   * Fails when the host is known to be gone (its process exited), so a call in flight fails at
   * once rather than waiting on a stream no one will answer. Never succeeds.
   */
  readonly gone?: Effect.Effect<never, HostUnavailable>;
  /** Runs once when the host is found gone, whichever way: its owner stops what is left of it. */
  readonly onEnded?: (reason: string) => Effect.Effect<void>;
  /** Told the host's hello as soon as it is read, before it is checked. */
  readonly onHello?: (hello: HostHello) => void;
}

/**
 * Why this build can't use a host that said `hello`: it speaks another protocol version, or doesn't
 * serve everything this build needs. Either way one of the two builds needs an update.
 */
export const helloMismatch = (
  hello: HostHello,
):
  | { readonly kind: "protocol" }
  | { readonly kind: "capabilities"; readonly missing: ReadonlyArray<HostCapability> }
  | undefined => {
  if (hello.protocol !== HOST_PROTOCOL_VERSION) return { kind: "protocol" };
  const missing = HOST_CAPABILITIES.filter((need) => !hello.capabilities.includes(need));
  return missing.length > 0 ? { kind: "capabilities", missing } : undefined;
};

/**
 * Connects to the host at the other end of `socket` and checks its hello: a host that doesn't
 * answer in time, isn't the one expected, speaks another protocol version, or doesn't serve what
 * this build needs is unavailable. A broken stream is never reopened: the host is gone, and every
 * call after it fails rather than waits.
 */
export const connectHost = (
  socket: Socket.Socket,
  options: ConnectOptions = { hostId: LOCAL_HOST_ID },
): Effect.Effect<HostConnection, HostUnavailable, Scope.Scope> =>
  Effect.gen(function* () {
    const unavailable = (message: string) =>
      new HostUnavailable({ hostId: options.hostId, message });
    let ended = false;
    const goneNow = Effect.suspend(() =>
      Effect.fail(unavailable("This machine's host has stopped.")),
    );
    const markEnded = (reason: string) =>
      Effect.suspend(() => {
        if (ended) return Effect.void;
        ended = true;
        return Effect.logWarning("worker host: it has gone").pipe(
          Effect.annotateLogs({ hostId: options.hostId, reason }),
          Effect.andThen(options.onEnded?.(reason) ?? Effect.void),
        );
      });
    const gone = (options.gone ?? Effect.never).pipe(
      Effect.tapError((error) => markEnded(error.message)),
    );
    // Marks the host ended as soon as it goes, not only when a call next races against it.
    yield* Effect.forkScoped(Effect.ignore(gone));
    /**
     * A call the host interrupted itself reads as the host going: one built before it closed its
     * socket first ends its calls that way as it stops (`serveHost`), over a connection still up
     * for a moment. Taken as a session's own end, that failed the turn rather than wait for the
     * redial. The connection isn't marked ended, since its socket says whether it is.
     */
    const stoppedByHost = () => unavailable("The host stopped while it answered.");
    /**
     * A call raced against the host going. A broken stream ends the host too, since nothing
     * reopens it; once it has ended, a call fails before it starts.
     */
    const guarded = <A, E extends { readonly _tag: string }>(
      call: Effect.Effect<A, E>,
    ): Effect.Effect<A, E | HostUnavailable> =>
      Effect.suspend(() =>
        ended
          ? goneNow
          : Effect.raceFirst(call, gone).pipe(
              // Only an interruption that came back from the host: one of the caller's own never
              // reaches this.
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.fail(stoppedByHost())
                  : Effect.failCause(cause),
              ),
              Effect.tapError((error) =>
                error._tag === "RpcClientError" ? markEnded(failureText(error)) : Effect.void,
              ),
            ),
      );

    // Pings every five seconds. No retries: reopening would hand back the same closed stream.
    const protocol = yield* RpcClient.makeProtocolSocket({ retryPolicy: Schedule.recurs(0) }).pipe(
      Effect.provideService(Socket.Socket, socket),
      Effect.provide(RpcSerialization.layerNdjson),
    );
    const client = yield* RpcClient.make(HostRpcs).pipe(
      Effect.provideService(RpcClient.Protocol, protocol),
    );
    const hello = yield* guarded(client["host.hello"]()).pipe(
      Effect.timeoutOrElse({
        duration: HELLO_TIMEOUT,
        orElse: () => Effect.fail(unavailable("The host didn't say hello in time.")),
      }),
      Effect.mapError((error) =>
        error._tag === "HostUnavailable"
          ? error
          : unavailable(`The host didn't answer: ${failureText(error)}`),
      ),
    );
    options.onHello?.(hello);
    if (hello.hostId !== options.hostId) {
      return yield* unavailable(`A host answered as "${hello.hostId}", not "${options.hostId}".`);
    }
    const mismatch = helloMismatch(hello);
    if (mismatch?.kind === "protocol") {
      return yield* unavailable(
        `The host speaks protocol ${hello.protocol}; this build speaks ${HOST_PROTOCOL_VERSION}.`,
      );
    }
    if (mismatch?.kind === "capabilities") {
      return yield* unavailable(`The host doesn't serve ${mismatch.missing.join(", ")}.`);
    }
    const files: HostFiles = {
      list: (path, { showHidden, limit }) =>
        guarded(client["host.files.list"]({ path, showHidden, limit })).pipe(
          Effect.catch((error) => Effect.flatMap(keepFileErrors(error), Effect.fail)),
        ),
      search: (root, query, opts) =>
        guarded(
          client["host.files.search"]({
            root,
            query,
            regex: opts.regex ?? false,
            caseSensitive: opts.caseSensitive ?? false,
            offset: opts.offset,
            limit: opts.limit,
          }),
        ).pipe(Effect.catch((error) => Effect.flatMap(keepInvalid(error), Effect.fail))),
      names: (root) =>
        guarded(client["host.files.names"]({ root })).pipe(
          Effect.catch((error) => Effect.flatMap(keepInvalid(error), Effect.fail)),
        ),
    };
    const reads: HostFileReads = {
      scope: (path, roots) =>
        guarded(client["host.files.scope"]({ path, roots })).pipe(
          Effect.catch((error) => Effect.flatMap(keepFileErrors(error), Effect.fail)),
        ),
      file: (path, roots, outside, maxBytes) =>
        guarded(client["host.files.file"]({ path, roots, outside, maxBytes })).pipe(
          Effect.catch((error) => Effect.flatMap(keepFileErrors(error), Effect.fail)),
        ),
      image: (path, roots, outside, maxBytes) =>
        guarded(client["host.files.image"]({ path, roots, outside, maxBytes })).pipe(
          Effect.catch((error) => Effect.flatMap(keepFileErrors(error), Effect.fail)),
        ),
      resolve: (paths, roots, outside) =>
        guarded(client["host.files.resolve"]({ paths, roots, outside })).pipe(
          Effect.catch((error) => Effect.flatMap(keepInvalid(error), Effect.fail)),
        ),
      vocabulary: (root) =>
        guarded(client["host.files.vocabulary"]({ root })).pipe(
          Effect.catch((error) => Effect.flatMap(keepInvalid(error), Effect.fail)),
        ),
      fetch: (path, cwd, maxBytes) =>
        guarded(client["host.files.fetch"]({ path, cwd, maxBytes })).pipe(
          Effect.catch((error) => Effect.flatMap(keepFileErrors(error), Effect.fail)),
        ),
    };
    const folders: HostFolders = {
      browse: (input, limit) =>
        guarded(client["host.folders.browse"]({ input, limit })).pipe(
          Effect.catch((error) => Effect.flatMap(keepFileErrors(error), Effect.fail)),
        ),
      check: (path) =>
        guarded(client["host.folders.check"]({ path })).pipe(
          Effect.catch((error) => Effect.flatMap(keepFileErrors(error), Effect.fail)),
        ),
    };
    const attachments: HostAttachments = {
      put: (threadId, name, data) =>
        guarded(client["host.attachments.put"]({ threadId, name, data })).pipe(
          Effect.catch((error) => Effect.flatMap(keepInvalid(error), Effect.fail)),
        ),
      // A host that went holds nothing more to delete now; its own prune takes the rest.
      remove: (threadId) =>
        guarded(client["host.attachments.remove"]({ threadId })).pipe(Effect.ignore),
    };
    const worktreeCall = <A, E extends { readonly _tag: string; readonly message?: string }>(
      call: Effect.Effect<A, E>,
    ) =>
      guarded(call).pipe(
        Effect.catch((error) => Effect.flatMap(worktreeFromWire(error), Effect.fail)),
      );
    const worktrees: HostWorktrees = {
      list: (repoPath, { openCheckouts }) =>
        worktreeCall(client["host.worktrees.list"]({ repoPath, openCheckouts })),
      baseBranches: (repoPath) => worktreeCall(client["host.worktrees.baseBranches"]({ repoPath })),
      create: (request) =>
        worktreeCall(
          client["host.worktrees.create"](
            defined({
              repoPath: request.repoPath,
              branch: request.branch,
              base: request.base,
              openCheckouts: request.openCheckouts,
            }),
          ),
        ),
      remove: (request) =>
        worktreeCall(
          client["host.worktrees.remove"](
            defined({
              repoPath: request.repoPath,
              worktreeDir: request.worktreeDir,
              force: request.force,
              mergeRules: request.mergeRules,
              openCheckouts: request.openCheckouts,
            }),
          ),
        ),
      restore: (request) =>
        worktreeCall(
          client["host.worktrees.restore"](
            defined({
              repoPath: request.repoPath,
              worktreeDir: request.worktreeDir,
              branch: request.branch,
              fromPr: request.fromPr,
              openCheckouts: request.openCheckouts,
            }),
          ),
        ),
      pendingPermissions: (repoPath, worktreeDir) =>
        worktreeCall(client["host.worktrees.pendingPermissions"]({ repoPath, worktreeDir })),
    };
    const git: HostGitConnection = {
      local: (cwd) =>
        guarded(client["host.git.local"]({ cwd })).pipe(
          Effect.catch((error) => Effect.flatMap(commandFromWire(error), Effect.fail)),
        ),
      // A host that can't say counts the folder as there, as an unreadable folder does: its git
      // then says why.
      present: (cwd) =>
        guarded(client["host.git.present"]({ cwd })).pipe(Effect.orElseSucceed(() => true)),
      watch: (paths, watchOptions = {}) =>
        Stream.suspend(() =>
          ended
            ? Stream.fail(unavailable("This machine's host has stopped."))
            : client["host.git.watch"](
                defined({
                  paths,
                  debounceMs: watchOptions.debounceMs,
                  cooldownMs: watchOptions.cooldownMs,
                  backend: watchOptions.backend,
                }),
              ).pipe(
                Stream.catch((error) =>
                  Stream.fromEffect(
                    Effect.andThen(
                      markEnded(failureText(error)),
                      Effect.fail(unavailable(HOST_NOT_ANSWERING)),
                    ),
                  ),
                ),
                Stream.interruptWhen(gone),
              ),
        ),
    };
    /**
     * A stream from the host that fails, rather than hangs, once the host has gone: a `NotFound`
     * stays itself, anything else ends the host and reads as `HostUnavailable`, as does a stream
     * the host interrupted itself (`stoppedByHost`).
     */
    const hostStream = <A, E>(
      stream: Stream.Stream<A, E>,
    ): Stream.Stream<A, Extract<E, NotFound> | HostUnavailable> =>
      Stream.suspend((): Stream.Stream<A, Extract<E, NotFound> | HostUnavailable> =>
        ended
          ? Stream.fail(unavailable("This machine's host has stopped."))
          : stream.pipe(
              Stream.catch((error): Stream.Stream<never, Extract<E, NotFound> | HostUnavailable> =>
                error instanceof NotFound
                  ? Stream.fail(error as Extract<E, NotFound>)
                  : Stream.fromEffect(
                      Effect.andThen(
                        markEnded(failureText(error)),
                        Effect.fail(unavailable(HOST_NOT_ANSWERING)),
                      ),
                    ),
              ),
              Stream.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Stream.fail(stoppedByHost())
                  : Stream.failCause(cause),
              ),
              Stream.interruptWhen(gone),
            ),
      );
    const fileCall = <A, E extends { readonly _tag: string; readonly message?: string }>(
      call: Effect.Effect<A, E>,
    ) =>
      guarded(call).pipe(
        Effect.catch((error) => Effect.flatMap(keepFileErrors(error), Effect.fail)),
      );
    const terminals: HostTerminalsConnection = {
      open: (request, settings) =>
        fileCall(
          client["host.terminals.open"](
            defined({
              threadId: request.threadId,
              cwd: request.cwd,
              cols: request.cols,
              rows: request.rows,
              shell: request.shell,
              command: request.command,
              script: request.script,
              settingsShell: settings?.settingsShell,
              path: settings?.path,
            }),
          ),
        ),
      input: (terminalId, data) => fileCall(client["host.terminals.input"]({ terminalId, data })),
      resize: (terminalId, cols, rows) =>
        fileCall(client["host.terminals.resize"]({ terminalId, cols, rows })),
      // A host that went took its shells with it, so there is nothing left to close.
      close: (terminalId) =>
        guarded(client["host.terminals.close"]({ terminalId })).pipe(
          Effect.catch((error) => (error instanceof NotFound ? Effect.fail(error) : Effect.void)),
        ),
      list: (threadId) =>
        guarded(client["host.terminals.list"](defined({ threadId }))).pipe(
          Effect.orElseSucceed(() => []),
        ),
      subscribe: (terminalId) =>
        hostStream(client["host.terminals.subscribe"]({ terminalId })).pipe(
          // A shell whose host went has ended too.
          Stream.catch((error): Stream.Stream<TerminalEvent, NotFound> =>
            error instanceof NotFound ? Stream.fail(error) : Stream.make({ type: "exit" }),
          ),
        ),
      snapshot: (threadId) =>
        guarded(client["host.terminals.snapshot"]({ threadId })).pipe(
          Effect.orElseSucceed(() => []),
        ),
      roots: hostStream(client["host.terminals.roots"]()),
    };
    /**
     * A session call: the agent's own errors pass as they are, and anything else (the host failing
     * or not answering) reads as `HostFailed`, its detail logged.
     */
    const sessionCall = <A, E extends { readonly _tag: string; readonly message?: string }, K>(
      call: Effect.Effect<A, E>,
      keep: (error: unknown) => error is K,
    ): Effect.Effect<A, K | HostFailed> =>
      guarded(call).pipe(
        Effect.catch((error) =>
          keep(error)
            ? Effect.fail(error)
            : error instanceof HostFailed
              ? Effect.fail(error)
              : Effect.logWarning("worker host: a session call failed on the stream").pipe(
                  Effect.annotateLogs({ reason: failureText(error) }),
                  Effect.andThen(Effect.fail(new HostFailed({ message: HOST_NOT_ANSWERING }))),
                ),
        ),
      );
    const sessions: HostSessionsConnection = {
      open: (request) => sessionCall(client["host.sessions.open"](request), isAgentUnavailable),
      events: (handle, afterSeq) =>
        hostStream(client["host.sessions.events"]({ handle, afterSeq })),
      ack: (handle, seq) =>
        guarded(client["host.sessions.ack"]({ handle, seq })).pipe(Effect.ignore),
      connectorsSeen: (handle) =>
        hostStream(client["host.sessions.connectorsSeen"]({ handle })).pipe(
          Stream.catch(() => Stream.empty),
        ),
      send: (handle, input, sendOptions) =>
        sessionCall(
          client["host.sessions.send"](
            defined({
              handle,
              input,
              messageId: sendOptions?.messageId,
              deliveryId: sendOptions?.deliveryId,
            }),
          ),
          none,
        ),
      steer: (handle, input, steerOptions) =>
        sessionCall(
          client["host.sessions.steer"](
            defined({ handle, input, deliveryId: steerOptions?.deliveryId }),
          ),
          none,
        ),
      interrupt: (handle) =>
        sessionCall(
          client["host.sessions.interrupt"]({ handle }),
          (error): error is InterruptHung => error instanceof InterruptHung,
        ),
      closeToolGate: (handle) =>
        sessionCall(client["host.sessions.closeToolGate"]({ handle }), none),
      stopBackgroundTasks: (handle) =>
        sessionCall(client["host.sessions.stopBackgroundTasks"]({ handle }), none),
      stopTask: (handle, taskId) =>
        sessionCall(client["host.sessions.stopTask"]({ handle, taskId }), none),
      respond: (handle, requestId, answer) =>
        sessionCall(
          client["host.sessions.respond"]({ handle, requestId, answer }),
          (error): error is AnswerUndelivered => error instanceof AnswerUndelivered,
        ),
      setMode: (handle, mode) =>
        sessionCall(
          client["host.sessions.setMode"]({ handle, mode }),
          (error): error is ModeRefused => error instanceof ModeRefused,
        ),
      setModel: (handle, model) =>
        sessionCall(client["host.sessions.setModel"]({ handle, model }), none),
      addDirectories: (handle, paths) =>
        sessionCall(client["host.sessions.addDirectories"]({ handle, paths }), none),
      processId: (handle) =>
        sessionCall(client["host.sessions.processId"]({ handle }), none).pipe(
          Effect.map((pid) => pid ?? undefined),
        ),
      connectors: {
        status: (handle) =>
          sessionCall(client["host.sessions.connectorsStatus"]({ handle }), isAgentUnavailable),
        reconnect: (handle, name) =>
          sessionCall(
            client["host.sessions.connectorsReconnect"]({ handle, name }),
            isAgentUnavailable,
          ),
        setEnabled: (handle, name, enabled) =>
          sessionCall(
            client["host.sessions.connectorsSetEnabled"]({
              handle,
              name,
              enabled,
            }),
            isAgentUnavailable,
          ),
        authenticate: (handle, name) =>
          sessionCall(
            client["host.sessions.connectorsAuthenticate"]({ handle, name }),
            isAgentUnavailable,
          ),
      },
      // A host that went took its sessions with it, so there is nothing left to close.
      close: (handle) => guarded(client["host.sessions.close"]({ handle })).pipe(Effect.ignore),
      reload: (agent, reload) =>
        guarded(client["host.sessions.reload"]({ agent, reload })).pipe(Effect.ignore),
    };
    /**
     * A token call: the host's own refusal passes as it is; anything else (an older host's
     * unknown-request defect, a broken stream, no answer in time) reads as `HOST_TOKEN_UNANSWERED`.
     * Only the error's tag is logged, never its text, which could quote the request.
     */
    const tokenCall = <A, E extends { readonly _tag: string }>(
      call: Effect.Effect<A, E>,
    ): Effect.Effect<A, HostFailed> =>
      guarded(call).pipe(
        Effect.timeoutOrElse({
          duration: TOKEN_CALL_TIMEOUT,
          orElse: () => Effect.fail(new HostFailed({ message: HOST_TOKEN_UNANSWERED })),
        }),
        Effect.catchCause((cause) => {
          const failure = cause.reasons.find(Cause.isFailReason)?.error;
          if (failure instanceof HostFailed)
            return Effect.fail(new HostFailed({ message: publicTokenRefusal(failure.message) }));
          if (cause.reasons.some(Cause.isInterruptReason) && failure === undefined)
            return Effect.failCause(cause as Cause.Cause<never>);
          return Effect.logWarning("worker host: a token call wasn't answered").pipe(
            Effect.annotateLogs({
              hostId: options.hostId,
              kind:
                failure === undefined
                  ? "defect"
                  : ((failure as { readonly _tag?: string })._tag ?? "failure"),
            }),
            Effect.andThen(Effect.fail(new HostFailed({ message: HOST_TOKEN_UNANSWERED }))),
          );
        }),
      );
    const claude: HostClaudeToken = {
      setToken: (token) => tokenCall(client["host.claude.setToken"]({ token })),
      forgetToken: tokenCall(client["host.claude.forgetToken"]()),
    };
    const checks: HostChecksConnection = {
      run: (request) =>
        guarded(client["host.checks.run"](defined({ ...request }))).pipe(
          Effect.catch((error) =>
            error instanceof HostFailed || error instanceof HostUnavailable
              ? Effect.fail(error)
              : Effect.logWarning("worker host: a check call failed on the stream").pipe(
                  Effect.annotateLogs({ reason: failureText(error) }),
                  Effect.andThen(Effect.fail(unavailable(HOST_NOT_ANSWERING))),
                ),
          ),
        ),
    };
    /**
     * A stop call: the host's own refusal and a host that went are kept as they are, and a broken
     * stream ends the host. Anything else is a host built before the call, whose unknown-request
     * defect is a failed call, not a broken stream.
     */
    const stopCall = <A, E extends { readonly _tag: string }>(call: Effect.Effect<A, E>) =>
      guarded(call).pipe(
        Effect.catchCause((cause): Effect.Effect<never, HostFailed | HostUnavailable> => {
          const error = Cause.squash(cause);
          if (error instanceof HostFailed || error instanceof HostUnavailable)
            return Effect.fail(error);
          return ended
            ? Effect.fail(unavailable(HOST_NOT_ANSWERING))
            : Effect.fail(new HostFailed({ message: HOST_STOP_UNANSWERED }));
        }),
      );
    return {
      hello,
      files,
      claude,
      folders: hello.capabilities.includes("folders") ? folders : undefined,
      reads: hello.capabilities.includes("file-reads") ? reads : undefined,
      attachments: hello.capabilities.includes("attachments") ? attachments : undefined,
      ...(hello.capabilities.includes("checks") ? { checks } : {}),
      repos: {
        ensure: (url) => worktreeCall(client["host.repos.ensure"]({ url })),
        ...(hello.capabilities.includes("repo-identity")
          ? {
              identify: (repoRoot: string, path: string) =>
                guarded(client["host.repos.identify"]({ repoRoot, path })).pipe(
                  Effect.mapError((error) =>
                    error instanceof HostFailed || error instanceof HostUnavailable
                      ? error
                      : unavailable(HOST_NOT_ANSWERING),
                  ),
                ),
            }
          : {}),
      },
      worktrees,
      git,
      terminals,
      sessions,
      scan: guarded(client["host.ports.scan"]()).pipe(Effect.map(scanFromWire)),
      // An older host's unknown-request defect is a failed call, not a broken stream.
      status: guarded(client["host.status"]()).pipe(
        Effect.timeoutOrElse({
          duration: STATUS_TIMEOUT,
          orElse: () => Effect.succeed(UNKNOWN_STATUS),
        }),
        Effect.catchCause(() => Effect.succeed(UNKNOWN_STATUS)),
      ),
      stop: {
        prepare: (request) =>
          stopCall(
            client["host.stop.prepare"](
              defined({
                checkouts: request.checkouts,
                force: request.force,
                remote: request.remote,
              }),
            ).pipe(
              Effect.timeoutOrElse({
                duration: STOP_TIMEOUT,
                orElse: () => Effect.fail(unavailable(HOST_NOT_ANSWERING)),
              }),
            ),
          ),
        cancel: stopCall(client["host.stop.cancel"]()),
      },
      ...(hello.capabilities.includes("update")
        ? {
            update: {
              check: guarded(client["host.update.check"]()).pipe(
                Effect.timeoutOrElse({
                  duration: STATUS_TIMEOUT,
                  orElse: () => Effect.fail(unavailable("The host didn't answer in time.")),
                }),
                Effect.mapError((error) =>
                  error._tag === "HostUnavailable"
                    ? error
                    : unavailable(`The host didn't answer: ${failureText(error)}`),
                ),
              ),
              // A refusal is the host's answer, not a broken stream: only the stream ending says so.
              start: (release: string) =>
                Stream.suspend(() =>
                  ended
                    ? Stream.fail(unavailable("This machine's host has stopped."))
                    : client["host.update.start"]({ release }).pipe(
                        Stream.catch(
                          (error): Stream.Stream<never, HostUpdateRefused | HostUnavailable> =>
                            error instanceof HostUpdateRefused
                              ? Stream.fail(error)
                              : Stream.fromEffect(
                                  Effect.andThen(
                                    error._tag === "RpcClientError"
                                      ? markEnded(failureText(error))
                                      : Effect.void,
                                    Effect.fail(unavailable(HOST_NOT_ANSWERING)),
                                  ),
                                ),
                        ),
                        Stream.interruptWhen(gone),
                      ),
                ),
            },
          }
        : {}),
      gone: () => ended,
    };
  });
