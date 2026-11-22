import { readFile } from "node:fs/promises";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { EndpointConfig } from "../config.ts";

/** A call to an embedding endpoint that got no usable answer. Its message never holds the token. */
export class EndpointFailed extends Data.TaggedError("EndpointFailed")<{
  readonly message: string;
}> {}

/** A token file that could not be read or holds no token. Its message never holds the file's text. */
export class TokenFileUnusable extends Error {}

/**
 * The bearer an endpoint is sent: its token, or what its token file holds now. A file is read
 * again for every call, so a token the deployment rotates (a projected workload token) is never
 * sent stale.
 */
export const bearerOf = async (
  endpoint: Pick<EndpointConfig, "token" | "tokenFile">,
): Promise<string | undefined> => {
  if (endpoint.tokenFile === undefined) return endpoint.token;
  let text: string;
  try {
    text = await readFile(endpoint.tokenFile, "utf8");
  } catch {
    throw new TokenFileUnusable("the token file could not be read");
  }
  const token = text.trim();
  if (!/^[\x21-\x7e]+$/.test(token))
    throw new TokenFileUnusable("the token file holds no usable token");
  return token;
};

const MAX_ANSWER_BYTES = 64 * 1024;

/**
 * POSTs `body` as JSON and reads the 200 answer as JSON. Anything else fails: another status, no
 * answer within `timeoutMs`, an answer too long or not JSON. Redirects are not followed, so the
 * token goes only where it was configured to go. A token file is read again for every call.
 */
export const postJson = (
  endpoint: EndpointConfig,
  body: unknown,
  timeoutMs: number,
): Effect.Effect<unknown, EndpointFailed> =>
  Effect.tryPromise({
    try: async (signal) => {
      const token = await bearerOf(endpoint);
      const response = await fetch(endpoint.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      });
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new Error(`status ${response.status}`);
      }
      const chunks: Array<Uint8Array> = [];
      let size = 0;
      for await (const chunk of response.body ?? []) {
        size += chunk.byteLength;
        if (size > MAX_ANSWER_BYTES) throw new Error("the answer was too long");
        chunks.push(chunk);
      }
      try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      } catch {
        throw new Error("the answer was not JSON");
      }
    },
    catch: (error) =>
      new EndpointFailed({
        message:
          error instanceof TypeError
            ? "the request could not be made"
            : error instanceof Error
              ? error.message
              : "no answer",
      }),
  });
