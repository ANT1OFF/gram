import { UsageLimitPoller } from "./limit-poller.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import { usageHistoryEnabled } from "@gram/contracts";
import { ThreadStore } from "../persistence/thread-store.ts";
import type { Handlers } from "../rpc/handlers/common.ts";
import { UsageHistoryRoots } from "./history-roots.ts";
import { makeHistoryReader } from "./history-reader.ts";

export const usageHandlers = Effect.gen(function* () {
  const store = yield* ThreadStore;
  const poller = yield* Effect.serviceOption(UsageLimitPoller);
  const roots = Option.getOrUndefined(yield* Effect.serviceOption(UsageHistoryRoots));
  const reader = makeHistoryReader(),
    lock = yield* Semaphore.make(1);
  return {
    "app.usageOverview": (query) =>
      (Option.isSome(poller) ? poller.value.refresh : Effect.void).pipe(
        Effect.andThen(
          roots === undefined
            ? store.usageOverview(query)
            : lock.withPermits(1)(
                Effect.gen(function* () {
                  const settings = yield* store.getSettings;
                  const directories = (yield* roots.roots).filter((root) =>
                    usageHistoryEnabled(settings, root.provider),
                  );
                  return yield* store.usageOverview(query, (window) =>
                    Effect.promise((signal) => reader.scan(directories, signal, window)),
                  );
                }),
              ),
        ),
      ),
  } satisfies Partial<Handlers>;
});
