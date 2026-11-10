import { readFileSync } from "node:fs";
import type { Server as HttpListener } from "node:http";
import { createServer } from "node:https";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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

/** The provisioned-host listener's bound port, for the log and for tests that bind port 0. */
export class ProvisionedListener extends Context.Service<
  ProvisionedListener,
  { readonly port: number } | undefined
>()("@gram/server/ProvisionedListener") {}

/** TLS 1.3 only: both ends are Gram's own, so there is no older client to keep working. */
const createTlsListener = (config: ProvisionedHostsConfig) => {
  const server = createServer({
    cert: readFileSync(config.certFile),
    key: readFileSync(config.keyFile),
    minVersion: "TLSv1.3",
  });
  // As the main listener: finish a request parsed after the serving scope let go of the server.
  server.on("request", (_request, response) => {
    if (server.listenerCount("request") !== 1) return;
    response.writeHead(503, { connection: "close" });
    response.end();
  });
  return server;
};

/**
 * The server's `HttpServer` with a second, TLS listener for provisioned hosts beside `main`. It
 * serves the same app, marked {@link ViaProvisionedListener}, so the one auth middleware decides
 * what a provisioned host may reach there. `main` keeps the server's address: the app's own
 * loopback port.
 */
export const withProvisionedListener = <E>(
  main: Layer.Layer<HttpServer.HttpServer, E>,
  config: ProvisionedHostsConfig | undefined,
  /** The main listener's options; its address and port give way to the provisioned hosts' own. */
  options: NodeHttpServer.Options,
) =>
  config === undefined
    ? Layer.merge(main, Layer.succeed(ProvisionedListener, undefined))
    : Layer.unwrap(
        Effect.gen(function* () {
          const app = yield* HttpServer.HttpServer;
          const hosts = yield* NodeHttpServer.make(
            // Node's HTTPS server is its HTTP server over TLS sockets.
            () => createTlsListener(config) as unknown as HttpListener,
            { ...options, host: config.listenHost, port: config.port },
          );
          const port = "port" in hosts.address ? hosts.address.port : config.port;
          yield* Effect.logInfo("provisioned hosts: listening").pipe(
            Effect.annotateLogs({
              origin: config.origin,
              host: config.listenHost,
              port,
            }),
          );
          return Layer.merge(
            Layer.succeed(
              HttpServer.HttpServer,
              HttpServer.make({
                address: app.address,
                serve: (httpEffect, middleware) => {
                  const marked = Effect.provideService(httpEffect, ViaProvisionedListener, true);
                  return middleware === undefined
                    ? Effect.andThen(app.serve(httpEffect), hosts.serve(marked))
                    : Effect.andThen(
                        app.serve(httpEffect, middleware),
                        hosts.serve(marked, middleware),
                      );
                },
              }),
            ),
            Layer.succeed(ProvisionedListener, { port }),
          );
        }),
      ).pipe(Layer.provide(main));
