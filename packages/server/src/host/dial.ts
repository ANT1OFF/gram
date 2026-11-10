import type { KeyObject } from "node:crypto";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schedule from "effect/Schedule";
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
/**
 * How long a dial may go with nothing from the main Gram before it counts as gone: the main Gram's
 * RPC client pings every five seconds (`connectHost`), so this is four pings missed. A link that
 * broke without a word (the main Gram's tailnet went down, a sleep, a NAT forgot it) never fails a
 * read, and its socket would wait on it for good, the host never dialling again.
 */
export const READ_IDLE_MS = 20_000;

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
 * One dial: a WebSocket to the main Gram, signed afresh, serving the host until the socket closes,
 * the dial is refused, or the main Gram has said nothing for `idleMs`. What `service` builds in the dial's scope ends with it; `dialForever`
 * hands it one it keeps across dials.
 */
export const dialOnce = <R>(
  options: DialOptions,
  service: Effect.Effect<HostService, never, Scope.Scope | R>,
  /** Runs on each message the main Gram sends: the dial got through and is being served. */
  served: Effect.Effect<void> = Effect.void,
  idleMs: number = READ_IDLE_MS,
): Effect.Effect<void, never, R> =>
  Effect.gen(function* () {
    const now = options.now ?? Date.now;
    const ended = yield* Deferred.make<void>();
    /** Set as the socket ends, before `ended` stops the serving: a stop then closes nothing. */
    let socketEnded = false;
    /** When the main Gram last sent anything, or when the dial started. */
    let heard = now();
    const received = Effect.andThen(
      Effect.sync(() => {
        heard = now();
      }),
      served,
    );
    // Ends a dial the main Gram has gone silent on, so the next one is made.
    yield* Effect.suspend(() =>
      now() - heard < idleMs
        ? Effect.void
        : Effect.logWarning(
            "gram-host: nothing from the main Gram for too long; dialling again",
          ).pipe(
            Effect.annotateLogs({ silentSeconds: Math.round((now() - heard) / 1000) }),
            Effect.andThen(Deferred.succeed(ended, undefined)),
          ),
    ).pipe(
      Effect.repeat(Schedule.spaced(Duration.millis(Math.max(10, Math.floor(idleMs / 4))))),
      Effect.forkScoped,
    );
    const socket = yield* Socket.makeWebSocket(options.url ?? connectUrl(options.origin), {
      headers: signedConnectHeaders(options.key, options.origin, options.hostId, now()),
      openTimeout: "15 seconds",
    });
    const host = yield* service;
    // Served until the socket ends (refused, closed by the main Gram, or broken) or goes silent.
    yield* Effect.raceFirst(
      serveHost(
        watchedSocket(
          socket,
          Effect.andThen(
            Effect.sync(() => {
              socketEnded = true;
            }),
            Deferred.succeed(ended, undefined),
          ),
          received,
        ),
        host,
        () => socketEnded,
      ),
      Deferred.await(ended),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeSocket.layerWebSocketConstructor));

/**
 * How long the host keeps its sessions and terminals with no connection to the main Gram: a blip
 * or a redial picks them up where they were; past it they end, as the main Gram has given them up
 * (it waits `REATTACH_WITHIN_MS`, less than this).
 */
export const DETACHED_GRACE_MS = 3 * 60_000;

/**
 * Dials the main Gram for good: each time a connection ends or a dial is refused (the machine
 * isn't confirmed yet, the main Gram is closed, the tailnet is down) the host waits and dials
 * again, longer each time up to half a minute. What it serves is built once and kept across dials,
 * so a session keeps running through a dropped connection and the next one picks it up; only
 * `DETACHED_GRACE_MS` without a dial getting through ends it, checked between dials so a dial
 * never serves what was ended under it.
 */
export const dialForever = <R>(
  options: DialOptions,
  service: Effect.Effect<HostService, never, Scope.Scope | R>,
  timing: {
    readonly detachedMs?: number;
    readonly retryFirstMs?: number;
    readonly idleMs?: number;
  } = {},
): Effect.Effect<never, never, R> =>
  Effect.gen(function* () {
    const now = options.now ?? Date.now;
    const detachedMs = timing.detachedMs ?? DETACHED_GRACE_MS;
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
    /** Ends what the host kept. */
    const release = Effect.suspend(() => {
      const ending = kept;
      kept = undefined;
      return ending === undefined ? Effect.void : Scope.close(ending.scope, Exit.void);
    });
    yield* Effect.addFinalizer(() => release);
    /** Since when no dial has got through, while what is kept waits for one. */
    let detachedSince: number | undefined;
    // Only a message from the main Gram says a dial got through: a dial left hanging on its
    // connect, or refused, doesn't.
    const served = Effect.sync(() => {
      detachedSince = undefined;
    });
    let wait = retryFirstMs;
    while (true) {
      if (
        kept !== undefined &&
        detachedSince !== undefined &&
        now() - detachedSince >= detachedMs
      ) {
        yield* Effect.logWarning("gram-host: no connection for too long; its sessions end");
        yield* release;
        detachedSince = undefined;
      }
      const started = now();
      yield* dialOnce(options, keptService, served, timing.idleMs);
      detachedSince ??= now();
      if (now() - started >= STEADY_MS) wait = retryFirstMs;
      yield* Effect.logInfo("gram-host: not connected; dialling again").pipe(
        Effect.annotateLogs({ inSeconds: Math.round(wait / 1000) }),
      );
      yield* Effect.sleep(wait);
      wait = Math.min(wait * 2, RETRY_MOST_MS);
    }
  }).pipe(Effect.scoped);
