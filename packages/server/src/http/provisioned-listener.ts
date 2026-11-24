import { readFileSync } from "node:fs";
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

const MAX_CONNECTIONS = 1024;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const HEADERS_TIMEOUT_MS = 10_000;
const CONNECTIONS_CHECK_MS = 2_000;
const RETRY_FIRST_MS = 3_000;
const RETRY_MOST_MS = 60_000;

const tlsOptions = (config: ProvisionedHostsConfig) =>
  ({
    cert: readFileSync(config.certFile),
    key: readFileSync(config.keyFile),
    minVersion: "TLSv1.3",
  }) as const;

const createTlsListener = (config: ProvisionedHostsConfig) => {
  const server = createServer({
    ...tlsOptions(config),
    handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
    headersTimeout: HEADERS_TIMEOUT_MS,
    connectionsCheckingInterval: CONNECTIONS_CHECK_MS,
  });
  server.maxConnections = MAX_CONNECTIONS;
  const sockets = new Set<Socket>();
  let ending = false;
  server.on("connection", (socket: Socket) => {
    if (ending) return void socket.destroy();
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  return {
    server,
    end: () => {
      ending = true;
      try {
        server.close();
      } catch (_notListening) {}
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
          createSecureContext(tlsOptions(config));
          type Served = Parameters<Parameters<typeof HttpServer.make>[0]["serve"]>;
          let served: Served | undefined;
          let open:
            | { readonly scope: Scope.Closeable; readonly port: number; readonly end: () => void }
            | undefined;
          let stopped = false;
          let failed: string | undefined;
          let retryIn = RETRY_FIRST_MS;
          let retryAt = 0;
          const one = yield* Semaphore.make(1);
          const close = Effect.suspend(() => {
            const was = open;
            open = undefined;
            if (was === undefined) return Effect.void;
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
                return NodeHttpServer.make(() => listener.server, {
                  ...options,
                  host: config.listenHost,
                  port: config.port,
                });
              }),
              Effect.tap((hosts): Effect.Effect<void, never, Scope.Scope> =>
                middleware === undefined ? hosts.serve(marked) : hosts.serve(marked, middleware),
              ),
              Effect.tap(() => Effect.addFinalizer(() => Effect.sync(() => end?.()))),
              Scope.provide(scope),
              Effect.exit,
            );
            if (Exit.isFailure(started)) {
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
                  served = [httpEffect, middleware];
                  return middleware === undefined
                    ? app.serve(httpEffect)
                    : app.serve(httpEffect, middleware);
                },
              }),
            ),
            Layer.succeed(ProvisionedListener, {
              setOpen: (wanted) =>
                Effect.uninterruptible(one.withPermits(1)(wanted ? start : close)),
              port: () => open?.port,
            }),
          );
        }),
      ).pipe(Layer.provide(main));
