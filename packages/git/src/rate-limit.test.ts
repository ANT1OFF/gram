import { describe, expect, it } from "vitest";
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  BACKOFF_MIN_MS,
  backoffDelayMs,
  detectRateLimit,
  detectRateLimitOutput,
} from "./rate-limit.ts";

describe("detectRateLimitOutput", () => {
  it("never reads what a PR says as what GitHub said", () => {
    const partial = JSON.stringify({
      data: {
        e0: { pullRequest: { number: 429, title: "Back off when the API rate limit is exceeded" } },
      },
      errors: [{ type: "NOT_FOUND", message: "Could not resolve to a Repository" }],
    });
    expect(
      detectRateLimitOutput({ stderr: "gh: Could not resolve to a Repository", stdout: partial }),
    ).toBeUndefined();
    const quoted = JSON.stringify({
      data: { e0: { pullRequest: { body: '"type":"RATE_LIMIT"' } } },
    });
    expect(detectRateLimitOutput({ stderr: "gh: not found", stdout: quoted })).toBeUndefined();
  });

  it("finds the refusal after any amount of partial data, and behind the response headers", () => {
    // A partial answer: `data` first, many KiB of review text, then the top-level errors.
    const partial = JSON.stringify({
      data: { e0: { pullRequest: { reviews: { nodes: [{ body: "x".repeat(20_000) }] } } } },
      errors: [{ type: "RATE_LIMIT", message: "refused" }],
    });
    expect(detectRateLimitOutput({ stderr: "gh: refused", stdout: partial })).toEqual({
      kind: "primary",
    });
    // As `gh api --include` prints it, with the header block ahead of the body.
    const headers = ["HTTP/2.0 200 OK", `X-Padding: ${"h".repeat(5_000)}`, "", ""].join("\r\n");
    expect(detectRateLimitOutput({ stderr: "", stdout: headers + partial })).toEqual({
      kind: "primary",
    });
  });

  it("reads only the top-level errors, never an error-shaped thing inside the data", () => {
    const nested = JSON.stringify({
      data: { e0: { errors: [{ type: "RATE_LIMIT" }], pullRequest: { type: "RATE_LIMIT" } } },
      errors: [{ type: "NOT_FOUND", message: "Could not resolve to a Repository" }],
    });
    expect(detectRateLimitOutput({ stderr: "gh: not found", stdout: nested })).toBeUndefined();
    expect(detectRateLimitOutput({ stderr: "", stdout: '"RATE_LIMIT"' })).toBeUndefined();
    expect(detectRateLimitOutput({ stderr: "", stdout: "" })).toBeUndefined();
  });

  it("still reads a refusal whose body the output cap cut short", () => {
    const cut = `{"errors":[{"type":"RATE_LIMIT","message":"refused"}],"data":{"e0":{"title":"${"x".repeat(100)}`;
    expect(detectRateLimitOutput({ stderr: "", stdout: cut })).toEqual({ kind: "primary" });
  });

  it("reads a refusal from stderr, or from the document's own error type", () => {
    const refused = '{"errors":[{"type":"RATE_LIMIT","code":"graphql_rate_limit","message":"x"}]}';
    expect(detectRateLimitOutput({ stderr: "", stdout: refused })).toEqual({ kind: "primary" });
    expect(
      detectRateLimitOutput({ stderr: "You have exceeded a secondary rate limit", stdout: "" }),
    ).toEqual({ kind: "secondary" });
  });
});

describe("detectRateLimit", () => {
  it("reads the primary limit off gh's own wording", () => {
    // The exact string gh prints for a GraphQL primary limit.
    expect(
      detectRateLimit("GraphQL: API rate limit already exceeded for user ID 196044779."),
    ).toEqual({
      kind: "primary",
    });
    expect(detectRateLimit("HTTP 429: Too Many Requests")).toEqual({ kind: "primary" });
    expect(detectRateLimit("x-ratelimit-remaining: 0")).toEqual({ kind: "primary" });
  });

  it("doesn't take a PR number for a status code", () => {
    expect(
      detectRateLimit("gh: Could not resolve to a PullRequest with the number of 429."),
    ).toBeUndefined();
    expect(detectRateLimit("gh: Too Many Requests (HTTP 429)")).toEqual({ kind: "primary" });
  });

  it("distinguishes the secondary limiter, which needs the harder backoff", () => {
    expect(detectRateLimit("You have exceeded a secondary rate limit")).toEqual({
      kind: "secondary",
    });
    expect(detectRateLimit("HTTP 403: triggered abuse detection")).toEqual({ kind: "secondary" });
  });

  it("prefers secondary when a message mentions both", () => {
    expect(
      detectRateLimit("API rate limit exceeded: you have hit a secondary rate limit")?.kind,
    ).toBe("secondary");
  });

  it("picks up Retry-After", () => {
    expect(detectRateLimit("secondary rate limit\nRetry-After: 120")).toEqual({
      kind: "secondary",
      retryAfterSeconds: 120,
    });
  });

  it("ignores a zero or malformed Retry-After rather than sleeping for none", () => {
    expect(detectRateLimit("secondary rate limit\nRetry-After: 0")).toEqual({ kind: "secondary" });
    expect(detectRateLimit("secondary rate limit\nRetry-After: soon")).toEqual({
      kind: "secondary",
    });
  });

  it("leaves every other failure alone", () => {
    expect(detectRateLimit("gh auth login required")).toBeUndefined();
    expect(detectRateLimit("could not resolve host: github.com")).toBeUndefined();
    expect(detectRateLimit("HTTP 404: Not Found")).toBeUndefined();
    expect(detectRateLimit("")).toBeUndefined();
  });
});

describe("backoffDelayMs", () => {
  const noJitter = { jitter: 0.5 };

  it("starts at the base delay and doubles per consecutive failure", () => {
    expect(backoffDelayMs(1, noJitter)).toBe(BACKOFF_BASE_MS);
    expect(backoffDelayMs(2, noJitter)).toBe(BACKOFF_BASE_MS * 2);
    expect(backoffDelayMs(3, noJitter)).toBe(BACKOFF_BASE_MS * 4);
  });

  it("starts a secondary limit one rung higher", () => {
    expect(backoffDelayMs(1, { ...noJitter, signal: { kind: "secondary" } })).toBe(
      BACKOFF_BASE_MS * 2,
    );
  });

  it("caps the ramp so we re-probe instead of sleeping blind", () => {
    expect(backoffDelayMs(50, noJitter)).toBe(BACKOFF_MAX_MS);
  });

  it("obeys Retry-After over the ramp, in both directions", () => {
    const signal = { kind: "secondary", retryAfterSeconds: 30 } as const;
    expect(backoffDelayMs(9, { ...noJitter, signal })).toBe(30_000);
  });

  it("spreads jittered delays within 25% but never below the floor", () => {
    const low = backoffDelayMs(3, { jitter: 0 });
    const high = backoffDelayMs(3, { jitter: 0.999 });
    expect(low).toBeLessThan(high);
    expect(low).toBeGreaterThanOrEqual(BACKOFF_MIN_MS);
    expect(high).toBeLessThanOrEqual(BACKOFF_BASE_MS * 4 * 1.25);
  });

  it("still spreads the FIRST failure, when every checkout is waiting together", () => {
    const delays = [0, 0.25, 0.75, 0.999].map((jitter) => backoffDelayMs(1, { jitter }));
    expect(new Set(delays).size).toBe(delays.length);
    for (const delay of delays) expect(delay).toBeGreaterThanOrEqual(BACKOFF_MIN_MS);
  });
});
