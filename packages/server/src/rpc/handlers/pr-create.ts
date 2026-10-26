import { InvalidState, ORCHESTRATOR_HAS_NO_PR, type BoundPr } from "@gram/contracts";
import { createPr, Proc, prDraftFromCommits } from "@gram/git";
import * as Effect from "effect/Effect";
import { GitRefresh } from "../../git/platform.ts";
import { threadFolder } from "../../git/thread-pr.ts";
import { ThreadStore } from "../../persistence/thread-store.ts";
import { ThreadRuntimes } from "../../runtime/thread-runtimes.ts";
import type { Handlers } from "./common.ts";

/** `pr.draft` and `pr.create`: open a PR for the thread's branch from the create-PR dialog. */
export const prCreateHandlers = Effect.gen(function* () {
  const store = yield* ThreadStore;
  const runtimes = yield* ThreadRuntimes;
  const proc = yield* Proc;
  const refreshes = yield* GitRefresh;

  const threadAndFolder = (threadId: Parameters<typeof store.getThread>[0]) =>
    Effect.gen(function* () {
      const thread = yield* store.getThread(threadId);
      return { thread, cwd: yield* threadFolder(thread) };
    });

  return {
    "pr.draft": ({ threadId, base }) =>
      Effect.gen(function* () {
        const { thread, cwd } = yield* threadAndFolder(threadId);
        return yield* prDraftFromCommits(cwd, `origin/${base}`, thread.title).pipe(
          Effect.provideService(Proc, proc),
        );
      }),

    "pr.create": ({ threadId, title, body, base, draft }) =>
      Effect.gen(function* () {
        const { thread, cwd } = yield* threadAndFolder(threadId);
        // Its binding would be dropped on write, leaving a PR on GitHub that nothing follows.
        if (thread.role === "orchestrator") {
          return yield* new InvalidState({ message: ORCHESTRATOR_HAS_NO_PR, threadId });
        }
        const created = yield* createPr(cwd, { title, body, base, draft }).pipe(
          Effect.provideService(Proc, proc),
          Effect.mapError((e) => new InvalidState({ message: e.message, threadId })),
        );
        const boundPr: BoundPr = { repo: created.repo, number: created.number, monitor: false };
        yield* runtimes.updateThread(threadId, (t) => ({ ...t, boundPr }));
        yield* refreshes.request(cwd, true, { expectChange: true });
        return created;
      }),
  } satisfies Partial<Handlers>;
});
