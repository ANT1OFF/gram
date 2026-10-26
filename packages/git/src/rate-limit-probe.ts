// `gh api rate_limit`, the one GitHub endpoint that reports the quota without spending any of it.
// Free to poll, so callers can log headroom and slow down before GitHub refuses rather than after.

import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { gh } from "./exec.ts";
import type { Proc } from "./proc.ts";

/** The probe itself failed: `gh` missing, logged out, offline, or an unreadable body. */
export class RateLimitProbeError extends Data.TaggedError("RateLimitProbeError")<{
  readonly message: string;
}> {}

/** One of GitHub's quota windows. */
export interface QuotaWindow {
  readonly limit: number;
  readonly remaining: number;
  readonly used: number;
  /** Unix seconds at which the window refills, as GitHub reports it. */
  readonly resetAt: number;
  /** Seconds from the probe to `resetAt`; 0 once the window is due. */
  readonly resetInSeconds: number;
}

/**
 * The quota windows this app can spend. A window is absent only when GitHub didn't report it, which
 * callers must read as "unknown", never as "exhausted".
 */
export interface RateLimitQuota {
  /** REST requests: `gh pr view`, `gh pr list`, `gh run rerun`. */
  readonly core?: QuotaWindow;
  /** GraphQL points: the batched badge document and the review reads. */
  readonly graphql?: QuotaWindow;
  readonly search?: QuotaWindow;
  /** Epoch ms the probe answered, so a logged reading can be aged. */
  readonly checkedAt: number;
}

const isJson = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const int = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;

const quotaWindow = (value: unknown, nowMs: number): QuotaWindow | undefined => {
  if (!isJson(value)) return undefined;
  const limit = int(value["limit"]);
  const remaining = int(value["remaining"]);
  const resetAt = int(value["reset"]);
  if (limit === undefined || remaining === undefined || resetAt === undefined) return undefined;
  return {
    limit,
    remaining,
    used: int(value["used"]) ?? Math.max(0, limit - remaining),
    resetAt,
    resetInSeconds: Math.max(0, Math.round(resetAt - nowMs / 1000)),
  };
};

/**
 * The quota in a `gh api rate_limit` body. `undefined` when the body isn't one — a login prompt or
 * an HTML error page reads as a failed probe, not as an empty quota.
 */
export const parseRateLimit = (body: unknown, nowMs: number): RateLimitQuota | undefined => {
  if (!isJson(body)) return undefined;
  const resources = isJson(body["resources"]) ? body["resources"] : undefined;
  const core = quotaWindow(resources?.["core"] ?? body["rate"], nowMs);
  const graphql = quotaWindow(resources?.["graphql"], nowMs);
  const search = quotaWindow(resources?.["search"], nowMs);
  if (core === undefined && graphql === undefined && search === undefined) return undefined;
  return {
    ...(core === undefined ? {} : { core }),
    ...(graphql === undefined ? {} : { graphql }),
    ...(search === undefined ? {} : { search }),
    checkedAt: nowMs,
  };
};

/**
 * The unspent share, in [0, 1], of the tighter of the two windows the badge sweep spends, GraphQL
 * and REST core; 1 when neither was reported, so an unreadable probe never throttles anything on its
 * own. Search is left out on purpose: it is a separate allowance of 30 a minute that only the
 * review-request poller draws on, and that poller watches it itself. Counted here, a busy minute of
 * searching stretched the badge sweep eightfold while its own quotas were nearly full.
 */
export const quotaHeadroom = (quota: RateLimitQuota): number => {
  const shares = [quota.core, quota.graphql].flatMap((w) =>
    w === undefined || w.limit <= 0 ? [] : [Math.max(0, Math.min(1, w.remaining / w.limit))],
  );
  return shares.length === 0 ? 1 : Math.min(...shares);
};

/**
 * Reads the remaining core, GraphQL and search quota for the token `gh` uses in `cwd`. The
 * `rate_limit` endpoint is exempt from the limits it reports, so this costs nothing and stays
 * answerable while every other call is being refused.
 */
export const fetchRateLimit = (
  cwd: string,
): Effect.Effect<RateLimitQuota, RateLimitProbeError, Proc> =>
  Effect.gen(function* () {
    const out = yield* gh(cwd, ["api", "rate_limit"], { timeoutMs: 8_000 }).pipe(
      Effect.mapError((e) => new RateLimitProbeError({ message: e.message })),
    );
    if (out.status !== 0) {
      return yield* new RateLimitProbeError({
        message: out.stderr.trim() || `gh api rate_limit exited with code ${out.status}`,
      });
    }
    let body: unknown;
    try {
      body = JSON.parse(out.stdout.trim());
    } catch {
      return yield* new RateLimitProbeError({ message: "gh api rate_limit returned no JSON" });
    }
    const quota = parseRateLimit(body, yield* Clock.currentTimeMillis);
    if (quota === undefined) {
      return yield* new RateLimitProbeError({ message: "gh api rate_limit reported no windows" });
    }
    return quota;
  });
