import { describe, expect, it } from "@effect/vitest";
import type { AgentHost } from "@gram/agents";
import type { LaunchChecks, ProfileId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Layer from "effect/Layer";
import { AgentHosts } from "../runtime/agent-hosts.ts";
import { RuntimeTestLayer } from "../runtime/test-harness.ts";
import { LaunchChecksCache, launchChecksHandlers, observeRuns } from "./handler.ts";

/** A cache whose runs nothing here watches. */
const NO_RUNS = { latest: Effect.succeed(undefined), changes: Stream.empty };

const checks: LaunchChecks = {
  checkedAt: 1,
  tools: [
    { tool: "claude", found: true },
    { tool: "codex", found: true },
  ],
  claudeSignIn: "signedIn",
  codexSignIn: "signedIn",
  ghSignedIn: false,
};

describe("launch-check model refresh", () => {
  it.effect(
    "refreshes only local Claude/Codex hosts on explicit re-check, before returning diagnostics",
    () =>
      Effect.gen(function* () {
        const hosts = yield* AgentHosts;
        const base = yield* hosts.get("claude");
        const calls: Array<readonly [string, ProfileId | undefined]> = [];
        const cacheReads: boolean[] = [];
        const host = (kind: AgentHost["kind"]): AgentHost => ({
          ...base,
          kind,
          reloadConfig: (profileId) =>
            Effect.sync(() => {
              calls.push([kind, profileId]);
            }),
        });
        const handlers = yield* launchChecksHandlers.pipe(
          Effect.provide(
            Layer.succeed(AgentHosts, AgentHosts.fromHosts([host("claude"), host("codex")])),
          ),
          Effect.provide(
            Layer.succeed(LaunchChecksCache, {
              ...NO_RUNS,
              get: (refresh) =>
                Effect.sync(() => {
                  cacheReads.push(refresh);
                  if (refresh)
                    expect(calls).toEqual([
                      ["claude", undefined],
                      ["codex", undefined],
                    ]);
                  return checks;
                }),
            }),
          ),
        );
        yield* handlers["app.launchChecks"]({ refresh: false });
        expect(calls).toEqual([]);
        const result = yield* handlers["app.launchChecks"]({ refresh: true });
        expect(cacheReads).toEqual([false, true]);
        expect(result.codexSignIn).toBe("signedIn");
        expect(result.localAgentsInUse).toEqual(["claude"]);
      }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("missing primary adapters do not prevent a re-check", () =>
    Effect.gen(function* () {
      const handlers = yield* launchChecksHandlers.pipe(
        Effect.provide(AgentHosts.layerNone),
        Effect.provide(
          Layer.succeed(LaunchChecksCache, { ...NO_RUNS, get: () => Effect.succeed(checks) }),
        ),
      );
      expect((yield* handlers["app.launchChecks"]({ refresh: true })).codexSignIn).toBe("signedIn");
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("reads the agents in use off the checks it returns: Codex alone is Codex", () =>
    Effect.gen(function* () {
      const codexOnly: LaunchChecks = {
        ...checks,
        tools: [{ tool: "codex", found: true }],
        claudeSignIn: "unknown",
      };
      const handlers = yield* launchChecksHandlers.pipe(
        Effect.provide(AgentHosts.layerNone),
        Effect.provide(
          Layer.succeed(LaunchChecksCache, { ...NO_RUNS, get: () => Effect.succeed(codexOnly) }),
        ),
      );
      const result = yield* handlers["app.launchChecks"]({ refresh: false });
      expect(result.localAgentsInUse).toEqual(["codex"]);
      expect(result.agentsInUse).toEqual(["codex"]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );
});

describe("observed launch-check runs", () => {
  it.effect("keeps the latest result and tells each new run, not a cached answer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let run = 0;
        const results: Array<LaunchChecks> = [];
        const cached = (refresh: boolean) =>
          Effect.sync(() => {
            if (refresh || results.length === 0) results.push({ ...checks, checkedAt: ++run });
            return results.at(-1)!;
          });
        const observed = yield* observeRuns(cached);
        expect(yield* observed.latest).toBeUndefined();
        const told = yield* observed.changes.pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;
        yield* observed.get(false);
        yield* observed.get(false);
        yield* observed.get(true);
        expect((yield* observed.latest)?.checkedAt).toBe(2);
        const runs = yield* Fiber.join(told);
        expect(Array.from(runs, (each) => each.checkedAt)).toEqual([1, 2]);
      }),
    ),
  );
});
