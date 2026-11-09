import type { KeyObject } from "node:crypto";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
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
 * or the dial is refused. What `service` builds in the dial's scope ends with it; `dialForever`
 * hands it one it keeps across dials.
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
 * How long the host keeps its sessions and terminals with no connection to the main Gram: a blip
 * or a redial picks them up where they were; past it they end, as the main Gram has given them up
 * (it waits `REATTACH_WITHIN_MS`, less than this).
 */
export const DETACHED_GRACE_MS = 3 * 60_000;
/** A dial that lasted this long was served, so the host is attached again. */
const ATTACHED_MS = 5_000;

/**
 * Dials the main Gram for good: each time a connection ends or a dial is refused (the machine
 * isn't confirmed yet, the main Gram is closed, the tailnet is down) the host waits and dials
 * again, longer each time up to half a minute. What it serves is built once and kept across dials,
 * so a session keeps running through a dropped connection and the next one picks it up; only
 * `DETACHED_GRACE_MS` without a connection ends it.
 */
export const dialForever = <R>(
  options: DialOptions,
  service: Effect.Effect<HostService, never, Scope.Scope | R>,
  timing: {
    readonly detachedMs?: number;
    readonly attachedMs?: number;
    readonly retryFirstMs?: number;
  } = {},
): Effect.Effect<never, never, R> =>
  Effect.gen(function* () {
    const now = options.now ?? Date.now;
    const detachedMs = timing.detachedMs ?? DETACHED_GRACE_MS;
    const attachedMs = timing.attachedMs ?? ATTACHED_MS;
    const retryFirstMs = timing.retryFirstMs ?? RETRY_FIRST_MS;
    let kept: { readonly host: HostService; readonly scope: Scope.Closeable } | undefined;
    /** The service the next dial serves: the kept one, or a new one when none is. */
    const keptService = Effect.gen(function* () {
      if (kept !== undefined) return kept.host;
      const scope = yield* Scope.make();
      const host = yield* service.pipe(Scope.provide(scope));
      kept = { host, scope };
      return host;
    });
    let reaper: Fiber.Fiber<void> | undefined;
    /** Ends what the host kept once it has been without a connection for the grace. */
    const release = Effect.suspend(() => {
      const ending = kept;
      kept = undefined;
      reaper = undefined;
      return ending === undefined
        ? Effect.void
        : Effect.logWarning("gram-host: no connection for too long; its sessions end").pipe(
            Effect.andThen(Scope.close(ending.scope, Exit.void)),
          );
    });
    yield* Effect.addFinalizer(() => release);
    const stopReaper = Effect.suspend(() => {
      const running = reaper;
      reaper = undefined;
      return running === undefined ? Effect.void : Fiber.interrupt(running);
    });
    let wait = retryFirstMs;
    while (true) {
      const started = now();
      // Attached once the dial has lasted, so only a dial that was served stops the reaper.
      const attached = yield* Effect.forkScoped(
        Effect.sleep(attachedMs).pipe(Effect.andThen(stopReaper)),
      );
      yield* dialOnce(options, keptService);
      yield* Fiber.interrupt(attached);
      if (reaper === undefined && kept !== undefined) {
        reaper = yield* Effect.forkScoped(Effect.sleep(detachedMs).pipe(Effect.andThen(release)));
      }
      if (now() - started >= STEADY_MS) wait = retryFirstMs;
      yield* Effect.logInfo("gram-host: not connected; dialling again").pipe(
        Effect.annotateLogs({ inSeconds: Math.round(wait / 1000) }),
      );
      yield* Effect.sleep(wait);
      wait = Math.min(wait * 2, RETRY_MOST_MS);
    }
  }).pipe(Effect.scoped);
