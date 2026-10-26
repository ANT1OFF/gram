import { effectiveCheckout } from "@gram/contracts";
import { samePath } from "@gram/git";
import * as Effect from "effect/Effect";
import { resolveFolder } from "../../fs/folders.ts";
import { ThreadStore } from "../../persistence/thread-store.ts";
import type { Handlers } from "./common.ts";

/** `threads.usingCheckout`. */
export const checkoutUseHandlers = Effect.gen(function* () {
  const store = yield* ThreadStore;

  return {
    "threads.usingCheckout": ({ path }) =>
      Effect.gen(function* () {
        // A folder that doesn't resolve holds no open thread, but compare its spelling anyway.
        const folder = yield* resolveFolder(path).pipe(Effect.orElseSucceed(() => path));
        const users = (yield* store.listThreads).filter(
          (thread) =>
            samePath(thread.checkout.path, folder) ||
            samePath(effectiveCheckout(thread).path, folder) ||
            (thread.extraCheckouts ?? []).some((extra) => samePath(extra.path, folder)),
        );
        return {
          threads: users.map((thread) => ({
            threadId: thread.id,
            title: thread.title,
            parked: thread.parked,
          })),
        };
      }),
  } satisfies Partial<Handlers>;
});
