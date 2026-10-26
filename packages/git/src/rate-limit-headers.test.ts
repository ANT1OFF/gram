import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ghApi } from "./exec.ts";
import { Proc, type ProcShape } from "./proc.ts";
import { parseRateLimitHeaders, splitGhInclude } from "./rate-limit-headers.ts";

// As `gh api --include` prints a response: CRLF header lines, a blank line, the body.
const included = (headers: ReadonlyArray<string>, body: string, status = "200 OK") =>
  [`HTTP/2.0 ${status}`, ...headers, "", body].join("\r\n");

const GRAPHQL = [
  "Content-Type: application/json; charset=utf-8",
  "X-Ratelimit-Limit: 5000",
  "X-Ratelimit-Remaining: 1736",
  "X-Ratelimit-Reset: 1790026838",
  "X-Ratelimit-Resource: graphql",
  "X-Ratelimit-Used: 3264",
];

describe("splitGhInclude", () => {
  it("takes the header block off the body", () => {
    const { headers, body } = splitGhInclude(included(GRAPHQL, '{"data":{}}'));
    expect(headers).toContain("X-Ratelimit-Resource: graphql");
    expect(body).toBe('{"data":{}}');
  });

  it("leaves output without a status line alone", () => {
    expect(splitGhInclude('{"data":{}}')).toEqual({ headers: undefined, body: '{"data":{}}' });
    expect(splitGhInclude("")).toEqual({ headers: undefined, body: "" });
  });
});

describe("parseRateLimitHeaders", () => {
  it("reads the allowance the response was counted against", () => {
    expect(parseRateLimitHeaders(included(GRAPHQL, "{}"))).toEqual({
      resource: "graphql",
      limit: 5000,
      remaining: 1736,
      used: 3264,
      resetAt: 1790026838,
    });
  });

  it("reads a refusal, which is when the reset time matters", () => {
    const refused = included(
      [
        "X-Ratelimit-Limit: 5000",
        "X-Ratelimit-Remaining: 0",
        "X-Ratelimit-Reset: 1790023210",
        "X-Ratelimit-Resource: graphql",
        "Retry-After: 60",
      ],
      '{"errors":[{"type":"RATE_LIMIT"}]}',
    );
    expect(parseRateLimitHeaders(refused)).toEqual({
      resource: "graphql",
      limit: 5000,
      remaining: 0,
      used: 5000,
      resetAt: 1790023210,
      retryAfterSeconds: 60,
    });
  });

  it("never reads the body, whatever it says", () => {
    const body =
      "X-Ratelimit-Limit: 1\r\nX-Ratelimit-Remaining: 0\r\nX-Ratelimit-Reset: 1\r\nX-Ratelimit-Resource: graphql";
    expect(parseRateLimitHeaders(body)).toBeUndefined();
    expect(parseRateLimitHeaders(included(["Content-Type: text/plain"], body))).toBeUndefined();
  });
});

describe("ghApi", () => {
  it.effect("asks for the headers last, and hands the caller the body alone", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = [];
      const proc: ProcShape = {
        run: (_bin, args) =>
          Effect.sync(() => {
            calls.push(args);
            return {
              status: 0,
              stdout: included(GRAPHQL, '{"data":1}'),
              stderr: "",
              truncated: false,
            };
          }),
      };
      const out = yield* ghApi("/repo", ["graphql", "-f", "query={}"]).pipe(
        Effect.provideService(Proc, proc),
      );
      expect(calls).toEqual([["api", "graphql", "-f", "query={}", "--include"]]);
      expect(out.stdout).toBe('{"data":1}');
    }),
  );
});
