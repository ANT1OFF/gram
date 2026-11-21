import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as WebStream } from "node:stream/web";
import { dpopProof } from "./dpop.ts";
import type { HostedCalls } from "./hosted.ts";

/**
 * A local address for a CLI's model calls, which this machine forwards to a hosted server's
 * `models_endpoint` with the person's sign-in. Off unless something starts it: nothing here runs
 * on its own.
 *
 * It listens on loopback alone, and takes a call only with the key it made when it started, which
 * the CLI is given as its API key. That key never leaves the machine: each call goes on with a
 * token for `models` and a fresh proof of the device key, and with none of the CLI's own
 * credentials. A browser can't use it: a call with an `Origin`, or for another host, is refused.
 */

/** The most a call's body may hold: a long conversation with its images. */
export const HOSTED_MODEL_CALL_MOST_BYTES = 32 * 1024 * 1024;
/** How long the server has to start answering a call. A streamed answer then takes as long as it takes. */
export const HOSTED_MODEL_ANSWER_MS = 10 * 60_000;

const ASKED = [
  "accept",
  "content-type",
  "anthropic-version",
  "anthropic-beta",
  "openai-beta",
  "user-agent",
] as const;
const ANSWERED = [
  "content-type",
  "retry-after",
  "request-id",
  "x-request-id",
  "anthropic-ratelimit-requests-remaining",
  "anthropic-ratelimit-tokens-remaining",
] as const;

export interface HostedModelRouteOptions extends HostedCalls {
  /** Default: an ephemeral port. */
  readonly port?: number;
}

export interface HostedModelRoute {
  /** Where the CLI sends its calls, as its base address: `http://127.0.0.1:<port>`. */
  readonly url: string;
  /** What the CLI sends as its API key. Made fresh each start, and known only on this machine. */
  readonly apiKey: string;
  readonly close: () => Promise<void>;
}

const NONCE = /^[\x21-\x7e]{1,256}$/;

const refuse = (response: ServerResponse, status: number, type: string, message: string) => {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response
    .writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
    .end(JSON.stringify({ type: "error", error: { type, message } }));
};

const presented = (request: IncomingMessage): string | undefined => {
  const key = request.headers["x-api-key"];
  if (typeof key === "string") return key;
  const bearer = /^Bearer (\S+)$/.exec(request.headers.authorization ?? "");
  return bearer?.[1];
};

const same = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

const bodyOf = async (request: IncomingMessage, most: number): Promise<Buffer | undefined> => {
  const parts: Buffer[] = [];
  let length = 0;
  try {
    for await (const part of request) {
      const bytes = part as Buffer;
      length += bytes.length;
      if (length > most) return undefined;
      parts.push(bytes);
    }
  } catch {
    return undefined;
  }
  return Buffer.concat(parts);
};

export const startHostedModelRoute = async (
  options: HostedModelRouteOptions,
): Promise<HostedModelRoute> => {
  const base = options.discovery.models_endpoint;
  if (base === undefined) throw new Error("The server takes no model calls.");
  const apiKey = `gram-local-${randomBytes(32).toString("base64url")}`;
  let host = "";

  const forward = async (request: IncomingMessage, response: ServerResponse) => {
    const method = request.method ?? "GET";
    if (method !== "GET" && method !== "POST")
      return refuse(response, 405, "invalid_request_error", "Only GET and POST are taken.");
    if (request.headers.origin !== undefined || request.headers.host !== host)
      return refuse(
        response,
        403,
        "permission_error",
        "This address takes calls from this machine.",
      );
    const key = presented(request);
    if (key === undefined || !same(key, apiKey))
      return refuse(response, 401, "authentication_error", "That isn't this address's key.");
    const asked = new URL(request.url ?? "/", "http://local.invalid");
    if (!asked.pathname.startsWith("/") || asked.pathname.includes(".."))
      return refuse(response, 404, "not_found_error", "No such address.");
    const url = `${base.replace(/\/+$/, "")}${asked.pathname}${asked.search}`;
    const body =
      method === "POST" ? await bodyOf(request, HOSTED_MODEL_CALL_MOST_BYTES) : undefined;
    if (method === "POST" && body === undefined)
      return refuse(response, 413, "request_too_large", "The call is too large.");

    const held = await options.keeper.token("models");
    if (!held.ok) return refuse(response, 401, "authentication_error", held.why);
    const { token } = held;
    const headers: Record<string, string> = {};
    for (const name of ASKED) {
      const value = request.headers[name];
      if (typeof value === "string") headers[name] = value;
    }

    const stopped = new AbortController();
    response.once("close", () => {
      if (!response.writableFinished) stopped.abort();
    });
    let answer: Response | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        answer = await options.fetch(url, {
          method,
          headers: {
            ...headers,
            authorization: `${token.tokenType} ${token.accessToken}`,
            ...(token.tokenType === "DPoP"
              ? {
                  dpop: dpopProof(options.key, {
                    method,
                    url,
                    accessToken: token.accessToken,
                    now: Date.now(),
                    ...(options.keeper.nonce.value === undefined
                      ? {}
                      : { nonce: options.keeper.nonce.value }),
                  }),
                }
              : {}),
          },
          ...(body === undefined ? {} : { body: new Uint8Array(body) }),
          redirect: "manual",
          signal: AbortSignal.any([stopped.signal, AbortSignal.timeout(HOSTED_MODEL_ANSWER_MS)]),
        });
      } catch {
        return refuse(response, 502, "api_error", "The server didn't answer.");
      }
      const nonce = answer.headers.get("dpop-nonce");
      if (nonce !== null && NONCE.test(nonce)) options.keeper.nonce.value = nonce;
      const again =
        answer.status === 401 &&
        attempt === 0 &&
        nonce !== null &&
        /error="use_dpop_nonce"/.test(answer.headers.get("www-authenticate") ?? "");
      if (!again) break;
      await answer.body?.cancel().catch(() => undefined);
    }
    if (answer === undefined)
      return refuse(response, 502, "api_error", "The server didn't answer.");
    if (answer.status >= 300 && answer.status < 400) {
      await answer.body?.cancel().catch(() => undefined);
      return refuse(response, 502, "api_error", "The server sent the call elsewhere.");
    }
    const back: Record<string, string> = { "cache-control": "no-store" };
    for (const name of ANSWERED) {
      const value = answer.headers.get(name);
      if (value !== null) back[name] = value;
    }
    response.writeHead(answer.status, back);
    if (answer.body === null) {
      response.end();
      return;
    }
    const stream = Readable.fromWeb(answer.body as WebStream);
    stream.on("error", () => response.destroy());
    stream.pipe(response);
  };

  const server = createServer((request, response) => {
    forward(request, response).catch(() =>
      refuse(response, 500, "api_error", "The call couldn't be forwarded."),
    );
  });
  const port = await new Promise<number>((done, failed) => {
    server.once("error", failed);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "object" && address !== null) done(address.port);
      else failed(new Error("No port."));
    });
  });
  host = `127.0.0.1:${port}`;
  return {
    url: `http://${host}`,
    apiKey,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
};
