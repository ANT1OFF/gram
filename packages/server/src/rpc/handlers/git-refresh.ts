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
        const cwd = yield* threadFolder(yield* store.getThread(threadId));
        yield* refreshes.request(cwd, true);
      }),
  } satisfies Partial<Handlers>;
});
