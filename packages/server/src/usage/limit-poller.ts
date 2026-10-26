import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import { EventHub } from "../events/event-hub.ts";
import { AppActivity, pollWhileShown } from "../git/activity.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { AgentHosts } from "../runtime/agent-hosts.ts";
import { UsageLimitReadings } from "./limit-readings.ts";

export const LIMIT_POLL_MS = 60_000;
/** Coalesce simultaneous Usage page requests and a background refresh. */
const LIMIT_REFRESH_QUIET_MS = 10_000;
/**
 * How often limits are read while a thread waits on one and no recent read came from the window,
 * so a wait ends once the readings show the limit lifted, with nobody looking.
 */
export const LIMIT_WAIT_POLL_MS = 5 * 60_000;

/** Polls subscription metadata only. No session, model turn, gateway or helper context. */
export class UsageLimitPoller extends Context.Service<
  UsageLimitPoller,
  {
    readonly refresh: Effect.Effect<void>;
  }
>()("@gram/server/UsageLimitPoller") {
  static readonly layer = Layer.effect(
    UsageLimitPoller,
    Effect.gen(function* () {
      const hosts = yield* AgentHosts;
      const readings = yield* UsageLimitReadings;
      const hub = yield* EventHub;
      const lock = yield* Semaphore.make(1);
      let lastAt = -Infinity;
      const refresh = lock.withPermits(1)(
        Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis;
          if (at - lastAt < LIMIT_REFRESH_QUIET_MS) return;
          lastAt = at;
          yield* Effect.forEach(
            ["claude", "codex"] as const,
            (agent) =>
              Effect.gen(function* () {
                const host = yield* hosts.get(agent).pipe(Effect.option);
                if (host._tag === "None" || host.value.readSubscriptionLimits === undefined) return;
                const beforeQuery = yield* readings.current;
                const result = yield* host.value.readSubscriptionLimits.pipe(
                  Effect.catch((error) =>
                    error.reason === "not-logged-in" ||
                    error.reason === "api-key-auth" ||
                    error.reason === "third-party-provider"
                      ? Effect.succeed([])
                      : Effect.fail(error),
                  ),
                  Effect.result,
                );
                // Transient failures retain the last observation and its age; never fabricate 0%.
                if (result._tag === "Failure") return;
                yield* readings.replaceSubscription(agent, result.success, beforeQuery);
                yield* hub.publish({
                  type: "usageLimits.snapshot",
                  limits: yield* readings.current,
                });
              }),
            { concurrency: 2 },
          );
        }),
      );
      // Each Claude reading starts a Claude Code CLI, and the meter is the window's: no window, no
      // poll. Live sessions still record what their turns report, and an orchestrator's limit checks
      // read those, so a worker spawned while nobody looks is still held at its limit.
      yield* pollWhileShown(yield* Effect.serviceOption(AppActivity), LIMIT_POLL_MS, refresh).pipe(
        Effect.forkScoped,
      );
      // A limit wait is work that depends on the readings while nobody looks: they end it early.
      const store = yield* Effect.serviceOption(ThreadStore);
      if (Option.isSome(store)) {
        yield* Effect.gen(function* () {
          yield* Effect.sleep(Duration.millis(LIMIT_WAIT_POLL_MS));
          if ((yield* Clock.currentTimeMillis) - lastAt < LIMIT_WAIT_POLL_MS) return;
          const waiting = (yield* store.value.listThreads).some(
            ({ limitWait: wait }) =>
              wait?.kind === "limit" && wait.cancelled !== true && wait.cleared === undefined,
          );
          if (waiting) yield* refresh;
        }).pipe(Effect.forever, Effect.forkScoped);
      }
      return { refresh };
    }),
  );
}
