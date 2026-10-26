import { InvalidState, type ThreadId } from "@gram/contracts";
import {
  editPrLabels,
  listRepoLabels,
  Proc,
  requestReviewers,
  reviewerSuggestions,
} from "@gram/git";
import * as Effect from "effect/Effect";
import { GitRefresh } from "../../git/platform.ts";
import { toGitError } from "../../git/mapping.ts";
import { threadFolder, ThreadPrLookup } from "../../git/thread-pr.ts";
import { ThreadStore } from "../../persistence/thread-store.ts";
import type { Handlers } from "./common.ts";

/** `pr.requestReview`, `pr.reviewerSuggestions` and `pr.labels.*`. */
export const prPeopleHandlers = Effect.gen(function* () {
  const store = yield* ThreadStore;
  const proc = yield* Proc;
  const lookup = yield* ThreadPrLookup;
  const refreshes = yield* GitRefresh;
  const provide = Effect.provideService(Proc, proc);

  /** The thread's folder and PR: the bound PR, else the branch's badge. */
  const threadPr = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const thread = yield* store.getThread(threadId);
      const cwd = yield* threadFolder(thread);
      const found = yield* lookup.target(thread, cwd);
      if (found === undefined) {
        return yield* new InvalidState({ message: "This thread has no pull request", threadId });
      }
      return { cwd, ...found };
    });

  const editLabels = (
    threadId: ThreadId,
    change: "add" | "remove",
    labels: ReadonlyArray<string>,
  ) =>
    Effect.gen(function* () {
      const target = yield* threadPr(threadId);
      yield* provide(editPrLabels(target.cwd, target.repo, target.number, change, labels)).pipe(
        Effect.mapError(toGitError),
      );
      yield* refreshes.request(target.cwd, true);
    });

  return {
    "pr.requestReview": ({ threadId, reviewers }) =>
      Effect.gen(function* () {
        const target = yield* threadPr(threadId);
        const sent = yield* provide(
          requestReviewers(target.cwd, target.repo, target.number, reviewers),
        ).pipe(Effect.mapError(toGitError));
        yield* refreshes.request(target.cwd, true);
        return { reviewers: sent };
      }),

    "pr.reviewerSuggestions": ({ threadId }) =>
      Effect.gen(function* () {
        const target = yield* threadPr(threadId);
        return { logins: yield* provide(reviewerSuggestions(target.cwd, target.repo)) };
      }),

    "pr.labels.list": ({ threadId }) =>
      Effect.gen(function* () {
        const target = yield* threadPr(threadId);
        const labels = yield* provide(listRepoLabels(target.cwd, target.repo)).pipe(
          Effect.mapError(toGitError),
        );
        return { labels };
      }),

    "pr.labels.add": ({ threadId, labels }) => editLabels(threadId, "add", labels),
    "pr.labels.remove": ({ threadId, labels }) => editLabels(threadId, "remove", labels),
  } satisfies Partial<Handlers>;
});
