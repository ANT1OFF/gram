// `gram-host local`: this machine's own host as a login service that outlives the app, when the
// user turns on "Keep agents running after Gram quits". The app starts it through the service
// manager (a systemd user unit, a launchd agent) and connects to it over a Unix socket in Gram's
// data folder, which only this user can reach. It serves one app at a time, keeps its sessions and
// terminals across connections, and ends on its own once no app is connected and nothing of a
// thread runs there, so it never lingers. It listens on nothing else.

import { chmodSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket as NetSocket } from "node:net";
import { dirname } from "node:path";
import { userInfo } from "node:os";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schedule from "effect/Schedule";
import * as FiberSet from "effect/FiberSet";
import type * as Scope from "effect/Scope";
import { DAY_MS } from "../zone-time.ts";
import { type HostService, serveHost } from "./protocol.ts";
import type { HostBusy } from "@gram/contracts";

/** How long the service waits, with no app connected and nothing running, before it ends. */
export const LOCAL_SERVICE_IDLE_EXIT_MS = 10 * 60_000;
/**
 * How long it waits at most for an app to see what its sessions did while none was open. Past it,
 * with nothing running, it ends anyway: what those sessions said is in their agents' own session
 * files, which Gram resumes from, but not in Gram's transcript.
 */
export const LOCAL_SERVICE_ABANDON_MS = 3 * DAY_MS;
/** How often it looks. */
const IDLE_CHECK_MS = 30_000;

/** Whether anything of a thread runs in the host now, by its own count (`HostBusy`). */
export const runningNow = (busy: {
  readonly turns: number;
  readonly terminals: number;
  readonly clones: number;
  readonly checks: number;
}): boolean => busy.turns + busy.terminals + busy.clones + busy.checks > 0;

/**
 * The folder the socket lives in, made this user's alone. One that exists already must be a real
 * folder this user owns, which nobody else can write: a socket in a folder another user controls
 * could be swapped for theirs.
 */
export const privateSocketFolder = (socketPath: string): void => {
  const folder = dirname(socketPath);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const info = lstatSync(folder);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error(`${folder} isn't a plain folder.`);
  if (process.platform !== "win32" && info.uid !== userInfo().uid)
    throw new Error(`${folder} belongs to another user.`);
  chmodSync(folder, 0o700);
};

/** Whether a host already answers on `socketPath`. */
const answering = (socketPath: string): Promise<boolean> =>
  new Promise((resolve) => {
    const probe = createConnection(socketPath);
    const done = (yes: boolean) => {
      probe.destroy();
      resolve(yes);
    };
    probe.once("connect", () => done(true));
    probe.once("error", () => done(false));
  });

export interface LocalServiceOptions {
  /** What runs there now, for the idle exit. */
  readonly busy: Effect.Effect<HostBusy>;
  /** Told when an app connects or goes, so sessions wait out a closed app (`sessionsOnHost`). */
  readonly connected?: (yes: boolean) => void;
  readonly idleExitMs?: number;
  readonly abandonMs?: number;
  readonly idleCheckMs?: number;
}

/**
 * Serves `service`, built once and kept, to one app at a time on `socketPath`, until it has been
 * idle with no app for `idleExitMs`. A newer connection takes over from an older one: the app that
 * connected last is the one running. A second host for the same socket refuses to start.
 */
export const serveLocal = <R>(
  socketPath: string,
  service: Effect.Effect<HostService, never, Scope.Scope | R>,
  options: LocalServiceOptions,
): Effect.Effect<void, Error, R | Scope.Scope> =>
  Effect.gen(function* () {
    privateSocketFolder(socketPath);
    if (yield* Effect.promise(() => answering(socketPath)))
      return yield* Effect.fail(
        new Error(`Another host already serves ${socketPath}; this one stops.`),
      );
    // Nothing answers on it: a socket file left by a host that ended without removing it.
    rmSync(socketPath, { force: true });

    const host = yield* service;
    const idleExitMs = options.idleExitMs ?? LOCAL_SERVICE_IDLE_EXIT_MS;
    const done = yield* Deferred.make<void>();
    /** The connection served now, and the fiber serving it. */
    let current: { readonly socket: NetSocket; readonly fiber: Fiber.Fiber<void> } | undefined;
    /** Since when no app has been connected; `undefined` while one is. */
    let aloneSince: number | undefined = Date.now();
    const scope = yield* Effect.scope;

    const serve = (socket: NetSocket) =>
      Effect.gen(function* () {
        const previous = current;
        if (previous !== undefined) {
          yield* Effect.logInfo("gram-host local: a newer app connected; the older one is let go");
          previous.socket.destroy();
          yield* Fiber.interrupt(previous.fiber);
        }
        aloneSince = undefined;
        options.connected?.(true);
        const fiber = yield* NodeSocket.fromDuplex(Effect.succeed(socket)).pipe(
          Effect.flatMap((wrapped) => serveHost(wrapped, host)),
          Effect.scoped,
          Effect.ensuring(
            Effect.sync(() => {
              socket.destroy();
              if (current?.socket !== socket) return;
              current = undefined;
              aloneSince = Date.now();
              options.connected?.(false);
            }),
          ),
          Effect.forkIn(scope),
        );
        current = { socket, fiber };
      });

    const run = yield* FiberSet.makeRuntime();
    yield* Effect.acquireRelease(
      Effect.callback<Server, Error>((resume) => {
        const listening = createServer({ allowHalfOpen: true }, (socket) => {
          run(serve(socket));
        });
        listening.once("error", (error) => resume(Effect.fail(error)));
        // Made with this user's access only: the folder is already theirs alone.
        listening.listen({ path: socketPath, readableAll: false, writableAll: false }, () => {
          try {
            chmodSync(socketPath, 0o600);
          } catch {
            // The folder's own permissions still keep everyone else out.
          }
          resume(Effect.succeed(listening));
        });
      }),
      (listening) =>
        Effect.sync(() => {
          listening.close();
          rmSync(socketPath, { force: true });
        }),
    );
    yield* Effect.logInfo("gram-host local: serving this machine's app").pipe(
      Effect.annotateLogs({ pid: process.pid }),
    );

    const abandonMs = options.abandonMs ?? LOCAL_SERVICE_ABANDON_MS;
    /** Since when no app has been connected and nothing ran: what it waits on is unseen work. */
    let quietSince: number | undefined;
    // Ends once no app has been connected for `idleExitMs` while nothing of a thread ran and no
    // session holds events an app hasn't seen, or for `abandonMs` with only those left.
    yield* Effect.gen(function* () {
      if (aloneSince === undefined) {
        quietSince = undefined;
        return;
      }
      if (runningNow(yield* options.busy)) {
        aloneSince = Date.now();
        quietSince = undefined;
        return;
      }
      quietSince ??= Date.now();
      if (Date.now() - aloneSince < idleExitMs) return;
      if (host.sessions.unconfirmed() > 0 && Date.now() - quietSince < abandonMs) return;
      yield* Effect.logInfo("gram-host local: no app and nothing running; ending");
      yield* Deferred.succeed(done, undefined);
    }).pipe(
      Effect.repeat(Schedule.spaced(Duration.millis(options.idleCheckMs ?? IDLE_CHECK_MS))),
      Effect.forkScoped,
    );

    yield* Deferred.await(done);
    if (current !== undefined) yield* Fiber.interrupt(current.fiber);
  });
