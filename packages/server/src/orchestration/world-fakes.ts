// The outside world's services as a test's `World` has them: GitHub's branches, CI and
// auto-merges, the machine, releases, event looks, installed versions and verify records.
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { AutoMerges } from "../git/auto-merges.ts";
import { RoutineEventSources } from "../routines/events.ts";
import { VerifyStatus } from "../verify/verify-tools.ts";
import { BranchHeads } from "../wakes/branch-heads.ts";
import { CiJobs } from "../wakes/ci-stuck.ts";
import { InstalledVersions } from "../wakes/installed-versions.ts";
import { MachineState } from "../wakes/machine.ts";
import { UpstreamReleases } from "../wakes/upstream-releases.ts";
import type { World } from "./test-harness.ts";

/** GitHub's branches as `world` has them. */
export const fakeBranchHeads = (world: World) =>
  Layer.succeed(BranchHeads, {
    defaultBranch: (_cwd, repo) => Effect.sync(() => world.defaultBranches.get(repo.toLowerCase())),
    head: (_cwd, repo, branch) =>
      Effect.sync(() => world.branchHeads.get(`${repo.toLowerCase()}#${branch}`)),
  });

/** GitHub's CI as `world` has it. */
export const fakeCiJobs = (world: World) =>
  Layer.succeed(CiJobs, {
    pr: (_cwd, repo, number) =>
      Effect.sync(() => world.ciStates.get(`${repo.toLowerCase()}#${number}`) ?? undefined),
    run: (_cwd, repo, runId) =>
      Effect.sync(() => world.ciStates.get(`${repo.toLowerCase()}@${runId}`)),
  });

/** This machine as `world` has it. */
export const fakeMachine = (world: World) =>
  Layer.succeed(MachineState, {
    loadAverages: Effect.sync(() => world.machineLoad),
    cpus: 8,
    disk: (path) => Effect.sync(() => world.diskSpace.get(path) ?? world.diskSpace.get("*")),
  });

/** The head of PR `number` in the fake GitHub's auto-merges, unless `autoMergePrHeads` moved it. */
export const autoMergeHead = (number: number) => String(number).padStart(40, "0");

/** GitHub's auto-merges and the checkouts' origins as `world` has them; each change is recorded. */
export const fakeAutoMerges = (world: World) => {
  const headNow = (repo: string, number: number) =>
    world.autoMergePrHeads.get(`${repo.toLowerCase()}#${number}`) ?? autoMergeHead(number);
  return Layer.succeed(AutoMerges, {
    repoOf: (cwd) => Effect.sync(() => world.originRepos.get(cwd)),
    armed: (_cwd, repo, base) =>
      Effect.sync(() =>
        [...world.autoMerges].flatMap(([key, armed]) => {
          const [r, n] = key.split("#");
          return r === repo.toLowerCase() && armed.base === base
            ? [{ number: Number(n), method: armed.method, head: headNow(repo, Number(n)) }]
            : [];
        }),
      ),
    headOf: (_cwd, repo, number) =>
      Effect.sync(() => ({ open: true as const, head: headNow(repo, number) })),
    disable: (_cwd, repo, number) =>
      (world.autoMergeDisableGate?.(number) ?? Effect.void).pipe(
        Effect.andThen(
          Effect.sync(() => {
            world.autoMergeCalls.push(`disable ${repo}#${number}`);
            world.autoMerges.delete(`${repo.toLowerCase()}#${number}`);
            return undefined;
          }),
        ),
      ),
    enable: (_cwd, repo, number, method, head) =>
      Effect.sync(() => {
        if (head !== headNow(repo, number))
          return "Head branch was modified. Review and try again.";
        world.autoMergeCalls.push(`enable ${repo}#${number} ${method}`);
        world.autoMerges.set(`${repo.toLowerCase()}#${number}`, { base: "main", method, head });
        return undefined;
      }),
  });
};

/** npm's and GitHub's releases as `world` has them. */
export const fakeReleases = (world: World) =>
  Layer.succeed(UpstreamReleases, {
    list: (source, name) =>
      Effect.sync(() => {
        const key = `${source}:${name}`;
        world.releaseReads.push(key);
        return world.releases.get(key);
      }),
  });

/** What event routines' looks find, as `world` has it. */
export const fakeRoutineEvents = (world: World) =>
  Layer.succeed(RoutineEventSources, {
    look: (on, context) =>
      Effect.suspend(() => {
        world.eventLooks.push(`${on.event} ${context.baseline ?? "-"}`);
        const found = world.routineEvents.get(on.event);
        return typeof found === "function" ? found(context) : Effect.succeed(found);
      }),
  });

/** Gram's and the CLIs' versions as `world` has them. */
export const fakeInstalled = (world: World) =>
  Layer.succeed(InstalledVersions, {
    current: (target) => Effect.sync(() => world.installed.get(target)),
    baseline: (target) => Effect.sync(() => world.installed.get(target)),
    changes: Stream.fromPubSub(world.installedChanged),
  });

/** What Gram recorded of a worker's verify drivers, as `world` has it. */
export const fakeVerifyStatus = (world: World) =>
  Layer.succeed(VerifyStatus)({
    requiredOnHead: () => Effect.sync(() => world.verifyRequired),
  });
