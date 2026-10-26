import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { AgentRuntimeRpcs, type ThreadStatus } from "@gram/contracts";
import { Proc } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ThreadStore } from "../persistence/thread-store.ts";
import { AgentHosts } from "../runtime/agent-hosts.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { ManagedRuntimes } from "./service.ts";
import { LaunchChecksCache, pathLookup } from "../launch-checks/handler.ts";
import { logDefects, type Handlers } from "../rpc/handlers/common.ts";
import { makeCliUpdates } from "./cli-update.ts";
import { runtimeInstallHandlers } from "./install-handlers.ts";
import { NPM_PACKAGES } from "./policy.ts";
import { makeVendorReleases, npmView } from "./releases.ts";
import { resolveAgentRuntimes } from "./resolve.ts";

/** How long a listing waits for vendor releases before answering with what it has. */
const RELEASES_WAIT_MS = 3_000;

/** A thread in one of these has a session open, which keeps the CLI it started with. */
const LIVE: ReadonlySet<ThreadStatus> = new Set([
  "starting",
  "idle",
  "running",
  "needsApproval",
  "needsInput",
]);

/**
 * `agentRuntime.list`: the launch checks' view of each agent CLI, judged against the shipped
 * bindings, with the newest vendor release. Vendor metadata is read only when first asked, then at
 * most every six hours, or ten minutes on an explicit re-check.
 * `agentRuntime.{update,watchUpdate,cancelUpdate}` run a listed step on the user's own CLI.
 */
const agentRuntimeHandlers = Effect.gen(function* () {
  const checks = yield* LaunchChecksCache;
  const managed = Option.getOrUndefined(yield* Effect.serviceOption(ManagedRuntimes));
  const proc = yield* Proc;
  const store = Option.getOrUndefined(yield* Effect.serviceOption(ThreadStore));
  const threads = Option.getOrUndefined(yield* Effect.serviceOption(ThreadRuntimes));
  const hosts = Option.getOrUndefined(yield* Effect.serviceOption(AgentHosts));
  const releases = yield* makeVendorReleases({ npmView: npmView(proc, homedir()), now: Date.now });

  const list = (refresh: boolean | undefined) =>
    Effect.gen(function* () {
      const again = refresh === true;
      const [launch, vendor] = yield* Effect.all(
        [
          checks.get(again),
          // Settings shouldn't wait on a cold packument; it asks again while `checking`.
          releases.get(again, RELEASES_WAIT_MS),
        ],
        { concurrency: "unbounded" },
      );
      return yield* resolveAgentRuntimes({
        checks: launch,
        releases: vendor,
        platform: process.platform,
        now: Date.now(),
        realpath: pathLookup.realpath,
        npmPackageBeside: (agent, path) =>
          existsSync(join(dirname(path), "node_modules", NPM_PACKAGES[agent], "package.json")),
        writable: (path) => {
          try {
            accessSync(path, constants.W_OK);
            return true;
          } catch {
            return false;
          }
        },
        managed,
      });
    });

  const updates = yield* makeCliUpdates({
    runtime: (agent) =>
      list(false).pipe(Effect.map((all) => all.agents.find((row) => row.agent === agent))),
    run: (argv, onOutput) =>
      proc.run(argv[0]!, argv.slice(1), { cwd: homedir(), tier: "slow", onOutput }),
    reprobe: (agent) =>
      checks.get(true).pipe(Effect.map((c) => c.tools.find((t) => t.tool === agent)?.version)),
    runningThreads: (agent) =>
      store === undefined || threads === undefined
        ? Effect.succeed(0)
        : Effect.gen(function* () {
            const mine = (yield* store.listThreads).filter((t) => t.model.agent === agent);
            const statuses = yield* Effect.forEach(mine, (t) =>
              threads.status(t.id).pipe(Effect.orElseSucceed(() => "cold" as const)),
            );
            return statuses.filter((status) => LIVE.has(status)).length;
          }).pipe(Effect.orElseSucceed(() => 0)),
    updated: (agent) =>
      hosts === undefined
        ? Effect.void
        : hosts.get(agent).pipe(
            Effect.flatMap((host) => host.invalidateRuntime ?? Effect.void),
            Effect.ignore,
          ),
    now: Date.now,
  });

  return {
    "agentRuntime.list": ({ refresh }) => list(refresh),
    "agentRuntime.update": ({ agent, command }) => updates.start(agent, command),
    "agentRuntime.watchUpdate": ({ agent }) => updates.watch(agent),
    "agentRuntime.cancelUpdate": ({ agent }) => updates.cancel(agent),
  } satisfies Partial<Handlers>;
});

/** The agent runtime group's handler layer: which install runs, and the managed store's installs. */
export const AgentRuntimeHandlersLive = AgentRuntimeRpcs.toLayer(
  Effect.gen(function* () {
    const handlers = { ...(yield* agentRuntimeHandlers), ...(yield* runtimeInstallHandlers) };
    return AgentRuntimeRpcs.of(logDefects(AgentRuntimeRpcs, handlers));
  }),
);
