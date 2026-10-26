import { describe, expect, it } from "@effect/vitest";
import type { ProcOutput, ProcShape } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { asBackground, GhBudget } from "./budget.ts";
import {
  RateLimitMonitor,
  resourceOf,
  scopeOf,
  withRateLimitMonitor,
} from "./rate-limit-monitor.ts";

const layers = Layer.mergeAll(RateLimitMonitor.layer, GhBudget.layer);

/** `gh api --include` output reporting `remaining` of 5,000 GraphQL points, resetting in `inSeconds`. */
const included = (remaining: number, inSeconds: number, body = "{}") =>
  [
    "HTTP/2.0 200 OK",
    "X-Ratelimit-Limit: 5000",
    `X-Ratelimit-Remaining: ${remaining}`,
    `X-Ratelimit-Reset: ${inSeconds}`,
    "X-Ratelimit-Resource: graphql",
    "",
    body,
  ].join("\r\n");

/** A `gh` that counts its runs and answers whatever `next.current` holds. */
const countingProc = (next: { current: ProcOutput }) => {
  const runs: Array<ReadonlyArray<string>> = [];
  const proc: ProcShape = {
    run: (_bin, args) =>
      Effect.sync(() => {
        runs.push(args);
        return next.current;
      }),
  };
  return { proc, runs };
};

const GRAPHQL = ["api", "graphql", "-f", "query={}", "--include"] as const;

const output = (overrides: Partial<ProcOutput> = {}): ProcOutput => ({
  status: 1,
  stdout: "",
  stderr: "",
  truncated: false,
  ...overrides,
});

const procReturning = (result: ProcOutput): ProcShape => ({ run: () => Effect.succeed(result) });

describe("scopeOf", () => {
  it("separates the search allowance from everything else", () => {
    expect(scopeOf("gh", ["search", "prs"])).toBe("search");
    expect(scopeOf("/usr/bin/gh", ["search", "prs"])).toBe("search");
    expect(scopeOf("gh.exe", ["search", "prs"])).toBe("search");
    expect(scopeOf("gh", ["api", "graphql"])).toBe("core");
    expect(scopeOf("git", ["fetch"])).toBe("core");
  });
});

