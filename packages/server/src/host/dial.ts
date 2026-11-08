import type { KeyObject } from "node:crypto";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { Socket } from "../platform/unstable.ts";
import { HOST_CONNECT_PATH, signedConnectHeaders } from "./machine-keys.ts";
import { type HostService, serveHost } from "./protocol.ts";
import { watchedSocket } from "./socket-end.ts";

/** The first wait after a dial ends, doubled each time up to the last. */
const RETRY_FIRST_MS = 2_000;
const RETRY_MOST_MS = 30_000;
/** A connection that lasted this long resets the wait. */
const STEADY_MS = 60_000;

export interface DialOptions {
  /** The main Gram's origin, which every dial is signed for. */
  readonly origin: string;
  readonly hostId: string;
  readonly key: KeyObject;
  /** Where to dial; the origin's `wss:` connect address unless a test says otherwise. */
  readonly url?: string;
  readonly now?: () => number;
}

export const connectUrl = (origin: string) =>
  `${origin.replace(/^https:/, "wss:").replace(/^http:/, "ws:")}${HOST_CONNECT_PATH}`;

/**
 * One dial: a WebSocket to the main Gram, signed afresh, serving the host until the socket closes
 * or the dial is refused. The host's terminals and sessions are this connection's and end with it.
 */
export const dialOnce = <R>(
  options: DialOptions,
  service: Effect.Effect<HostService, never, Scope.Scope | R>,
): Effect.Effect<void, never, R> =>
  Effect.gen(function* () {
    const ended = yield* Deferred.make<void>();
    const socket = yield* Socket.makeWebSocket(options.url ?? connectUrl(options.origin), {
      headers: signedConnectHeaders(
        options.key,
        options.origin,
        options.hostId,
        (options.now ?? Date.now)(),
      ),
      openTimeout: "15 seconds",
    });
    const host = yield* service;
    // Served until the socket ends: refused, closed by the main Gram, or broken.
    yield* Effect.raceFirst(
      serveHost(watchedSocket(socket, Deferred.succeed(ended, undefined)), host),
      Deferred.await(ended),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeSocket.layerWebSocketConstructor));

/**
 * Dials the main Gram for good: each time a connection ends or a dial is refused (the machine
 * isn't confirmed yet, the main Gram is closed, the tailnet is down) the host waits and dials
 * again, longer each time up to half a minute.
 */
export const dialForever = <R>(
  options: DialOptions,
  service: Effect.Effect<HostService, never, Scope.Scope | R>,
): Effect.Effect<never, never, R> =>
  Effect.gen(function* () {
    const now = options.now ?? Date.now;
    let wait = RETRY_FIRST_MS;
    while (true) {
      const started = now();
      yield* dialOnce(options, service);
      if (now() - started >= STEADY_MS) wait = RETRY_FIRST_MS;
      yield* Effect.logInfo("gram-host: not connected; dialling again").pipe(
        Effect.annotateLogs({ inSeconds: Math.round(wait / 1000) }),
      );
      yield* Effect.sleep(wait);
      wait = Math.min(wait * 2, RETRY_MOST_MS);
    }
  });
