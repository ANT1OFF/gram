// What GitHub says is left of the hour's allowance, cached for the pollers. `fetchRateLimit` does
// the asking; this decides how often to ask and writes the reading to the log, so a support log
// shows the headroom the sweep was working with rather than only the 403 at the end.

import {
  fetchRateLimit,
  Proc,
  quotaHeadroom,
  Tools,
  type QuotaWindow,
  type RateLimitQuota,
} from "@gram/git";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** How often the quota is re-read when nothing has gone wrong. */
export const QUOTA_REFRESH = Duration.minutes(10);

/** The share of one window still unspent, in [0, 1]; 1 when GitHub didn't report it. */
export const windowHeadroom = (quotaWindow: QuotaWindow | undefined): number =>
  quotaWindow === undefined || quotaWindow.limit <= 0
    ? 1
    : Math.max(0, Math.min(1, quotaWindow.remaining / quotaWindow.limit));

export class GhQuota extends Context.Service<
  GhQuota,
  {
    /**
     * The last reading, re-probed when it's older than `QUOTA_REFRESH` or `force` is set (which is
     * what a rate-limit signal does). `undefined` without `gh`, or when the probe fails — callers
     * must read that as "unknown", never as "exhausted".
     */
    readonly current: (options?: {
      readonly force?: boolean;
    }) => Effect.Effect<RateLimitQuota | undefined>;
  }
>()("@gram/server/GhQuota") {
  /** Never probes: for tests and for a server with no `gh` wiring. */
  static readonly layerNone = Layer.succeed(GhQuota, { current: () => Effect.succeed(undefined) });

  /** Caches whatever `probe` returns, and logs each fresh reading. */
  static readonly layerFrom = (probe: Effect.Effect<RateLimitQuota | undefined>) =>
    Layer.effect(
      GhQuota,
      Effect.sync(() => {
        let quota: RateLimitQuota | undefined;
        let probedAt: number | undefined;
        const stale = Duration.toMillis(QUOTA_REFRESH);
        return {
          current: ({ force = false } = {}) =>
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;
              if (!force && probedAt !== undefined && now - probedAt < stale) return quota;
              probedAt = now;
              quota = yield* probe;
              if (quota === undefined) return undefined;
              yield* Effect.logInfo("github quota").pipe(
                Effect.annotateLogs({
                  core: quota.core?.remaining ?? -1,
                  graphql: quota.graphql?.remaining ?? -1,
                  search: quota.search?.remaining ?? -1,
                  headroom: Math.round(quotaHeadroom(quota) * 100) / 100,
                }),
              );
              return quota;
            }),
        };
      }),
    );

  /** `gh api rate_limit`, which consumes no quota of its own. Silent without `gh`. */
  static readonly layer = Layer.unwrap(
    Effect.gen(function* () {
      const proc = yield* Proc;
      const tools = yield* Tools;
      const probe = Effect.gen(function* () {
        if (!(yield* tools.ghReady)) return undefined;
        return yield* fetchRateLimit(process.cwd());
      }).pipe(
        Effect.provideService(Proc, proc),
        Effect.orElseSucceed(() => undefined),
      );
      return GhQuota.layerFrom(probe);
    }),
  );
}
