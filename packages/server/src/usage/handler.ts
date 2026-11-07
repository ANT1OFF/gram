import { UsageLimitPoller } from "./limit-poller.ts";
import { UsageLimitReadings } from "./limit-readings.ts";
import { DAY_MS } from "../zone-time.ts";
import * as Clock from "effect/Clock";
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
  // Absent in runtime-only test layers, which keep no limit readings.
  const limits = yield* Effect.serviceOption(UsageLimitReadings);
  const roots = Option.getOrUndefined(yield* Effect.serviceOption(UsageHistoryRoots));
  const reader = makeHistoryReader(),
    lock = yield* Semaphore.make(1);
  return {
    "app.usageLimitHistory": ({ days }) =>
      Option.isSome(limits)
        ? limits.value.history(days)
        : Clock.currentTimeMillis.pipe(
            Effect.map((to) => ({
              from: to - days * DAY_MS,
              to,
              step: 0,
              windows: [],
              credits: [],
            })),
          ),
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