describe("withRateLimitMonitor", () => {
  it.effect("ignores a clean run and an ordinary failure", () =>
    Effect.gen(function* () {
      const monitor = yield* RateLimitMonitor;
      const clean = withRateLimitMonitor(
        procReturning(output({ status: 0, stdout: "{}" })),
        monitor,
        yield* GhBudget,
      );
      yield* clean.run("gh", ["api", "graphql"], { cwd: "/repo" });
      const failing = withRateLimitMonitor(
        procReturning(output({ stderr: "fatal: not a git repository" })),
        monitor,
        yield* GhBudget,
      );
      yield* failing.run("git", ["status"], { cwd: "/repo" });
      expect((yield* monitor.observed("core")).count).toBe(0);
    }).pipe(Effect.provide(layers)),
  );

  it.effect("ignores rate-limit words in the data a partly failed document still printed", () =>
    Effect.gen(function* () {
      const monitor = yield* RateLimitMonitor;
      const proc = withRateLimitMonitor(
        procReturning(
          output({
            stderr: "gh: Could not resolve to a Repository with the name 'acme/gone'.",
            stdout:
              '{"data":{"e0":{"pullRequest":{"number":429,"title":"API rate limit exceeded"}}}}',
          }),
        ),
        monitor,
        yield* GhBudget,
      );
      yield* proc.run("gh", ["api", "graphql"], { cwd: "/repo" });
      expect((yield* monitor.observed("core")).count).toBe(0);
    }).pipe(Effect.provide(layers)),
  );

  it.effect("counts a primary limit against the allowance the command spent", () =>
    Effect.gen(function* () {
      const monitor = yield* RateLimitMonitor;
      const proc = withRateLimitMonitor(
        procReturning(output({ stderr: "API rate limit exceeded for user ID 1." })),
        monitor,
        yield* GhBudget,
      );
      yield* proc.run("gh", ["search", "prs"], { cwd: "/repo" });
      expect((yield* monitor.observed("search")).count).toBe(1);
      // The badge sweep spends a different allowance, so a spent search budget mustn't slow it.
      expect((yield* monitor.observed("core")).count).toBe(0);
    }).pipe(Effect.provide(layers)),
  );

  it.effect("makes everything yield to a secondary limit, and keeps Retry-After", () =>
    Effect.gen(function* () {
      const monitor = yield* RateLimitMonitor;
      const proc = withRateLimitMonitor(
        procReturning(
          output({
            stderr: "You have exceeded a secondary rate limit. Retry-After: 42",
          }),
        ),
        monitor,
        yield* GhBudget,
      );
      yield* proc.run("gh", ["search", "prs"], { cwd: "/repo" });
      for (const scope of ["core", "search"] as const) {
        const observed = yield* monitor.observed(scope);
        expect(observed.count).toBe(1);
        expect(observed.signal).toStrictEqual({ kind: "secondary", retryAfterSeconds: 42 });
      }
    }).pipe(Effect.provide(layers)),
  );

  it.effect("doesn't start a run GitHub would refuse, and asks again after the reset", () =>
    Effect.gen(function* () {
      const monitor = yield* RateLimitMonitor;
      const next = {
        current: output({
          stdout: included(0, 600, '{"errors":[{"type":"RATE_LIMIT"}]}'),
          stderr: "gh: API rate limit already exceeded for user ID 1.",
        }),
      };
      const { proc, runs } = countingProc(next);
      const metered = withRateLimitMonitor(proc, monitor, yield* GhBudget);

      yield* metered.run("gh", GRAPHQL, { cwd: "/repo" });
      expect(runs).toHaveLength(1);
      expect((yield* monitor.observed("core")).count).toBe(1);

      // Refused once, with the reset time in the headers: nothing asks again before it, not even
      // what the user clicks, and what was never sent isn't counted as a refusal.
      const held = yield* metered.run("gh", ["pr", "view", "7"], { cwd: "/repo" });
      expect(held.status).toBe(1);
      expect(held.stderr).toContain("API rate limit exceeded");
      expect(runs).toHaveLength(1);
      expect((yield* monitor.observed("core")).count).toBe(1);
      // Another allowance is another matter.
      yield* metered.run("gh", ["pr", "diff", "7"], { cwd: "/repo" });
      expect(runs).toHaveLength(2);

      next.current = output({ status: 0, stdout: included(4999, 4200) });
      yield* TestClock.adjust(Duration.seconds(603));
      expect((yield* metered.run("gh", GRAPHQL, { cwd: "/repo" })).status).toBe(0);
      expect(runs).toHaveLength(3);
    }).pipe(Effect.provide(layers)),
  );

  it.effect("keeps the last tenth from background work, never from the user", () =>
    Effect.gen(function* () {
      const next = { current: output({ status: 0, stdout: included(480, 1800) }) };
      const { proc, runs } = countingProc(next);
      const metered = withRateLimitMonitor(proc, yield* RateLimitMonitor, yield* GhBudget);
      yield* metered.run("gh", GRAPHQL, { cwd: "/repo" });

      const background = yield* asBackground(metered.run("gh", GRAPHQL, { cwd: "/repo" }));
      expect(background.status).toBe(1);
      expect(background.stderr).toContain("holding the last of the GitHub quota");
      // Not a rate limit, so no poller backs off from it.
      expect((yield* (yield* RateLimitMonitor).observed("core")).count).toBe(0);
      expect(runs).toHaveLength(1);

      expect((yield* metered.run("gh", GRAPHQL, { cwd: "/repo" })).status).toBe(0);
      expect(runs).toHaveLength(2);
    }).pipe(Effect.provide(layers)),
  );

  it.effect(
    "holds a limit seen without headers for a minute, and a secondary one for everyone",
    () =>
      Effect.gen(function* () {
        const next = {
          current: output({ stderr: "GraphQL: API rate limit already exceeded for user ID 1." }),
        };
        const { proc, runs } = countingProc(next);
        const metered = withRateLimitMonitor(proc, yield* RateLimitMonitor, yield* GhBudget);

        yield* metered.run("gh", ["pr", "view", "7"], { cwd: "/repo" });
        yield* metered.run("gh", ["pr", "view", "7"], { cwd: "/repo" });
        expect(runs).toHaveLength(1);
        yield* TestClock.adjust(Duration.seconds(63));

        next.current = output({
          stderr: "You have exceeded a secondary rate limit. Retry-After: 42",
        });
        yield* metered.run("gh", ["pr", "view", "7"], { cwd: "/repo" });
        expect(runs).toHaveLength(2);
        yield* metered.run("gh", ["search", "prs"], { cwd: "/repo" });
        yield* metered.run("gh", ["pr", "diff", "7"], { cwd: "/repo" });
        expect(runs).toHaveLength(2);
        // `git` isn't the API, and `rate_limit` is exempt from the limits it reports.
        yield* metered.run("git", ["fetch"], { cwd: "/repo" });
        yield* metered.run("gh", ["api", "rate_limit"], { cwd: "/repo" });
        expect(runs).toHaveLength(4);

        yield* TestClock.adjust(Duration.seconds(43));
        yield* metered.run("gh", ["search", "prs"], { cwd: "/repo" });
        expect(runs).toHaveLength(5);
      }).pipe(Effect.provide(layers)),
  );
});

describe("resourceOf", () => {
  it("names the allowance a command spends, and none for what GitHub doesn't meter", () => {
    expect(resourceOf("gh", ["api", "graphql"])).toBe("graphql");
    expect(resourceOf("gh", ["pr", "view", "7"])).toBe("graphql");
    expect(resourceOf("gh", ["pr", "diff", "7"])).toBe("core");
    expect(resourceOf("gh", ["api", "repos/acme/web/issues/1/comments"])).toBe("core");
    expect(resourceOf("/usr/local/bin/gh", ["search", "prs"])).toBe("search");
    expect(resourceOf("gh", ["api", "rate_limit"])).toBeUndefined();
    expect(resourceOf("gh", ["auth", "status"])).toBeUndefined();
    expect(resourceOf("git", ["fetch"])).toBeUndefined();
  });
});
