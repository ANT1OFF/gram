// Answers to cards over the socket: each names the card it was given for (`PendingRequest.shown`).

import {
  InvalidState,
  type RequestAnswer,
  type RequestId,
  type RespondManyResult,
  type ThreadId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import type { ThreadStoreShape } from "../../persistence/thread-store.ts";
import { KEYLESS_ANSWER, keylessRefusal } from "../../runtime/card-key.ts";
import type { ThreadRuntimesShape } from "../../runtime/thread-runtimes-shape.ts";

export { KEYLESS_ANSWER };

/** `thread.respond` and `thread.respondMany`. */
export const makeRespondHandlers = (
  store: Pick<ThreadStoreShape, "listRequests">,
  runtimes: Pick<ThreadRuntimesShape, "respond" | "respondMany">,
) => {
  const keyless = (threadId: ThreadId, requestId: RequestId, shown: string | undefined) =>
    keylessRefusal(store, threadId, requestId, shown);
  return {
    "thread.respond": ({
      threadId,
      requestId,
      answer,
      shown,
    }: {
      readonly threadId: ThreadId;
      readonly requestId: RequestId;
      readonly answer: RequestAnswer;
      readonly shown?: string;
    }) =>
      Effect.andThen(keyless(threadId, requestId, shown), (refused) =>
        refused === undefined
          ? runtimes.respond(threadId, requestId, answer, shown)
          : Effect.fail(new InvalidState({ message: refused, threadId })),
      ),
    "thread.respondMany": ({
      answers,
    }: {
      readonly answers: Parameters<ThreadRuntimesShape["respondMany"]>[0];
    }) =>
      Effect.gen(function* () {
        // Each refused on its own, as one that fails anywhere else is, and the rest still go.
        const refusals = yield* Effect.forEach(answers, (each) =>
          keyless(each.threadId, each.requestId, each.shown),
        );
        const allowed = answers.filter((_, index) => refusals[index] === undefined);
        const given = allowed.length === 0 ? [] : yield* runtimes.respondMany(allowed);
        let next = 0;
        return answers.map((each, index): RespondManyResult => {
          const refused = refusals[index];
          if (refused === undefined)
            return (
              given[next++] ?? { threadId: each.threadId, requestId: each.requestId, ok: false }
            );
          return { threadId: each.threadId, requestId: each.requestId, ok: false, error: refused };
        });
      }),
  };
};
