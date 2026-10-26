import { effectiveCheckout, InvalidState, samePr, type Thread } from "@gram/contracts";
import { Proc, readCiDiagnostic } from "@gram/git";
import * as Effect from "effect/Effect";
import { threadFolder, ThreadPrLookup } from "../../git/thread-pr.ts";
import { ThreadStore } from "../../persistence/thread-store.ts";
import type { Handlers } from "./common.ts";

export const ciDiagnosticHandlers = Effect.gen(function* () {
  const store = yield* ThreadStore;
  const proc = yield* Proc;
  const lookup = yield* ThreadPrLookup;
  return {
    "git.prCheckDiagnostic": ({ threadId, selection }) =>
      Effect.gen(function* () {
        const thread = yield* store.getThread(threadId);
        const cwd = yield* threadFolder(thread);
        const target = yield* lookup.target(thread, cwd);
        if (target === undefined)
          return yield* new InvalidState({ message: "This thread has no pull request", threadId });
        const checkout = effectiveCheckout(thread);
        const result = yield* readCiDiagnostic(cwd, target.repo, target.number, selection).pipe(
          Effect.provideService(Proc, proc),
        );
        const ownershipChanged = (latest: Thread): boolean => {
          const next = effectiveCheckout(latest);
          return (
            latest.role !== thread.role ||
            next.kind !== checkout.kind ||
            next.path !== checkout.path ||
            next.branch !== checkout.branch ||
            next.base !== checkout.base ||
            next.repoRoot !== checkout.repoRoot ||
            (thread.boundPr === undefined
              ? latest.boundPr !== undefined
              : latest.boundPr === undefined || !samePr(thread.boundPr, latest.boundPr))
          );
        };
        const changed = () =>
          new InvalidState({
            message:
              "Thread PR or checkout changed while reading CI evidence. Refresh the pull request.",
            threadId,
          });
        // Remote head/attempt checks cannot establish that this thread still owns that PR.
        const current = yield* store.getThread(threadId);
        if (ownershipChanged(current)) return yield* changed();
        const currentTarget = yield* lookup.target(current, cwd);
        // An unbound target lookup may itself await provider metadata; finish with a store reread.
        const settled = yield* store.getThread(threadId);
        if (
          ownershipChanged(settled) ||
          currentTarget === undefined ||
          !samePr(target, currentTarget)
        )
          return yield* changed();
        return result;
      }),
  } satisfies Partial<Handlers>;
});
