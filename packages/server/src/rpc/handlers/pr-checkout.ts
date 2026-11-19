import {
  GitError,
  InvalidState,
  LOCAL_HOST_ID,
  type BoundPr,
  type CheckoutRequest,
} from "@gram/contracts";
import { fetchPrHead, originOwnerRepo, prHead, Proc, tryRepoTop, type PrHead } from "@gram/git";
import * as Effect from "effect/Effect";
import { resolveFolder } from "../../fs/folders.ts";
import { toGitError } from "../../git/mapping.ts";
import { GitRefresh } from "../../git/platform.ts";
import { ThreadStore } from "../../persistence/thread-store.ts";
import { heldCheckoutPaths } from "../../runtime/create-in-checkout.ts";
import { CheckoutService } from "../../runtime/hooks.ts";
import { ThreadRuntimes } from "../../runtime/thread-runtimes.ts";
import type { Handlers } from "./common.ts";

/**
 * Whether a PR's head is the project's own code: its head is a branch of the repository the project
 * tracks as `origin`. A fork's head, and any PR of another repository (whose head GitHub compares
 * with that repository, not with this project), is someone else's.
 */
export const prHeadIsProjects = (
  head: Pick<PrHead, "fork" | "repo" | "headRepo">,
  origin: string | undefined,
): boolean =>
  !head.fork &&
  origin !== undefined &&
  head.repo.toLowerCase() === origin.toLowerCase() &&
  (head.headRepo === undefined || head.headRepo.toLowerCase() === origin.toLowerCase());

/**
 * The worktree a PR is checked out in. Someone else's head is its author's code: the worktree gets
 * nothing of the main checkout's, and the thread's agent loads none of the settings the PR carries
 * (`Checkout.untrusted`).
 */
export const prCheckoutRequest = (
  head: Pick<PrHead, "fork" | "repo" | "headRepo">,
  branch: string,
  origin: string | undefined,
): CheckoutRequest & { readonly kind: "newWorktree" } =>
  prHeadIsProjects(head, origin)
    ? { kind: "newWorktree", branch }
    : { kind: "newWorktree", branch, untrusted: true };

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
        const origin = yield* provide(originOwnerRepo(top));
        const branch = yield* provide(fetchPrHead(top, head)).pipe(Effect.mapError(toGitError));
        const open = heldCheckoutPaths(yield* store.listThreads, LOCAL_HOST_ID);
        const checkout = yield* checkouts
          .prepare(prCheckoutRequest(head, branch, origin), open, root)
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
