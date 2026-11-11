import { readFileSync } from "node:fs";
import type { Server as HttpListener } from "node:http";
import { createServer } from "node:https";
import type { Socket } from "node:net";
import { createSecureContext } from "node:tls";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type { ProvisionedHostsConfig } from "../host/provisioned.ts";
import { HttpServer } from "../platform/unstable.ts";

/**
 * Whether the request being served came in on the provisioned-host listener. Set by that listener
 * alone, around everything it serves, so it never depends on a header a client could send: the
 * auth middleware answers such a request by the provisioned-host rules and nothing else.
 */
export const ViaProvisionedListener = Context.Reference<boolean>(
  "@gram/server/ViaProvisionedListener",
  { defaultValue: () => false },
);

/**
 * The provisioned-host listener, which is bound only while it is open: closed, as it starts and as
 * it is whenever the hosted features are off, nothing listens on its port at all.
 */
export class ProvisionedListener extends Context.Service<
  ProvisionedListener,
  {
    /**
     * Opens the listener, or closes it and every connection on it. Nothing happens when it is
     * already so, or when none is configured. A listener that can't be bound (its port is taken)
     * stays closed, says why in the log, and is tried again when asked for, after a wait that
     * grows up to a minute.
     */
    readonly setOpen: (open: boolean) => Effect.Effect<void>;
    /** The port it is bound to while open. */
    readonly port: () => number | undefined;
  }
>()("@gram/server/ProvisionedListener") {}

/** How many connections the listener holds at once: every host, with room for their sessions. */
const MAX_CONNECTIONS = 1024;
/** How long a connection gets to finish its TLS handshake, and then to send its request. */
const HANDSHAKE_TIMEOUT_MS = 10_000;
const HEADERS_TIMEOUT_MS = 10_000;
/** How often Node looks for connections past `HEADERS_TIMEOUT_MS`; its own default is 30 s. */
const CONNECTIONS_CHECK_MS = 2_000;
/** The wait before a listener that couldn't be bound is tried again, doubled up to the last. */
const RETRY_FIRST_MS = 3_000;
const RETRY_MOST_MS = 60_000;

/** TLS 1.3 only: both ends are Gram's own, so there is no older client to keep working. */
const tlsOptions = (config: ProvisionedHostsConfig) =>
  ({
    cert: readFileSync(config.certFile),
    key: readFileSync(config.keyFile),
    minVersion: "TLSv1.3",
  }) as const;

