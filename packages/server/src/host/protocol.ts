// The host protocol over one byte stream: the control plane's client on one end, a worker host's
// server on the other. Today the stream is a pipe to a child process on this machine; a paired
// machine's will be a connection over the tailnet, with the same messages.

import {
  HOST_PROTOCOL_VERSION,
  type HostCapability,
  HostFailed,
  type HostHello,
  type HostId,
  type HostPortScan,
  HostRpcs,
  HostUnavailable,
  InvalidState,
  LOCAL_HOST_ID,
  NotFound,
} from "@gram/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
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

/** What a host serves: its folders and its port scan, and who it says it is. */
export interface HostService {
  readonly hello: HostHello;
  readonly files: HostFiles;
  readonly scan: Effect.Effect<PortScan, unknown>;
}

/** The capabilities this build's host serves. */
export const HOST_CAPABILITIES: ReadonlyArray<HostCapability> = ["files", "ports"];

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

/** The protocol's handlers over a host's own folders and scan. */
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

/** A connected host, as the control plane reaches it. */
export interface HostConnection {
  readonly hello: HostHello;
  readonly files: HostFiles;
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
    return {
      hello,
      files,
      scan: guarded(client["host.ports.scan"]()).pipe(Effect.map(scanFromWire)),
      gone: () => ended,
    };
  });
