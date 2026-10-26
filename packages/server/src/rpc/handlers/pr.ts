import { InvalidState, type Thread, type ThreadId } from "@gram/contracts";
import type { PrActionError } from "@gram/git";
import * as Effect from "effect/Effect";
import { toGitError } from "../../git/mapping.ts";
import { GitRefresh } from "../../git/platform.ts";
import { PrActions } from "../../git/pr-actions.ts";
import { threadFolder, ThreadPrLookup } from "../../git/thread-pr.ts";
import { ThreadStore } from "../../persistence/thread-store.ts";
import type { Handlers } from "./common.ts";

interface Target {
  readonly thread: Thread;
  readonly cwd: string;
  readonly repo: string;
  readonly number: number;
}

/** `pr.mergeOptions`, `pr.merge`, `pr.ready`, `pr.close`, `pr.reopen` and `pr.updateBranch`. */
export const prHandlers = Effect.gen(function* () {
  const store = yield* ThreadStore;
  const threadPr = yield* ThreadPrLookup;
  const actions = yield* PrActions;
  const refreshes = yield* GitRefresh;

  /** The thread's checkout and PR: the bound PR, else its branch's badge. */
  const target = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const thread = yield* store.getThread(threadId);
      const cwd = yield* threadFolder(thread);
      const found = yield* threadPr.target(thread, cwd);
      if (found === undefined) {
        return yield* new InvalidState({ message: "This thread has no pull request" });
      }
      return { thread, cwd, ...found } satisfies Target;
    });

  /**
   * Runs a write on the thread's PR, then refreshes its badge so the panel settles. The refresh runs
   * on failure too: `gh` can exit non-zero after GitHub already acted.
   */
  const write = (
    threadId: ThreadId,
    act: (target: Target) => Effect.Effect<void, PrActionError | InvalidState>,
  ) =>
    Effect.gen(function* () {
      const found = yield* target(threadId);
      yield* act(found).pipe(
        Effect.catchTag("PrActionError", (e) => Effect.fail(toGitError(e))),
        Effect.ensuring(refreshes.request(found.cwd, true, { expectChange: true })),
      );
    });

  return {
    "pr.mergeOptions": ({ threadId }) =>
      Effect.gen(function* () {
        const found = yield* target(threadId);
        const settings = yield* actions
          .mergeSettings(found.cwd, found.repo)
          .pipe(Effect.mapError(toGitError));
        return { ...settings, babysit: found.thread.babysit !== undefined };
      }),

    "pr.merge": ({ threadId, strategy, auto = false }) =>
      write(threadId, ({ thread, cwd, repo, number }) =>
        auto && thread.babysit !== undefined
          ? Effect.fail(
              new InvalidState({
                message: "Auto-merge isn't allowed in babysit mode; merge by hand.",
              }),
            )
          : actions.merge(cwd, repo, number, strategy, auto),
      ),

    "pr.ready": ({ threadId, draft }) =>
      write(threadId, ({ cwd, repo, number }) => actions.setDraft(cwd, repo, number, draft)),

    "pr.close": ({ threadId }) =>
      write(threadId, ({ cwd, repo, number }) => actions.close(cwd, repo, number)),

    "pr.updateBranch": ({ threadId }) =>
      write(threadId, ({ cwd, repo, number }) => actions.updateBranch(cwd, repo, number)),

    "pr.reopen": ({ threadId }) =>
      write(threadId, ({ cwd, repo, number }) => actions.reopen(cwd, repo, number)),
  } satisfies Partial<Handlers>;
});
