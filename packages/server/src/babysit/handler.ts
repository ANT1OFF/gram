import * as Effect from "effect/Effect";
import type { Handlers } from "../rpc/handlers/common.ts";
import { Babysit } from "./service.ts";

export const babysitHandlers = Effect.gen(function* () {
  const babysit = yield* Babysit;
  return {
    "thread.setBabysit": ({ threadId, enabled, budget }) =>
      babysit.setEnabled(threadId, enabled, budget),
    "thread.setReviewMonitor": ({ threadId, enabled }) =>
      babysit
        .setReviewMonitor(threadId, enabled)
        .pipe(Effect.map((bound) => (bound === undefined ? {} : { bound }))),
  } satisfies Partial<Handlers>;
});
