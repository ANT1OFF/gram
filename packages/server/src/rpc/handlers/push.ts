import { InvalidState } from "@gram/contracts";
import { Proc, pushCurrentBranch } from "@gram/git";
import * as Effect from "effect/Effect";
import { GitRefresh } from "../../git/platform.ts";
import { threadFolder } from "../../git/thread-pr.ts";
import { ThreadStore } from "../../persistence/thread-store.ts";
import type { Handlers } from "./common.ts";

/** `git.push`: publish or push the thread's branch, then refresh its git state and PR badge. */
export const pushHandlers = Effect.gen(function* () {
  const store = yield* ThreadStore;
  const proc = yield* Proc;
  const refreshes = yield* GitRefresh;

  return {
    "git.push": ({ threadId }) =>
      Effect.gen(function* () {
        const cwd = yield* threadFolder(yield* store.getThread(threadId));
        const result = yield* pushCurrentBranch(cwd).pipe(
          Effect.provideService(Proc, proc),
          Effect.mapError((e) => new InvalidState({ message: e.message, threadId })),
        );
        // A push starts CI, and a review round where a bot reviews every push.
        yield* refreshes.request(cwd, true, { expectChange: true });
        return result;
      }),
  } satisfies Partial<Handlers>;
});
