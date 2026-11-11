// The paths an embedding platform's own services call the server on, under `/embed/v1/`: a pushed
// repository event, a timer firing, the settings it supplies. They exist only while the hosted
// features setting is on and `GRAM_EMBED_TOKEN` is set; otherwise a request to one is answered as
// a request to any path the server doesn't have.
//
// The caller is a service, never a browser: it proves itself with the bearer token alone, which no
// cookie or page can stand in for, and a request carrying an `Origin` is refused whatever its
// token. The auth middleware hands these paths over before its loopback checks
// (`http/server.ts`), since a service reaches the server by its address inside the deployment.

import * as ByteSize from "effect/ByteSize";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { bearerToken, tokensEqual } from "../http/auth.ts";
import { HttpServerRequest, HttpServerResponse } from "../platform/unstable.ts";
import { Embedding } from "./embedding.ts";

/** Every inbound path starts with this. */
export const EMBED_PREFIX = "/embed/v1/";

/** The largest body an inbound call may carry. */
const BODY_MAX = 256 * 1024;

export type EmbedMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface EmbedAnswer {
  readonly status: number;
  readonly body: unknown;
}

/** Answers one call: `body` is its JSON object, `undefined` for a call with none. */
export type EmbedHandler = (
  body: Readonly<Record<string, unknown>> | undefined,
) => Effect.Effect<EmbedAnswer>;

export const answer = (body: unknown, status = 200): EmbedAnswer => ({ status, body });
export const refusal = (status: number, error: string): EmbedAnswer => ({
  status,
  body: { error },
});

export interface EmbedInboundShape {
  /** Serves `name` (the path after `/embed/v1/`) for `method`. Called once per route, at start. */
  readonly route: (method: EmbedMethod, name: string, handler: EmbedHandler) => Effect.Effect<void>;
  /**
   * The answer to `request`, whose path is `path`; `undefined` when the inbound paths don't exist
   * just now, so the caller answers it as it would any other request.
   */
  readonly respond: (
    request: HttpServerRequest.HttpServerRequest,
    path: string,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse | undefined>;
}

const json = ({ status, body }: EmbedAnswer) => HttpServerResponse.jsonUnsafe(body, { status });

const readBody = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    if (Number(request.headers["content-length"] ?? 0) > BODY_MAX) return "too-large" as const;
    const text = yield* request.text.pipe(
      Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.bytes(BODY_MAX)),
      Effect.catch(() => Effect.succeed(undefined)),
    );
    if (text === undefined) return "too-large" as const;
    if (text.trim() === "") return undefined;
    try {
      const value: unknown = JSON.parse(text);
      return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : ("malformed" as const);
    } catch {
      return "malformed" as const;
    }
  });

export class EmbedInbound extends Context.Service<EmbedInbound, EmbedInboundShape>()(
  "@gram/server/EmbedInbound",
) {
  static readonly layer = Layer.effect(
    EmbedInbound,
    Effect.gen(function* () {
      const embedding = yield* Embedding;
      const routes = new Map<string, Map<EmbedMethod, EmbedHandler>>();
      const expected = embedding.config.inboundToken;

      const respond: EmbedInboundShape["respond"] = (request, path) =>
        Effect.gen(function* () {
          if (expected === undefined || !path.startsWith(EMBED_PREFIX)) return undefined;
          if (!(yield* embedding.on)) return undefined;
          // No browser request that could carry a body from another site lacks an `Origin`.
          if (request.headers["origin"] !== undefined) {
            return json(refusal(403, "forbidden: not a service request"));
          }
          const token = bearerToken(request.headers);
          if (token === undefined || !tokensEqual(token, expected)) {
            return json(refusal(401, "unauthorized: bearer token required"));
          }
          const methods = routes.get(path.slice(EMBED_PREFIX.length));
          if (methods === undefined) return json(refusal(404, "no such path"));
          const handler = methods.get(request.method as EmbedMethod);
          if (handler === undefined) return json(refusal(405, "method not allowed"));
          const body = yield* readBody(request);
          if (body === "too-large") return json(refusal(413, "body too large"));
          if (body === "malformed") return json(refusal(400, "body must be a JSON object"));
          return json(
            yield* handler(body).pipe(
              // A handler's defect is this call's failure, never the server's.
              Effect.catchCause((cause) =>
                Effect.logWarning("embed call failed").pipe(
                  Effect.annotateLogs({ path, cause: String(cause) }),
                  Effect.as(refusal(500, "the call failed")),
                ),
              ),
            ),
          );
        });

      return EmbedInbound.of({
        route: (method, name, handler) =>
          Effect.sync(() => {
            const methods = routes.get(name) ?? new Map<EmbedMethod, EmbedHandler>();
            methods.set(method, handler);
            routes.set(name, methods);
          }),
        respond,
      });
    }),
  );
}
