// What GitHub's own response headers say is left of an hour's allowance. GitHub's guidance is to pace
// from these rather than ask `GET /rate_limit`, and on at least one account that endpoint reported a
// full GraphQL allowance at the moment every GraphQL request was being refused with 5,000 of 5,000
// used. They come on every response, REST and GraphQL, a refusal included, which is exactly when the
// reset time matters. `gh api --include` prints them ahead of the body.

/** One response's account of the allowance it was counted against. */
export interface RateLimitReading {
  /** `x-ratelimit-resource`: `core`, `graphql`, `search`, … Each is an allowance of its own. */
  readonly resource: string;
  readonly limit: number;
  readonly remaining: number;
  readonly used: number;
  /** UTC epoch seconds at which the window resets. */
  readonly resetAt: number;
  /** `retry-after`, which GitHub sends with a secondary limit. */
  readonly retryAfterSeconds?: number;
}

const HEADER_BLOCK = /^HTTP\/[\d.]+ \d{3}[^\n]*\r?\n([\s\S]*?)\r?\n\r?\n/;

/**
 * `gh api --include` output as its header block and its body. Output that doesn't open with a status
 * line is all body: `gh` printed no headers (it failed before the request), or a test's `gh` never
 * prints any.
 */
export const splitGhInclude = (
  stdout: string,
): { readonly headers: string | undefined; readonly body: string } => {
  const match = HEADER_BLOCK.exec(stdout);
  return match === null
    ? { headers: undefined, body: stdout }
    : { headers: match[1] ?? "", body: stdout.slice(match[0].length) };
};

/**
 * The allowance a `gh api --include` run reported, or `undefined` when its output carries no rate
 * limit headers. Only the header block is read, never the body, so nothing a PR says can pass for it.
 */
export const parseRateLimitHeaders = (stdout: string): RateLimitReading | undefined => {
  const { headers } = splitGhInclude(stdout);
  if (headers === undefined) return undefined;
  const values = new Map<string, string>();
  for (const line of headers.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon > 0)
      values.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  const int = (name: string): number | undefined => {
    const value = values.get(name);
    if (value === undefined || !/^\d+$/.test(value)) return undefined;
    return Number.parseInt(value, 10);
  };
  const resource = values.get("x-ratelimit-resource");
  const limit = int("x-ratelimit-limit");
  const remaining = int("x-ratelimit-remaining");
  const resetAt = int("x-ratelimit-reset");
  if (resource === undefined || resource === "" || limit === undefined) return undefined;
  if (remaining === undefined || resetAt === undefined) return undefined;
  const retryAfterSeconds = int("retry-after");
  return {
    resource,
    limit,
    remaining,
    used: int("x-ratelimit-used") ?? Math.max(0, limit - remaining),
    resetAt,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  };
};
