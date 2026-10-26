import { Worktrees } from "@gram/git";
import * as Effect from "effect/Effect";
import { toGitError } from "../../git/mapping.ts";
import { ThreadStore } from "../../persistence/thread-store.ts";
import type { Handlers } from "./common.ts";

/** `worktree.pendingPermissions` for the close checklist. */
export const threadUiHandlers = Effect.gen(function* () {
  const store = yield* ThreadStore;
  const worktrees = yield* Worktrees;

  return {
    "worktree.pendingPermissions": ({ threadId }) =>
      Effect.gen(function* () {
        const { checkout } = yield* store.getThread(threadId);
        if (checkout.kind !== "worktree") return [];
        const rules = yield* worktrees
          .pendingPermissions(checkout.repoRoot ?? checkout.path, checkout.path)
          .pipe(Effect.mapError(toGitError));
        return [...rules];
      }),
  } satisfies Partial<Handlers>;
});
