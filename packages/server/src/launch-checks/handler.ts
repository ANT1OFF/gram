import { homedir } from "node:os";
import { claudeSdkExecutable, nodeFs, pathCandidates, resolveBinary } from "@gram/agents/claude";
import { canonicalizeOrOwned, findOnPath, PathProbe, Proc } from "@gram/git";
import type { LaunchChecks } from "@gram/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { codexGatewayInheritance } from "../gateway/codex-home.ts";
import { ServerConfig } from "../config.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { AgentHosts } from "../runtime/agent-hosts.ts";
import type { Handlers } from "../rpc/handlers/common.ts";
import {
  agentsInUseOf,
  localAgentsInUseOf,
  makeLaunchChecksCache,
  type LaunchProbe,
} from "./checks.ts";

const CHECK_TIMEOUT_MS = 10_000;

/** Looking binaries up on a PATH value, as the shell would; also used over fake binaries in tests. */
export const pathLookup: Pick<LaunchProbe, "which" | "whichAll" | "realpath"> = {
  which: (bin, pathValue) => findOnPath(bin, pathValue, process.platform),
  whichAll: (bin, pathValue) => {
    const separator = process.platform === "win32" ? ";" : ":";
    const found = pathValue
      .split(separator)
      .flatMap((dir) => findOnPath(bin, dir, process.platform) ?? []);
    return [...new Set(found)];
  },
  realpath: canonicalizeOrOwned,
};

/**
 * `get` with its runs observed: `latest` is the last result any caller got, and `changes` has each
 * new one. A cached run answers with the same object, so only a new run is a change.
 */
export const observeRuns = (cached: (refresh: boolean) => Effect.Effect<LaunchChecks>) =>
  Effect.gen(function* () {
    const runs = yield* PubSub.sliding<LaunchChecks>(1);
    let latest: LaunchChecks | undefined;
    const get = (refresh: boolean) =>
      cached(refresh).pipe(
        Effect.tap((checks) =>
          checks === latest
            ? Effect.void
            : Effect.sync(() => {
                latest = checks;
              }).pipe(Effect.andThen(PubSub.publish(runs, checks))),
        ),
      );
    return {
      get,
      latest: Effect.sync(() => latest),
      changes: Stream.fromPubSub(runs),
    };
  });

/**
 * The launch checks over the login-shell PATH the git runtime probes, run once when first asked and
 * shared: `app.launchChecks` shows them, an issue's diagnostics read the agent versions off them,
 * and a `versionChanged` wake reads a CLI's version off each run.
 */
export class LaunchChecksCache extends Context.Service<
  LaunchChecksCache,
  {
    readonly get: (refresh: boolean) => Effect.Effect<LaunchChecks>;
    /** The last run's result, without starting one; `undefined` before any has finished. */
    readonly latest: Effect.Effect<LaunchChecks | undefined>;
    /** Each run's result as it finishes. */
    readonly changes: Stream.Stream<LaunchChecks>;
  }
>()("@gram/server/LaunchChecksCache") {
  static readonly layer: Layer.Layer<LaunchChecksCache, never, Proc> = Layer.effect(
    LaunchChecksCache,
    Effect.gen(function* () {
      const proc = yield* Proc;
      const probe = yield* Effect.serviceOption(PathProbe);
      const live: LaunchProbe = {
        path: Option.isSome(probe)
          ? probe.value.path
          : Effect.sync(() => process.env["PATH"] ?? process.env["Path"] ?? ""),
        ...pathLookup,
        agentBinary: (agent, pathValue) =>
          resolveBinary(pathCandidates({ PATH: pathValue }, process.platform, agent), nodeFs).pipe(
            Effect.map((binary) => binary.path),
            Effect.orElseSucceed(() => undefined),
          ),
        claudeUnusable: (path) =>
          claudeSdkExecutable(path).pipe(
            Effect.match({ onSuccess: () => undefined, onFailure: (error) => error.message }),
          ),
        run: (file, args) => proc.run(file, args, { cwd: homedir(), timeoutMs: CHECK_TIMEOUT_MS }),
        now: () => Date.now(),
      };
      return yield* observeRuns(yield* makeLaunchChecksCache(live));
    }),
  );

  /**
   * For a headless server, whose agents and tools are its joined machines': nothing is looked up
   * or run on this machine, and every ask gets the same empty answer.
   */
  static readonly layerNone: Layer.Layer<LaunchChecksCache> = Layer.effect(
    LaunchChecksCache,
    Effect.suspend(() => {
      const none = NO_LAUNCH_CHECKS(Date.now());
      return observeRuns(() => Effect.succeed(none));
    }),
  );
}

/** The launch checks of a server that looks for nothing on its machine: no tool, no sign-in. */
export const NO_LAUNCH_CHECKS = (now: number): LaunchChecks => ({
  checkedAt: now,
  tools: [],
  claudeSignIn: "unknown",
  ghSignedIn: false,
  headless: true,
});

/** `app.launchChecks`. Nothing runs until asked. */
export const launchChecksHandlers = Effect.gen(function* () {
  const store = yield* ThreadStore;
  const { get } = yield* LaunchChecksCache;
  const { dataDir } = yield* ServerConfig;
  const hosts = yield* Effect.serviceOption(AgentHosts);
  const refreshModels = Option.isNone(hosts)
    ? Effect.void
    : Effect.forEach(
        ["claude", "codex"] as const,
        (agent) =>
          hosts.value.get(agent).pipe(
            Effect.flatMap((host) => host.reloadConfig?.(undefined) ?? Effect.void),
            Effect.orElseSucceed(() => undefined),
          ),
        { discard: true },
      );
  // Outside the cache, so changing the default or adding a thread counts at once.
  const agentsInUse = (checks: LaunchChecks) =>
    Effect.gen(function* () {
      const settings = yield* store.getSettings;
      const threads = yield* store.listThreads;
      return {
        agentsInUse: agentsInUseOf(settings, threads, checks),
        localAgentsInUse: localAgentsInUseOf(settings, threads, checks),
      };
    });

  return {
    "app.launchChecks": ({ refresh }) =>
      (refresh === true ? refreshModels : Effect.void).pipe(
        Effect.andThen(
          Effect.all([
            get(refresh === true).pipe(
              Effect.flatMap((checks) =>
                agentsInUse(checks).pipe(Effect.map((agents) => [checks, agents] as const)),
              ),
            ),
            codexGatewayInheritance(dataDir),
          ]).pipe(
            Effect.map(([[checks, agents], inherits]) => ({
              ...checks,
              ...agents,
              ...(inherits.skills.length === 0 && inherits.instructions === undefined
                ? {}
                : { codexGatewayInherits: inherits }),
            })),
          ),
        ),
      ),
  } satisfies Partial<Handlers>;
});
