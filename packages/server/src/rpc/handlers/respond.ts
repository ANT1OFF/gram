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
import { AnsweredInLocalApp } from "../../runtime/answer-reach.ts";
import { KEYLESS_ANSWER, keylessRefusal } from "../../runtime/card-key.ts";
import type { ThreadRuntimesShape } from "../../runtime/thread-runtimes-shape.ts";

export { KEYLESS_ANSWER };

type CallHeaders = { readonly headers?: Readonly<Record<string, string | undefined>> } | undefined;

const answeredInLocalAppIfMarked = <A, E, R>(call: CallHeaders, effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, AnsweredInLocalApp, isLocalApp(call?.headers));

/**
 * `thread.respond` and `thread.respondMany`. Their answers count as given in the local app on this
 * computer only when the transport stamped the call as the local app's (`isLocalApp`); a paired
 * browser's do not, so a card only the local app may approve (`ApprovalReach`) is refused to it.
 */
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
      call?: CallHeaders,
    ) =>
      Effect.andThen(keyless(threadId, requestId, shown), (refused) =>
        refused === undefined
          ? answeredInLocalAppIfMarked(call, runtimes.respond(threadId, requestId, answer, shown))
          : Effect.fail(new InvalidState({ message: refused, threadId })),
      ),
    "thread.respondMany": (
      {
        answers,
      }: {
        readonly answers: Parameters<ThreadRuntimesShape["respondMany"]>[0];
      },
      call?: CallHeaders,
    ) =>
      Effect.gen(function* () {
        const refusals = yield* Effect.forEach(answers, (each) =>
          keyless(each.threadId, each.requestId, each.shown),
        );
        const allowed = answers.filter((_, index) => refusals[index] === undefined);
        const given =
          allowed.length === 0
            ? []
            : yield* answeredInLocalAppIfMarked(call, runtimes.respondMany(allowed));
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
