// One call to an outside service an embedding deployment configured (`config.ts`): the scheduler,
// the object store. Its bearer token goes in the header and nowhere else; a redirect is refused,
// so the token never follows one to another host; and a failure names the service and the status,
// never the URL's path or anything the service answered.

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { OutsideService } from "./config.ts";

export class OutsideCallFailed extends Data.TaggedError("OutsideCallFailed")<{
  readonly service: string;
  /** The HTTP status, or `undefined` when no answer came. */
  readonly status: number | undefined;
  readonly message: string;
}> {}

export interface OutsideCall {
  readonly method: "GET" | "PUT" | "POST" | "DELETE";
  /** Appended to the service's URL; each segment already encoded. */
  readonly path: string;
  readonly json?: unknown;
  readonly bytes?: Uint8Array;
  /** A file's bytes, read as they are sent (`openAsBlob`). */
  readonly body?: Blob;
  readonly contentType?: string;
  /** Statuses besides 2xx that are an answer, not a failure: a 404 for a read or a delete. */
  readonly accept?: ReadonlyArray<number>;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** The response of a call that was answered with a 2xx or an accepted status. */
export const callOutside = (
  name: string,
  service: OutsideService,
  call: OutsideCall,
): Effect.Effect<Response, OutsideCallFailed> =>
  Effect.tryPromise({
    try: (signal) =>
      fetch(`${service.url}${call.path}`, {
        method: call.method,
        redirect: "error",
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(call.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        ]),
        headers: {
          ...(service.token === undefined ? {} : { authorization: `Bearer ${service.token}` }),
          ...(call.json !== undefined
            ? { "content-type": "application/json" }
            : call.bytes !== undefined || call.body !== undefined
              ? { "content-type": call.contentType ?? "application/octet-stream" }
              : {}),
        },
        ...(call.json !== undefined
          ? { body: JSON.stringify(call.json) }
          : call.bytes !== undefined
            ? { body: call.bytes }
            : call.body !== undefined
              ? { body: call.body }
              : {}),
      }),
    catch: (error) =>
      new OutsideCallFailed({
        service: name,
        status: undefined,
        // A fetch failure's message can carry the URL; its name (`TimeoutError`, `TypeError`) can't.
        message: `The ${name} didn't answer (${error instanceof Error ? error.name : "error"})`,
      }),
  }).pipe(
    Effect.flatMap((response) =>
      response.ok || (call.accept ?? []).includes(response.status)
        ? Effect.succeed(response)
        : Effect.promise(
            () => response.body?.cancel().catch(() => undefined) ?? Promise.resolve(),
          ).pipe(
            Effect.andThen(
              Effect.fail(
                new OutsideCallFailed({
                  service: name,
                  status: response.status,
                  message: `The ${name} answered ${response.status}`,
                }),
              ),
            ),
          ),
    ),
  );
