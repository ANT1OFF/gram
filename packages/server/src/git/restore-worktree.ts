import {
  effectiveCheckout,
  InvalidState,
  type RestoreWorktreeResult,
  type Thread,
  type ThreadId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ThreadStore } from "../persistence/thread-store.ts";
import { CheckoutService } from "../runtime/hooks.ts";
import { GitStatePublisher, type GitStatePublisherShape } from "./publisher.ts";

/**
 * The PR whose head can recreate the thread's branch: its bound one, else its branch's last badge,
 * and only one in the repo `origin` names, since its head is fetched from there.
 */
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
    // The checkout the thread is shown, and whose state reads missing: a followed worktree's too.
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
      return {
        _tag: "branchGone",
        branch,
        ...(pr === undefined ? {} : { pr }),
      } satisfies RestoreWorktreeResult;
    }
    yield* Effect.logInfo("worktree restored").pipe(
      Effect.annotateLogs({ threadId, source: restored.source }),
    );
    if (publisher !== undefined) {
      yield* publisher.sync;
      yield* publisher.refresh(checkout.path, { remote: true });
    }
    return {
      _tag: "restored",
      path: checkout.path,
      branch,
      source: restored.source,
    } satisfies RestoreWorktreeResult;
  });
