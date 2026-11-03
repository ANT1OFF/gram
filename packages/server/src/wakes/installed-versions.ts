/**
 * The installed versions a `versionChanged` wake waits on: Gram's own, as the running app reports
 * it, and each CLI's, as Gram's launch checks last found it on the login-shell PATH. It starts no
 * probe of its own: a CLI's version is read off the launch checks' runs (at start, on the user's
 * Re-check, after a CLI update from Settings), and Gram's changes only with a restart into a new
 * build.
 */
import type { LaunchChecks, VersionTarget } from "@gram/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Stream from "effect/Stream";
import { ServerConfig } from "../config.ts";
import { LaunchChecksCache } from "../launch-checks/handler.ts";

export interface InstalledVersionsShape {
  /**
   * The installed version, as last seen; `undefined` when it isn't known (a dev build, a CLI not
   * found, no launch check finished yet). Never starts a probe.
   */
  readonly current: (target: VersionTarget) => Effect.Effect<string | undefined>;
  /**
   * As `current`, for setting a wake: when no launch check has run yet, it waits for the one run
   * the cache makes on first request, which `app.launchChecks` would start anyway.
   */
  readonly baseline: (target: VersionTarget) => Effect.Effect<string | undefined>;
  /** An element whenever a CLI's version may have changed: each launch check run. */
  readonly changes: Stream.Stream<unknown>;
}

export class InstalledVersions extends Context.Service<InstalledVersions, InstalledVersionsShape>()(
  "@gram/server/InstalledVersions",
) {}

const versionIn = (checks: LaunchChecks | undefined, target: VersionTarget) =>
  checks?.tools.find((tool) => tool.tool === target && tool.found)?.version;

export const InstalledVersionsLive = Layer.effect(
  InstalledVersions,
  Effect.gen(function* () {
    const { appVersion } = yield* ServerConfig;
    const checks = yield* LaunchChecksCache;
    const current: InstalledVersionsShape["current"] = (target) =>
      target === "gram"
        ? Effect.succeed(appVersion)
        : checks.latest.pipe(Effect.map((latest) => versionIn(latest, target)));
    return InstalledVersions.of({
      current,
      baseline: (target) =>
        target === "gram"
          ? Effect.succeed(appVersion)
          : checks.latest.pipe(
              Effect.flatMap((latest) =>
                latest === undefined ? checks.get(false) : Effect.succeed(latest),
              ),
              Effect.map((latest) => versionIn(latest, target)),
            ),
      changes: checks.changes,
    });
  }),
);
