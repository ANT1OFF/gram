import type { RequestId, ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";

/** The refusal of an answer that names no card, for one that has a key. */
export const KEYLESS_ANSWER =
  "This answer doesn't say which card it was given for. Answer the card as it is shown now.";

/**
 * Why an answer that names no card (`shown`) is refused, if it is: the card it answers has a key,
 * which whoever listed it was given. Unkeyed, a click meant for an earlier card under the id could
 * land on this one. A card with no key (one the server raised) takes a keyless answer. One that
 * names a key other than the card's is refused where it is delivered (`RequestNotFound`).
 */
export const keylessRefusal = (
  store: Pick<ThreadStoreShape, "listRequests">,
  threadId: ThreadId,
  requestId: RequestId,
  shown: string | undefined,
): Effect.Effect<string | undefined> =>
  shown !== undefined
    ? Effect.succeed(undefined)
    : store.listRequests(threadId).pipe(
        Effect.map((requests) =>
          requests.find((request) => request.id === requestId)?.shown === undefined
            ? undefined
            : KEYLESS_ANSWER,
        ),
        Effect.orElseSucceed(() => undefined),
      );
