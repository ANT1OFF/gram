import { GitError, InvalidState, type BoundPr } from "@gram/contracts";
import { fetchPrHead, prHead, Proc, tryRepoTop } from "@gram/git";
import * as Effect from "effect/Effect";
import { resolveFolder } from "../../fs/folders.ts";
import { toGitError } from "../../git/mapping.ts";
import { GitRefresh } from "../../git/platform.ts";
import { ThreadStore } from "../../persistence/thread-store.ts";
import { heldCheckoutPaths } from "../../runtime/create-in-checkout.ts";
import { CheckoutService } from "../../runtime/hooks.ts";
import { ThreadRuntimes } from "../../runtime/thread-runtimes.ts";
import type { Handlers } from "./common.ts";

/** `pr.checkout`. */
export const prCheckoutHandlers = Effect.gen(function* () {
  const store = yield* ThreadStore;
  const runtimes = yield* ThreadRuntimes;
  const checkouts = yield* CheckoutService;
  const refreshes = yield* GitRefresh;
  const proc = yield* Proc;
  const provide = Effect.provideService(Proc, proc);

  return {
    "pr.checkout": ({ projectRoot, number, repo }) =>
      Effect.gen(function* () {
        const root = yield* resolveFolder(projectRoot);
        const top = yield* provide(tryRepoTop(root)).pipe(Effect.mapError(toGitError));
        if (top === undefined) {
          return yield* new GitError({ message: `${root} is not a git repository` });
        }
        const head = yield* provide(prHead(top, number, repo)).pipe(Effect.mapError(toGitError));
        const branch = yield* provide(fetchPrHead(top, head)).pipe(Effect.mapError(toGitError));
        const open = heldCheckoutPaths(yield* store.listThreads);
        const checkout = yield* checkouts
          .prepare({ kind: "newWorktree", branch }, open, root)
          .pipe(
            Effect.catchTag("WorktreeDirty", (e) =>
              Effect.fail(new InvalidState({ message: `${e.path} has uncommitted changes` })),
            ),
          );
        const thread = yield* runtimes.create({
          projectRoot: root,
          checkout,
          title: head.title === "" ? `PR #${head.number}` : `#${head.number} ${head.title}`,
        });
        const boundPr: BoundPr = { repo: head.repo, number: head.number, monitor: false };
        const bound = yield* runtimes.updateThread(thread.id, (t) => ({ ...t, boundPr }));
        yield* refreshes.request(checkout.path, true);
        return bound;
      }),
  } satisfies Partial<Handlers>;
});
