import {
  effectiveCheckout,
  type Checkout,
  InvalidState,
  WorktreeBranchGone,
  WorktreeRestored,
  type Thread,
  type ThreadId,
  hostOf,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ThreadStore } from "../persistence/thread-store.ts";
import { CheckoutService } from "../runtime/hooks.ts";
import { GitStatePublisher, type GitStatePublisherShape } from "./publisher.ts";

const restorablePr = (thread: Thread, publisher: GitStatePublisherShape | undefined) =>
  Effect.gen(function* () {
    if (publisher === undefined) return undefined;
    const state = yield* publisher.stateFor(effectiveCheckout(thread).path);
    const origin = state?.origin;
    if (origin === undefined) return undefined;
    const candidate =
      thread.boundPr ??
      (state?.pr === undefined ? undefined : { repo: origin, number: state.pr.number });
    return candidate !== undefined && candidate.repo.toLowerCase() === origin.toLowerCase()
      ? { repo: candidate.repo, number: candidate.number }
      : undefined;
  });

/**
 * Recreates a thread's worktree deleted outside Gram (`thread.restoreWorktree`, and the
 * orchestrator's `restore_worktree`), then reads its git state anew so `missing` clears. A branch
 * gone from the repo and `origin` comes back only with `fromPr`, from the PR's head; without it the
 * answer names the PR that could.
 */
export const restoreThreadWorktree = (threadId: ThreadId, fromPr: boolean) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const checkouts = yield* CheckoutService;
    const publisher = Option.getOrUndefined(yield* Effect.serviceOption(GitStatePublisher));
    const thread = yield* store.getThread(threadId);
    const checkout = effectiveCheckout(thread);
    if (yield* checkouts.present(checkout.path)) {
      return yield* new InvalidState({
        message: "This thread's folder is there, so there is nothing to restore.",
        threadId,
      });
    }
    const pr = yield* restorablePr(thread, publisher);
    const restored = yield* checkouts.restore(thread, fromPr ? pr?.number : undefined);
    const branch = checkout.branch ?? "";
    if (restored.kind === "branchGone") {
      return WorktreeBranchGone.make({ branch, ...(pr === undefined ? {} : { pr }) });
    }
    const setup = restored.worktreeSetup;
    if (setup !== undefined || checkout.worktreeSetup !== undefined) {
      const sameCheckout = (candidate: Checkout) =>
        candidate.path === checkout.path &&
        hostOf(candidate) === hostOf(checkout) &&
        candidate.worktreeSetup?.generation === checkout.worktreeSetup?.generation;
      const withSetup = ({ worktreeSetup: _, ...candidate }: Checkout): Checkout =>
        setup === undefined ? candidate : { ...candidate, worktreeSetup: setup };
      yield* store.updateThread(threadId, (current) =>
        current.currentCheckout !== undefined && sameCheckout(current.currentCheckout)
          ? { ...current, currentCheckout: withSetup(current.currentCheckout) }
          : sameCheckout(current.checkout)
            ? { ...current, checkout: withSetup(current.checkout) }
            : current,
      );
    }
    yield* Effect.logInfo("worktree restored").pipe(
      Effect.annotateLogs({ threadId, source: restored.source }),
    );
    if (publisher !== undefined) {
      yield* publisher.sync;
      yield* publisher.refresh(checkout.path, { remote: true });
    }
    return WorktreeRestored.make({ path: checkout.path, branch, source: restored.source });
  });
