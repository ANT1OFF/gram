// The web app's own files, the one thing a browser of this computer gets from Gram's port without
// the key only Gram's own origin holds (`auth.ts`): the shell it loads before it can show anything.

import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Readable } from "node:stream";
import { ServerConfig } from "../config.ts";
import {
  HttpPlatform,
  HttpRouter,
  type HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
  HttpStaticServer,
} from "../platform/unstable.ts";
import { compressedStatic } from "./compressed-static.ts";

/**
 * Gives a file response's stream an `'error'` listener as soon as it exists. Effect's Node
 * `fileResponse` opens a `ReadStream` that the response's `pipeline` only listens to once it is
 * written, so an `open` failing in between had no listener and Node killed the server: on a
 * machine out of descriptors (EMFILE) it died serving a page's script, and the page never loaded. With a
 * listener the error stays on the stream, and `pipeline` fails that one response with it.
 */
export const guardFileBody = (
  response: HttpServerResponse.HttpServerResponse,
): HttpServerResponse.HttpServerResponse => {
  const body = response.body;
  if (body._tag === "Raw" && body.body instanceof Readable) {
    body.body.on("error", () => {
      // Reported by the response's pipeline, which reads the error the stream keeps.
    });
  }
  return response;
};

/**
 * Node's `HttpPlatform` with {@link guardFileBody} on every file response. It runs in the step that
 * made the stream, and the `open` it guards can only fail once the event loop turns.
 */
export const GuardedHttpPlatform = Layer.effect(HttpPlatform.HttpPlatform)(
  Effect.gen(function* () {
    const platform = yield* HttpPlatform.HttpPlatform;
    return HttpPlatform.HttpPlatform.of({
      ...platform,
      fileResponse: (path, options) =>
        Effect.map(platform.fileResponse(path, options), guardFileBody),
    });
  }),
).pipe(Layer.provide(NodeHttpPlatform.layer));

/** The web app's files, the single-page app's index for any other path. */
export class AppShell extends Context.Service<
  AppShell,
  {
    readonly serve: Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      never,
      HttpServerRequest.HttpServerRequest
    >;
  }
>()("@gram/server/AppShell") {
  static readonly layer = Layer.effect(
    AppShell,
    Effect.gen(function* () {
      const { webRoot } = yield* ServerConfig;
      if (webRoot === undefined) {
        return {
          serve: Effect.succeed(
            HttpServerResponse.text("Gram server: no web root configured", { status: 404 }),
          ),
        };
      }
      const files = yield* HttpStaticServer.make({ root: webRoot, index: "index.html", spa: true });
      return {
        serve: compressedStatic(webRoot)(files).pipe(
          Effect.catch(HttpServerRespondable.toResponse),
        ),
      };
    }).pipe(Effect.provide(GuardedHttpPlatform)),
  );
}

/** Every other `GET` the routes leave: the web app's files. */
export const StaticRoutes = Layer.effectDiscard(
  Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter;
    const { serve } = yield* AppShell;
    yield* router.add("GET", "/*", serve);
  }),
);
