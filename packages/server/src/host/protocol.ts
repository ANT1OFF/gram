// The host protocol over one byte stream: the control plane's client on one end, a worker host's
// server on the other. Today the stream is a pipe to a child process on this machine; a paired
// machine's will be a connection over the tailnet, with the same messages.

import {
  HOST_PROTOCOL_VERSION,
  type HostCapability,
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
} from "@gram/contracts";
import {
  type ProcError,
  ProcSpawnError,
  ProcTimeout,
  WorktreeError,
  type Worktrees,
} from "@gram/git";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
import type { HostFiles } from "./files.ts";
import type { HostGit } from "./git.ts";
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

/** What a host serves: its folders, worktrees, git state and port scan, and who it says it is. */
export interface HostService {
  readonly hello: HostHello;
  readonly files: HostFiles;
  readonly worktrees: HostWorktrees;
  readonly git: HostGit;
  readonly terminals: HostTerminalsService;
  readonly scan: Effect.Effect<PortScan, unknown>;
}

/** The capabilities this build's host serves. */
export const HOST_CAPABILITIES: ReadonlyArray<HostCapability> = [
  "files",
  "ports",
  "worktrees",
  "git",
  "terminals",
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

/** `A` with each key that may be `undefined` made optional instead. */
type Defined<A> = {
  [K in keyof A as undefined extends A[K] ? never : K]: A[K];
} & {
  [K in keyof A as undefined extends A[K] ? K : never]?: Exclude<A[K], undefined>;
};

/** Drops keys whose value is `undefined`, for a payload whose optional keys must be absent. */
const defined = <A extends object>(value: A): Defined<A> =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Defined<A>;

/** The protocol's handlers over a host's own folders, worktrees, git state and scan. */
const handlersFor = (host: HostService) =>
  HostRpcs.toLayer(
    HostRpcs.of({
      "host.hello": () => Effect.succeed(host.hello),
      "host.files.list": ({ path, showHidden, limit }) =>
        host.files.list(path, { showHidden, limit }),
      "host.files.search": ({ root, query, regex, caseSensitive, offset, limit }) =>
        host.files.search(root, query, { regex, caseSensitive, offset, limit }),
      "host.files.names": ({ root }) => host.files.names(root),
      "host.ports.scan": () =>
        host.scan.pipe(
          Effect.map(scanToWire),
          Effect.mapError((error) => new HostFailed({ message: failureText(error) })),
        ),
      "host.worktrees.list": ({ repoPath, openCheckouts }) =>
        host.worktrees.list(repoPath, { openCheckouts }).pipe(Effect.mapError(worktreeToWire)),
      "host.worktrees.baseBranches": ({ repoPath }) =>
        host.worktrees.baseBranches(repoPath).pipe(Effect.mapError(worktreeToWire)),
      "host.worktrees.create": (request) =>
        host.worktrees.create(request).pipe(Effect.mapError(worktreeToWire)),
      "host.worktrees.remove": (request) =>
        host.worktrees.remove(request).pipe(Effect.mapError(worktreeToWire)),
      "host.worktrees.restore": (request) =>
        host.worktrees.restore(request).pipe(Effect.mapError(worktreeToWire)),
      "host.worktrees.pendingPermissions": ({ repoPath, worktreeDir }) =>
        host.worktrees
          .pendingPermissions(repoPath, worktreeDir)
          .pipe(Effect.mapError(worktreeToWire)),
      "host.git.local": ({ cwd }) => host.git.local(cwd).pipe(Effect.mapError(commandToWire)),
      "host.git.present": ({ cwd }) => host.git.present(cwd),
      "host.git.watch": ({ paths, ...options }) => host.git.watch(paths, options),
      "host.terminals.open": ({ settingsShell, path, ...request }) =>
        host.terminals.terminals.open(request, { settingsShell, path }).pipe(
          // Every open names its folder, so no thread is looked up here.
          Effect.catchTag("ThreadNotFound", (error) =>
            Effect.fail(new InvalidState({ message: `No thread ${error.threadId}` })),
          ),
        ),
      "host.terminals.input": ({ terminalId, data }) =>
        host.terminals.terminals.input(terminalId, data),
      "host.terminals.resize": ({ terminalId, cols, rows }) =>
        host.terminals.terminals.resize(terminalId, cols, rows),
      "host.terminals.close": ({ terminalId }) => host.terminals.terminals.close(terminalId),
      "host.terminals.list": ({ threadId }) => host.terminals.terminals.list(threadId),
      "host.terminals.subscribe": ({ terminalId }) =>
        host.terminals.terminals.subscribe(terminalId),
      "host.terminals.snapshot": ({ threadId }) => host.terminals.terminals.snapshot(threadId),
      "host.terminals.roots": () => host.terminals.roots,
    }),
  );

/**
 * Serves `host` on `socket` until the other end closes it. One connection, one control plane: a
 * host never accepts a second caller on the same stream.
 */
export const serveHost = (socket: Socket.Socket, host: HostService): Effect.Effect<void> =>
  Effect.gen(function* () {
    const closed = yield* Deferred.make<void>();
    const oneConnection = Layer.succeed(SocketServer.SocketServer, {
      address: NetAddress.unixPathAddress("host-stream"),
      run: (handler) =>
        handler(socket).pipe(
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
    yield* Deferred.await(closed);
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
  readonly open: (
    request: OpenTerminal & { readonly cwd: string },
    settings: OpenSettings,
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

/** A connected host, as the control plane reaches it. */
export interface HostConnection {
  readonly hello: HostHello;
  readonly files: HostFiles;
  readonly worktrees: HostWorktrees;
  readonly git: HostGitConnection;
  readonly terminals: HostTerminalsConnection;
  readonly scan: Effect.Effect<PortScan, unknown>;
  /** Whether the host has gone: its process ended or its stream closed. Calls fail at once then. */
  readonly gone: () => boolean;
}

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
}

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
    if (hello.hostId !== options.hostId) {
      return yield* unavailable(`A host answered as "${hello.hostId}", not "${options.hostId}".`);
    }
    if (hello.protocol !== HOST_PROTOCOL_VERSION) {
      return yield* unavailable(
        `The host speaks protocol ${hello.protocol}; this build speaks ${HOST_PROTOCOL_VERSION}.`,
      );
    }
    const missing = HOST_CAPABILITIES.filter((need) => !hello.capabilities.includes(need));
    if (missing.length > 0) {
      return yield* unavailable(`The host doesn't serve ${missing.join(", ")}.`);
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
     * stays itself, anything else ends the host and reads as `HostUnavailable`.
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
              settingsShell: settings.settingsShell,
              path: settings.path,
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
    return {
      hello,
      files,
      worktrees,
      git,
      terminals,
      scan: guarded(client["host.ports.scan"]()).pipe(Effect.map(scanFromWire)),
      gone: () => ended,
    };
  });
