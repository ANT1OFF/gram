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
  type NotFound,
} from "@gram/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
}

/**
 * A file read the host couldn't answer reads as the Files panel's own refusal, with why: the
 * panel shows the message, and a missing file stays `NotFound`.
 */
const asFileError = <E extends { readonly _tag: string }>(error: E): NotFound | InvalidState => {
  if (error._tag === "NotFound" || error._tag === "InvalidState") {
    return error as unknown as NotFound | InvalidState;
  }
  const message = "message" in error && typeof error.message === "string" ? error.message : "";
  return new InvalidState({ message: `This machine's host couldn't read it: ${message}` });
};

/**
 * Connects to the host at the other end of `socket` and checks its hello: a host on another
 * protocol version, or one that doesn't serve what this build needs, is unavailable.
 */
export const connectHost = (
  socket: Socket.Socket,
  options: { readonly hostId?: HostId } = {},
): Effect.Effect<HostConnection, HostUnavailable, Scope.Scope> =>
  Effect.gen(function* () {
    // Pings every five seconds; a host that stops answering fails the calls in flight.
    const protocol = yield* RpcClient.makeProtocolSocket().pipe(
      Effect.provideService(Socket.Socket, socket),
      Effect.provide(RpcSerialization.layerNdjson),
    );
    const client = yield* RpcClient.make(HostRpcs).pipe(
      Effect.provideService(RpcClient.Protocol, protocol),
    );
    const hello = yield* client["host.hello"]().pipe(
      Effect.mapError(
        (error) =>
          new HostUnavailable({
            hostId: options.hostId ?? LOCAL_HOST_ID,
            message: `The host didn't answer: ${failureText(error)}`,
          }),
      ),
    );
    if (hello.protocol !== HOST_PROTOCOL_VERSION) {
      return yield* new HostUnavailable({
        hostId: hello.hostId,
        message: `The host speaks protocol ${hello.protocol}; this build speaks ${HOST_PROTOCOL_VERSION}.`,
      });
    }
    const missing = HOST_CAPABILITIES.filter((need) => !hello.capabilities.includes(need));
    if (missing.length > 0) {
      return yield* new HostUnavailable({
        hostId: hello.hostId,
        message: `The host doesn't serve ${missing.join(", ")}.`,
      });
    }
    const files: HostFiles = {
      list: (path, { showHidden, limit }) =>
        client["host.files.list"]({ path, showHidden, limit }).pipe(Effect.mapError(asFileError)),
      search: (root, query, opts) =>
        client["host.files.search"]({
          root,
          query,
          regex: opts.regex ?? false,
          caseSensitive: opts.caseSensitive ?? false,
          offset: opts.offset,
          limit: opts.limit,
        }).pipe(Effect.mapError((error) => asFileError(error) as InvalidState)),
      names: (root) =>
        client["host.files.names"]({ root }).pipe(
          Effect.mapError((error) => asFileError(error) as InvalidState),
        ),
    };
    return {
      hello,
      files,
      scan: client["host.ports.scan"]().pipe(Effect.map(scanFromWire)),
    };
  });
