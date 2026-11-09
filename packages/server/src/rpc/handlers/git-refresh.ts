import { effectiveCheckout, isLocalHost } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { GitRefresh } from "../../git/platform.ts";
import { threadFolder } from "../../git/thread-pr.ts";
import { ThreadStore } from "../../persistence/thread-store.ts";
import type { Handlers } from "./common.ts";

/** `git.refresh`. */
export const gitRefreshHandlers = Effect.gen(function* () {
  const store = yield* ThreadStore;
  const refreshes = yield* GitRefresh;

  return {
    "git.refresh": ({ threadId }) =>
      Effect.gen(function* () {
        const thread = yield* store.getThread(threadId);
        const checkout = effectiveCheckout(thread);
        // Another machine's checkout is read there, by the publisher; this disk has no say in it.
        const cwd = isLocalHost(checkout) ? yield* threadFolder(thread) : checkout.path;
        yield* refreshes.request(cwd, true);
      }),
  } satisfies Partial<Handlers>;
});
