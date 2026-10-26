// Classifying a failed `gh` invocation as a GitHub rate-limit response, and the retry policy that
// follows from it. Pure: callers feed in `gitFailMsg` text and drive their own schedules.

import { splitGhInclude } from "./rate-limit-headers.ts";

/**
 * Which limit GitHub applied. `primary` is the hourly quota (REST requests or GraphQL points);
 * `secondary` is the short-term abuse limiter, which punishes sustained request rates and so must
 * be backed off from hardest.
 */
export type RateLimitKind = "primary" | "secondary";

export interface RateLimitSignal {
  readonly kind: RateLimitKind;
  /** GitHub's own `Retry-After`, when it sent one. Authoritative: prefer it over any backoff. */
  readonly retryAfterSeconds?: number;
}

const SECONDARY = /secondary rate limit|abuse detection|abuse-detection/;
// The status only as gh prints it, `HTTP 429`: a bare 429 is also a PR number, and GitHub's "Could
// not resolve to a PullRequest with the number of 429" is an ordinary failure.
const PRIMARY =
  /rate limit (?:already )?exceeded|api rate limit|x-ratelimit-remaining:\s*0|http 429|429 too many requests/;
/**
 * A refused GraphQL document's own error type, for a body too large or too broken to parse. Matched
 * against raw JSON, where a quote inside a PR title or body is escaped, so no text a user wrote can
 * read as this.
 */
const GRAPHQL_REFUSED = /"type":\s*"RATE_LIMIT"/;

/**
 * Whether a GraphQL response body says GitHub refused it on rate-limit grounds: a top-level error of
 * type `RATE_LIMIT`. Only the top level, so nothing inside `data` — where PR titles, bodies and
 * review comments are — can pass for it; and the whole body, because a partial answer puts its
 * `data` first and that alone runs to many KiB of review text. A body that doesn't parse, because
 * the output cap cut it short, is matched as raw JSON instead.
 */
const graphqlRefused = (body: string): boolean => {
  const text = body.trim();
  if (text === "") return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return GRAPHQL_REFUSED.test(text);
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const errors: unknown = (parsed as Record<string, unknown>)["errors"];
  return (
    Array.isArray(errors) &&
    errors.some(
      (error) =>
        typeof error === "object" &&
        error !== null &&
        (error as Record<string, unknown>)["type"] === "RATE_LIMIT",
    )
  );
};

const retryAfter = (text: string): number | undefined => {
  const match = /retry[- ]after:?\s*(\d+)/.exec(text);
  if (match?.[1] === undefined) return undefined;
  const seconds = Number.parseInt(match[1], 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
};

/**
 * Whether `message` (a `gh` failure's stderr) is GitHub refusing on rate-limit grounds, and what
 * it asked us to wait. `undefined` for every other failure, which callers must keep treating as an
 * ordinary error: backing off on a network blip would be as wrong as not backing off on a 403.
 */
export const detectRateLimit = (message: string): RateLimitSignal | undefined => {
  const text = message.toLowerCase();
  const after = retryAfter(text);
  if (SECONDARY.test(text))
    return after === undefined
      ? { kind: "secondary" }
      : { kind: "secondary", retryAfterSeconds: after };
  if (PRIMARY.test(text))
    return after === undefined
      ? { kind: "primary" }
      : { kind: "primary", retryAfterSeconds: after };
  return undefined;
};

/**
 * `detectRateLimit` for a failed run's two streams. Only stderr is read as prose: `gh api graphql`
 * exits non-zero on a partial error while still printing the data it got, so its stdout carries PR
 * titles, bodies and review comments, and a PR called "back off when the rate limit is exceeded"
 * backed the whole sweep off. Stdout counts only for the structured refusal GitHub itself writes,
 * read from the body alone: `gh api --include` puts a couple of KiB of headers ahead of it.
 */
export const detectRateLimitOutput = (output: {
  readonly stderr: string;
  readonly stdout: string;
}): RateLimitSignal | undefined =>
  detectRateLimit(output.stderr) ??
  (graphqlRefused(splitGhInclude(output.stdout).body) ? { kind: "primary" } : undefined);

/** First rung of the backoff ramp: the un-jittered delay after a single rate-limited call. */
export const BACKOFF_BASE_MS = 60_000;

/**
 * Hard floor, below which jitter may not pull a delay. Deliberately under `BACKOFF_BASE_MS` —
 * clamping at the base instead would erase the spread on the first failure, which is the one case
 * where every checkout of a rate-limited sweep is waiting together.
 */
export const BACKOFF_MIN_MS = 45_000;

/**
 * Ceiling of the backoff ramp. A primary limit can persist for up to an hour, but we re-probe at
 * this cap rather than sleeping blind for one: the quota may have been freed by another client.
 */
export const BACKOFF_MAX_MS = 900_000;

/**
 * How long to wait after `consecutive` successive rate-limited attempts (1 for the first).
 *
 * `Retry-After` wins outright when GitHub sent one. Otherwise the delay doubles per attempt from
 * `BACKOFF_BASE_MS`, capped at `BACKOFF_MAX_MS`, and a secondary limit starts one rung higher
 * because sustained rates are what triggered it. `jitter` in [0, 1) — supply `Math.random()`;
 * it spreads the delay over ±25% so that many checkouts rate-limited by one sweep don't retry in
 * lockstep and re-trip the limiter.
 *
 * This is a delay, not a schedule: it says nothing about how often the caller polls when healthy.
 * A caller whose base cadence is longer than `BACKOFF_BASE_MS` MUST floor the result at that
 * cadence — `Retry-After` included — or the first rung speeds it up instead of slowing it down. A
 * five-minute poller backing off to 60 s would hit GitHub five times more often while refused.
 */
export const backoffDelayMs = (
  consecutive: number,
  options: { readonly signal?: RateLimitSignal; readonly jitter?: number } = {},
): number => {
  const { signal, jitter = 0.5 } = options;
  if (signal?.retryAfterSeconds !== undefined) return signal.retryAfterSeconds * 1000;
  const rungs = Math.max(0, consecutive - 1) + (signal?.kind === "secondary" ? 1 : 0);
  const capped = Math.min(BACKOFF_BASE_MS * 2 ** rungs, BACKOFF_MAX_MS);
  const spread = capped * 0.25 * (jitter * 2 - 1);
  return Math.max(BACKOFF_MIN_MS, Math.round(capped + spread));
};
