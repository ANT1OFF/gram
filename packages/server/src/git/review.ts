import type { ApplySuggestionResult, PrReview, ReviewBot, ReviewComment } from "@gram/contracts";
import {
  applySuggestion,
  containsCommit,
  fetchPrReview,
  postPrComment,
  Proc,
  replyToThread,
  rerunFailedJobs,
  resolveThread,
  ReviewActionError,
  Tools,
  type SuggestionError,
  type SuggestionTarget,
} from "@gram/git";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** Review-bot reads and writes for the RPC handlers, behind a service so tests never reach `gh`. */
export class PrReviews extends Context.Service<
  PrReviews,
  {
    /** The full review; `available: false` when `gh` is missing or logged out. */
    readonly fetch: (
      workTree: string,
      repo: string,
      number: number,
      bots: ReadonlyArray<ReviewBot>,
    ) => Effect.Effect<PrReview, ReviewActionError>;
    readonly reply: (
      workTree: string,
      reviewThreadId: string,
      body: string,
    ) => Effect.Effect<ReviewComment, ReviewActionError>;
    readonly resolve: (
      workTree: string,
      reviewThreadId: string,
    ) => Effect.Effect<void, ReviewActionError>;
    readonly comment: (
      workTree: string,
      repo: string,
      number: number,
      body: string,
    ) => Effect.Effect<void, ReviewActionError>;
    readonly applySuggestion: (
      workTree: string,
      target: SuggestionTarget,
      suggestion: string,
    ) => Effect.Effect<ApplySuggestionResult, SuggestionError>;
    /** Reruns the failed jobs of an Actions run. */
    readonly rerun: (
      workTree: string,
      repo: string,
      runId: string,
    ) => Effect.Effect<void, ReviewActionError>;
    /** Whether `head` contains `sha`; `undefined` when a commit isn't known locally. */
    readonly isPushed: (
      workTree: string,
      sha: string,
      head: string,
    ) => Effect.Effect<boolean | undefined>;
  }
>()("@gram/server/PrReviews") {
  static readonly layer = Layer.effect(
    PrReviews,
    Effect.gen(function* () {
      const proc = yield* Proc;
      const tools = yield* Tools;
      const provide = Effect.provideService(Proc, proc);
      return {
        fetch: (workTree, repo, number, bots) =>
          Effect.gen(function* () {
            if (!(yield* tools.ghReady))
              return { available: false, threads: [] } satisfies PrReview;
            return yield* provide(fetchPrReview(workTree, repo, number, bots));
          }),
        reply: (workTree, reviewThreadId, body) =>
          provide(replyToThread(workTree, reviewThreadId, body)),
        resolve: (workTree, reviewThreadId) => provide(resolveThread(workTree, reviewThreadId)),
        comment: (workTree, repo, number, body) =>
          provide(postPrComment(workTree, repo, number, body)),
        applySuggestion,
        rerun: (workTree, repo, runId) => provide(rerunFailedJobs(workTree, repo, runId)),
        isPushed: (workTree, sha, head) => provide(containsCommit(workTree, sha, head)),
      };
    }),
  );

  /** For tests: no review data, network writes refused, suggestions applied for real. */
  static readonly layerOffline = Layer.succeed(PrReviews, {
    fetch: () => Effect.succeed({ available: true, threads: [] }),
    reply: () => Effect.fail(new ReviewActionError({ message: "no network in tests" })),
    resolve: () => Effect.fail(new ReviewActionError({ message: "no network in tests" })),
    comment: () => Effect.fail(new ReviewActionError({ message: "no network in tests" })),
    applySuggestion,
    rerun: () => Effect.fail(new ReviewActionError({ message: "no network in tests" })),
    isPushed: () => Effect.succeed(undefined),
  });
}
