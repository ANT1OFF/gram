import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { EndpointConfig } from "../config.ts";

/** A call to an embedding endpoint that got no usable answer. Its message never holds the token. */
export class EndpointFailed extends Data.TaggedError("EndpointFailed")<{
  readonly message: string;
}> {}

/** The largest answer read from an endpoint: both answers are a few fields. */
const MAX_ANSWER_BYTES = 64 * 1024;

/**
 * POSTs `body` as JSON and reads the 200 answer as JSON. Anything else fails: another status, no
 * answer within `timeoutMs`, an answer too long or not JSON. Redirects are not followed, so the
 * token goes only where it was configured to go.
 */
export const postJson = (
  endpoint: EndpointConfig,
  body: unknown,
  timeoutMs: number,
): Effect.Effect<unknown, EndpointFailed> =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(endpoint.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(endpoint.token === undefined ? {} : { authorization: `Bearer ${endpoint.token}` }),
        },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      });
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new Error(`status ${response.status}`);
      }
      // Read with the bound, not after it: an answer that never ends is dropped at the cap.
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
        // The parser's own message can quote the answer.
        throw new Error("the answer was not JSON");
      }
    },
    catch: (error) =>
      new EndpointFailed({
        // A TypeError is `fetch`'s own: its message can quote a header it wouldn't send.
        message:
          error instanceof TypeError
            ? "the request could not be made"
            : error instanceof Error
              ? error.message
              : "no answer",
      }),
  });
