// Noticing that GitHub rate-limited us, wherever it happened. Every `git` and `gh` invocation goes
// through `Proc`, and the failures that matter here are swallowed deep inside the git package (a
// failed PR lookup becomes a stale badge), so a polling loop can't see them from its own call sites.
// Decorating `Proc` catches all of them, primary and secondary, with whatever `Retry-After` GitHub
// sent.

import {
  detectRateLimit,
  detectRateLimitOutput,
  parseRateLimitHeaders,
  Proc,
  type ProcOutput,
  type ProcShape,
  type RateLimitSignal,
} from "@gram/git";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { GhBudget, GhPriority, type Admission } from "./budget.ts";

/**
 * Which allowance ran out. GitHub meters `gh search` separately and far more tightly (~30/min), so
 * an exhausted search allowance must not slow the PR sweep down — but a *secondary* limit is the
 * abuse limiter complaining about our total rate, and everything has to yield to it.
 */
export type RateLimitScope = "core" | "search";

/** A monotonic count of rate-limited invocations in scope, and the most recent one's signal. */
export interface RateLimitObservation {
  readonly count: number;
  readonly signal: RateLimitSignal | undefined;
}

/** `gh search …`; everything else spends the core/GraphQL allowance. */
export const scopeOf = (bin: string, args: ReadonlyArray<string>): RateLimitScope =>
  bin
    .toLowerCase()
    .replace(/\.(exe|cmd|bat)$/, "")
    .endsWith("gh") && args[0] === "search"
    ? "search"
    : "core";

export class RateLimitMonitor extends Context.Service<
  RateLimitMonitor,
  {
    /**
     * Classifies a failed invocation, from its two streams or from a failure message. Anything
     * `detectRateLimit` doesn't recognise is ignored, so an ordinary `gh` failure never backs a
     * poller off.
     */
    readonly record: (
      scope: RateLimitScope,
      failure: string | { readonly stderr: string; readonly stdout: string },
    ) => Effect.Effect<void>;
    readonly observed: (scope: RateLimitScope) => Effect.Effect<RateLimitObservation>;
  }
>()("@gram/server/RateLimitMonitor") {
  static readonly layer = Layer.sync(RateLimitMonitor, () => {
    const counts: Record<RateLimitScope, number> = { core: 0, search: 0 };
    const signals: Record<RateLimitScope, RateLimitSignal | undefined> = {
      core: undefined,
      search: undefined,
    };
    return {
      record: (scope, failure) =>
        Effect.suspend(() => {
          const found =
            typeof failure === "string" ? detectRateLimit(failure) : detectRateLimitOutput(failure);
          if (found === undefined) return Effect.void;
          const hit: ReadonlyArray<RateLimitScope> =
            found.kind === "secondary" ? ["core", "search"] : [scope];
          for (const each of hit) {
            counts[each] += 1;
            signals[each] = found;
          }
          return Effect.logDebug("github rate-limited a command").pipe(
            Effect.annotateLogs({
              scope,
              kind: found.kind,
              ...(found.retryAfterSeconds === undefined
                ? {}
                : { retryAfterSeconds: found.retryAfterSeconds }),
            }),
          );
        }),
      observed: (scope) => Effect.sync(() => ({ count: counts[scope], signal: signals[scope] })),
    };
  });
}

/**
 * The GitHub allowance a command spends, or `undefined` when it spends none the app should meter:
 * `git` (its network runs aren't API calls), `gh auth`, and `rate_limit`, which GitHub exempts.
 * `gh`'s porcelain is GraphQL underneath but for the few commands listed as `core`.
 */
export const resourceOf = (bin: string, args: ReadonlyArray<string>): string | undefined => {
  if (
    !bin
      .toLowerCase()
      .replace(/\.(exe|cmd|bat)$/, "")
      .endsWith("gh")
  ) {
    return undefined;
  }
  const [command, sub] = args;
  switch (command) {
    case "search":
      return "search";
    case "api":
      return sub === "graphql" ? "graphql" : sub === "rate_limit" ? undefined : "core";
    case "pr":
      return sub === "diff" ? "core" : "graphql";
    case "repo":
    case "label":
      return "graphql";
    case "run":
    case "release":
      return "core";
    default:
      return undefined;
  }
};

const clock = (ms: number): string => new Date(ms).toTimeString().slice(0, 5);

/**
 * What a run that was never started reports. An exhausted allowance reads as the rate limit it is, so
 * every caller's existing handling applies; a reserved one must not, or pollers would back off from
 * a limit nobody hit.
 */
const heldOutput = (admission: Admission & { readonly allowed: false }): ProcOutput => ({
  status: 1,
  stdout: "",
  stderr:
    admission.reason === "exhausted"
      ? `API rate limit exceeded; GitHub resets it at ${clock(admission.resetAtMs)}, not asking before then`
      : `holding the last of the GitHub quota for other tools until ${clock(admission.resetAtMs)}`,
  truncated: false,
});

/** How long a primary limit seen without headers is held: until a run with headers says how long. */
const UNDATED_HOLD_SECONDS = 60;

/**
 * `proc` with every `gh` run metered. A run against an allowance GitHub is refusing, or one a
 * background caller would take into the reserve, isn't started at all. Every response's rate limit
 * headers go to the budget, and every non-zero exit is classified by the monitor. Output is only
 * pattern-matched, never logged: a command's stderr can quote a branch name or a search query.
 */
export const withRateLimitMonitor = (
  proc: ProcShape,
  monitor: RateLimitMonitor["Service"],
  budget: GhBudget["Service"],
): ProcShape => ({
  run: (bin, args, options) =>
    Effect.gen(function* () {
      const resource = resourceOf(bin, args);
      if (resource !== undefined) {
        const admission = yield* budget.admit(resource, yield* GhPriority);
        if (!admission.allowed) return heldOutput(admission);
      }

      const output = yield* proc.run(bin, args, options);
      const reading = resource === undefined ? undefined : parseRateLimitHeaders(output.stdout);
      if (reading !== undefined) yield* budget.observe(reading);
      if (output.status === 0) return output;

      const signal = resource === undefined ? undefined : detectRateLimitOutput(output);
      if (signal?.kind === "secondary") {
        yield* budget.hold(signal.retryAfterSeconds ?? reading?.retryAfterSeconds ?? 60);
      } else if (signal?.kind === "primary" && reading === undefined && resource !== undefined) {
        const nowSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1000);
        yield* budget.observe({
          resource,
          limit: 0,
          remaining: 0,
          used: 0,
          resetAt: nowSeconds + UNDATED_HOLD_SECONDS,
        });
      }
      yield* monitor.record(scopeOf(bin, args), output);
      return output;
    }),
});

/** `ProcLive` (or any `Proc` layer) with its runs metered against the budget. */
export const monitoredProc = (
  base: Layer.Layer<Proc>,
): Layer.Layer<Proc, never, RateLimitMonitor | GhBudget> =>
  Layer.effect(
    Proc,
    Effect.gen(function* () {
      return withRateLimitMonitor(yield* Proc, yield* RateLimitMonitor, yield* GhBudget);
    }),
  ).pipe(Layer.provide(base));
