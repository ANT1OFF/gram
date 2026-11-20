import { effectiveCheckout, GitError, InvalidState, NotFound } from "@gram/contracts";
import { Pr, prChecksStamp } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { isBadgeOf } from "../../git/extra-prs.ts";
import { toGitError } from "../../git/mapping.ts";
import { GitRefresh } from "../../git/platform.ts";
import { GitStatePublisher } from "../../git/publisher.ts";
import { PrReviews } from "../../git/review.ts";
import { ghFolder, ThreadPrLookup } from "../../git/thread-pr.ts";
import { ThreadStore } from "../../persistence/thread-store.ts";
import { VerifyStatus } from "../../verify/verify-tools.ts";
import type { Handlers } from "./common.ts";

/** A thread's checks: Gram's own verify record on its head, and its pull request's CI. */
export const checksHandlers = Effect.gen(function* () {
  const store = yield* ThreadStore;
  const pr = yield* Pr;
  const publisher = yield* GitStatePublisher;
  const refreshes = yield* GitRefresh;
  const reviews = yield* PrReviews;
  const threadPr = (yield* ThreadPrLookup).target;
  const noPullRequest = new InvalidState({ message: "This thread has no pull request" });
  // Absent in layers without Gram's checks: every thread then reads as having no recipe.
  const verifyStatus = Option.getOrUndefined(yield* Effect.serviceOption(VerifyStatus));

  return {
    "git.verifyState": ({ threadId }) =>
      Effect.gen(function* () {
        const thread = yield* store.getThread(threadId);
        if (verifyStatus === undefined) return { recipe: "none", drivers: [] } as const;
        return yield* verifyStatus.stateFor(thread);
      }),

    "git.verifyEvidence": ({ threadId, driver, file }) =>
      Effect.gen(function* () {
        const thread = yield* store.getThread(threadId);
        const image =
          verifyStatus === undefined
            ? undefined
            : yield* verifyStatus.evidence(thread, driver, file);
        if (image === undefined)
          return yield* new NotFound({
            entity: "file",
            id: file,
            message: `No picture ${file} from ${driver} on this commit.`,
          });
        return image;
      }),

    "git.prChecks": ({ threadId }) =>
      Effect.gen(function* () {
        const thread = yield* store.getThread(threadId);
        const cwd = yield* ghFolder(thread);
        const target = yield* threadPr(thread, cwd);
        // No PR is a normal state here as it is for `git.prDetail`, not a failure.
        if (target === undefined) return { checks: [] };
        // The client asks again as the badge's rollup changes, which is within the lookup's TTL of
        // its last answer as often as not: the stamp keeps that answer from standing in for this one.
        // Only the target's own badge can say so. Numbers are local to a repository, and a PR bound
        // from elsewhere can share its number with the checkout's.
        const badge = yield* publisher.badgeFor(thread);
        const stamp =
          badge !== undefined && isBadgeOf(badge, target) ? prChecksStamp(badge) : undefined;
        const checks = yield* pr
          .checks(cwd, target.number, target.repo, { stamp })
          .pipe(Effect.mapError((e) => new GitError({ message: e.message })));
        // A PR already failing when the app opened has no CI notice to name its checks.
        yield* publisher.checksRead(thread);
        return { checks };
      }),

    "git.prRerunChecks": ({ threadId }) =>
      Effect.gen(function* () {
        const thread = yield* store.getThread(threadId);
        const cwd = yield* ghFolder(thread);
        const target = yield* threadPr(thread, cwd);
        if (target === undefined) return yield* noPullRequest;
        // Never from the cache: the PR row reads these checks too, and an answer it cached before
        // they failed says there is nothing to rerun.
        const runs = yield* pr
          .checks(cwd, target.number, target.repo, { fresh: true })
          .pipe(Effect.mapError((e) => new GitError({ message: e.message })));
        // `gh run rerun --failed` reruns cancelled jobs too.
        const failed = runs.filter(
          (run) => run.status === "failing" || run.conclusion?.toUpperCase() === "CANCELLED",
        );
        const runIds = [
          ...new Set(failed.flatMap((run) => (run.runId === undefined ? [] : [run.runId]))),
        ];
        const skipped = failed.filter((run) => run.runId === undefined).map((run) => run.name);
        if (runIds.length === 0) {
          return yield* new InvalidState({
            message:
              skipped.length === 0
                ? "No failed checks to rerun."
                : "The failed checks don't run on GitHub Actions, so rerun them on their provider.",
          });
        }
        // Refresh even when a later rerun fails, since earlier ones were already queued.
        yield* Effect.forEach(
          runIds,
          (runId) => reviews.rerun(cwd, target.repo, runId).pipe(Effect.mapError(toGitError)),
          { discard: true },
        ).pipe(
          Effect.ensuring(
            refreshes.request(effectiveCheckout(thread).path, true, { expectChange: true }),
          ),
        );
        return { runIds, skipped };
      }),
  } satisfies Partial<Handlers>;
});