/** The TLS server, not yet listening, and `end`, which unbinds it and ends every connection. */
const createTlsListener = (config: ProvisionedHostsConfig) => {
  const server = createServer({
    ...tlsOptions(config),
    handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
    headersTimeout: HEADERS_TIMEOUT_MS,
    connectionsCheckingInterval: CONNECTIONS_CHECK_MS,
  });
  // Bounded, so connections held open here can't use up what the app's own listener needs.
  server.maxConnections = MAX_CONNECTIONS;
  const sockets = new Set<Socket>();
  let ending = false;
  // Every connection, from before its handshake, so ending the listener ends them all: Node's
  // own close waits for each, and stops timing out one that never finishes its request.
  server.on("connection", (socket: Socket) => {
    if (ending) return void socket.destroy();
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  // As the main listener: finish a request parsed after the serving scope let go of the server.
  server.on("request", (_request, response) => {
    if (server.listenerCount("request") !== 1) return;
    response.writeHead(503, { connection: "close" });
    response.end();
  });
  return {
    server,
    end: () => {
      ending = true;
      // Also for a server that never listened: its close stops the timers it started.
      try {
        server.close();
      } catch {
        // Not listening.
      }
      for (const socket of sockets) socket.destroy();
    },
  };
};

/**
 * The server's `HttpServer` with a second, TLS listener for provisioned hosts beside `main`. It
 * serves the same app, marked {@link ViaProvisionedListener}, so the one auth middleware decides
 * what a provisioned host may reach there. `main` keeps the server's address: the app's own
 * loopback port. The listener starts closed; see {@link ProvisionedListener}.
 */
export const withProvisionedListener = <E>(
  main: Layer.Layer<HttpServer.HttpServer, E>,
  config: ProvisionedHostsConfig | undefined,
  /** The main listener's options; its address and port give way to the provisioned hosts' own. */
  options: NodeHttpServer.Options,
) =>
  config === undefined
    ? Layer.merge(
        main,
        Layer.succeed(ProvisionedListener, { setOpen: () => Effect.void, port: () => undefined }),
      )
    : Layer.unwrap(
        Effect.gen(function* () {
          const app = yield* HttpServer.HttpServer;
          const root = yield* Effect.scope;
          // A certificate or key that can't be read or used stops the server as it starts, not
          // the first time the listener is opened.
          createSecureContext(tlsOptions(config));
          type Served = Parameters<Parameters<typeof HttpServer.make>[0]["serve"]>;
          let served: Served | undefined;
          let open:
            | { readonly scope: Scope.Closeable; readonly port: number; readonly end: () => void }
            | undefined;
          /** Set as the server stops: nothing is opened after. */
          let stopped = false;
          /** The last reason it couldn't be bound, so the log says each once; and the next try. */
          let failed: string | undefined;
          let retryIn = RETRY_FIRST_MS;
          let retryAt = 0;
          const one = yield* Semaphore.make(1);
          const close = Effect.suspend(() => {
            const was = open;
            open = undefined;
            if (was === undefined) return Effect.void;
            // Unbound and every connection ended at once. The rest of its scope (a handler still
            // running, the server's own close) finishes on its own, never holding the caller.
            was.end();
            return Scope.close(was.scope, Exit.void).pipe(
              Effect.forkIn(root),
              Effect.andThen(Effect.logInfo("provisioned hosts: listener closed")),
            );
          });
          const start = Effect.gen(function* () {
            if (stopped || open !== undefined || served === undefined || Date.now() < retryAt)
              return;
            const [httpEffect, middleware] = served;
            const scope = yield* Scope.fork(root);
            const marked = Effect.provideService(httpEffect, ViaProvisionedListener, true);
            let end: (() => void) | undefined;
            const started = yield* Effect.try(() => createTlsListener(config)).pipe(
              Effect.flatMap((listener) => {
                end = listener.end;
                return NodeHttpServer.make(
                  // Node's HTTPS server is its HTTP server over TLS sockets.
                  () => listener.server as unknown as HttpListener,
                  { ...options, host: config.listenHost, port: config.port },
                );
              }),
              Effect.tap((hosts): Effect.Effect<void, never, Scope.Scope> =>
                middleware === undefined ? hosts.serve(marked) : hosts.serve(marked, middleware),
              ),
              // Added last, so it runs first however the scope closes, the server stopping
              // included: connections end before anything waits for them.
              Effect.tap(() => Effect.addFinalizer(() => Effect.sync(() => end?.()))),
              Scope.provide(scope),
              Effect.exit,
            );
            if (Exit.isFailure(started)) {
              // A server that never bound is closed too: it holds timers until it is.
              end?.();
              yield* Scope.close(scope, Exit.void);
              const reason = String(started.cause);
              if (reason !== failed)
                yield* Effect.logError("provisioned hosts: the listener couldn't be opened").pipe(
                  Effect.annotateLogs({ host: config.listenHost, port: config.port, reason }),
                );
              failed = reason;
              retryAt = Date.now() + retryIn;
              retryIn = Math.min(retryIn * 2, RETRY_MOST_MS);
              return;
            }
            failed = undefined;
            retryIn = RETRY_FIRST_MS;
            retryAt = 0;
            const address = started.value.address;
            const port = "port" in address ? address.port : config.port;
            open = { scope, port, end: end ?? (() => {}) };
            yield* Effect.logInfo("provisioned hosts: listening").pipe(
              Effect.annotateLogs({ origin: config.origin, host: config.listenHost, port }),
            );
          });
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              stopped = true;
              open?.end();
            }),
          );
          return Layer.merge(
            Layer.succeed(
              HttpServer.HttpServer,
              HttpServer.make({
                address: app.address,
                serve: (httpEffect, middleware) => {
                  // Kept for when the listener opens: it serves what the main one serves.
                  served = [httpEffect, middleware];
                  return middleware === undefined
                    ? app.serve(httpEffect)
                    : app.serve(httpEffect, middleware);
                },
              }),
            ),
            Layer.succeed(ProvisionedListener, {
              setOpen: (wanted) => one.withPermits(1)(wanted ? start : close),
              port: () => open?.port,
            }),
          );
        }),
      ).pipe(Layer.provide(main));
