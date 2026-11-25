import {
  InvalidState,
  type RequestAnswer,
  type RequestId,
  type RespondManyResult,
  type ThreadId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import { isLocalApp } from "../../http/local-app.ts";
import type { ThreadStoreShape } from "../../persistence/thread-store.ts";
import { KEYLESS_ANSWER, keylessRefusal } from "../../runtime/card-key.ts";
import { withLocalAppApproval } from "../../runtime/ui-approval.ts";
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
    "thread.respond": (
      {
        threadId,
        requestId,
        answer,
        shown,
      }: {
        readonly threadId: ThreadId;
        readonly requestId: RequestId;
        readonly answer: RequestAnswer;
        readonly shown?: string;
      },
      call?: { readonly headers?: Readonly<Record<string, string | undefined>> },
    ) =>
      Effect.andThen(keyless(threadId, requestId, shown), (refused) => {
        if (refused !== undefined)
          return Effect.fail(new InvalidState({ message: refused, threadId }));
        const response = runtimes.respond(threadId, requestId, answer, shown);
        return isLocalApp(call?.headers)
          ? withLocalAppApproval(response, threadId, requestId, shown)
          : response;
      }),
    "thread.respondMany": ({
      answers,
    }: {
      readonly answers: Parameters<ThreadRuntimesShape["respondMany"]>[0];
    }) =>
      Effect.gen(function* () {
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
