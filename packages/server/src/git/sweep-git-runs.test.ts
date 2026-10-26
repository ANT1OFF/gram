import * as nodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { PrLive, Proc, ProcLive } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RuntimeTestLayer } from "../runtime/test-harness.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { gitPlatformTest } from "./platform.ts";
import { GitStatePublisher, GitStatePublisherLive, WORK_ELSEWHERE_SWEEPS } from "./publisher.ts";
import { eventually, hasGit, makeRepo, removeDir, run, tempDir } from "./test-repo.ts";
import { testTools } from "./test-tools.ts";

// What one sweep costs in `git` runs, through the real PR lookup with a `gh` that finds no PRs. The
// idle server's processes were mostly these, re-asking every 15 s what rarely changes.

/** Every `git` command line the platform runs while a test collects them. */
const gitRuns: Array<string> = [];

/** Real git, counted; `gh api graphql` answers that no branch has a PR. */
const CountingProc = Layer.effect(
  Proc,
  Effect.map(Effect.service(Proc), (proc) =>
    Proc.of({
      run: (bin, args, options) =>
        Effect.suspend(() => {
          if (bin === "gh") {
            const data: Record<string, unknown> = {};
            for (const arg of args) {
              const match = /^b(\d+)=/.exec(arg);
              if (match !== null) data[`e${match[1]}`] = { pullRequests: { nodes: [] } };
            }
            return Effect.succeed({
              status: 0,
              stdout: JSON.stringify({ data }),
              stderr: "",
              truncated: false,
            });
          }
          gitRuns.push(args.join(" "));
          return proc.run(bin, args, options);
        }),
    }),
  ),
).pipe(Layer.provide(ProcLive));

const layer = GitStatePublisherLive.pipe(
  Layer.provideMerge(RuntimeTestLayer),
  Layer.provideMerge(
    gitPlatformTest({
      pr: PrLive,
      proc: CountingProc,
      tools: testTools({ git: true, gh: "ready", claude: false }),
    }),
  ),
);

/** `runs` tallied by command line, paths and hashes left in. */
const tally = (runs: ReadonlyArray<string>) =>
  Object.fromEntries(
    [...Map.groupBy(runs, (line) => line)]
      .map(([line, all]) => [line, all.length] as const)
      .toSorted((a, b) => b[1] - a[1]),
  );

describe.skipIf(!hasGit)("the sweep's git runs", () => {
  const dirs: Array<string> = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) removeDir(dir);
  });

  it.live(
    "asks each checkout's roots and origin once, its PR inputs in one run, other worktrees every few sweeps",
    () =>
      Effect.gen(function* () {
        const dir = tempDir();
        dirs.push(dir);
        const root = makeRepo(dir);
        run(root, "remote", "add", "origin", "git@github.com:acme/web.git");
        // The background fetch fails at once and offline, while the origin still reads as GitHub.
        const nowhere = `${nodePath.join(dir, "no-remote").replaceAll("\\", "/")}/`;
        run(root, "config", `url.${nowhere}.insteadOf`, "git@github.com:");
        run(root, "update-ref", "refs/remotes/origin/main", "HEAD");
        const runtimes = yield* ThreadRuntimes;
        const publisher = yield* GitStatePublisher;
        // The main checkout and a worktree never pushed, two worktrees pushed with `-u`.
        const checkouts = [root];
        yield* runtimes.create({
          projectRoot: root,
          checkout: { kind: "main", path: root },
        });
        for (const branch of ["one", "two", "three"]) {
          const tree = nodePath.join(root, ".worktrees", branch);
          run(root, "worktree", "add", "-q", "-b", branch, tree);
          if (branch !== "three") {
            run(tree, "update-ref", `refs/remotes/origin/${branch}`, "HEAD");
            run(tree, "branch", "-q", `--set-upstream-to=origin/${branch}`);
          }
          checkouts.push(tree);
          yield* runtimes.create({
            projectRoot: root,
            checkout: { kind: "worktree", path: tree, branch, repoRoot: root },
          });
        }
        for (const path of checkouts) {
          yield* eventually("the first git.state", publisher.stateFor(path));
        }
        // The first sweep is a scan pass and reads everything; the next ones are what idling costs.
        yield* publisher.sweep;
        const sweeps: Array<ReadonlyArray<string>> = [];
        for (let i = 0; i < WORK_ELSEWHERE_SWEEPS; i++) {
          gitRuns.length = 0;
          yield* publisher.sweep;
          sweeps.push([...gitRuns]);
        }
        const all = sweeps.flat();
        const detail = JSON.stringify(sweeps.map(tally), null, 1);

        // Kept per checkout: not one read of the repo roots or the origin URL.
        expect(
          all.filter(
            (line) => line.includes("--git-common-dir") || line.includes("remote.origin.url"),
          ),
          detail,
        ).toEqual([]);
        // The PR inputs: one run per checkout and sweep, and the branch's name for the two never pushed.
        const inputs = all.filter((line) => line.startsWith("rev-parse --show-toplevel HEAD"));
        expect(inputs, detail).toHaveLength(checkouts.length * WORK_ELSEWHERE_SWEEPS);
        expect(
          all.filter((line) => line === "rev-parse --abbrev-ref HEAD"),
          detail,
        ).toHaveLength(2 * WORK_ELSEWHERE_SWEEPS);
        // The worktree list for the PR-elsewhere cue and the work-elsewhere scan: the scan pass only.
        expect(
          sweeps.map((runs) => runs.filter((line) => line.startsWith("worktree list")).length),
          detail,
        ).toEqual([0, 0, 0, 2]);
        // 214 runs (52 a sweep) before the roots and origin were kept, the PR inputs read in one run
        // and the cue's worktree list kept to the scan passes; 117 after. The slack is for a watcher.
        expect(all.length, detail).toBeLessThanOrEqual(140);
      }).pipe(Effect.provide(layer)),
    60_000,
  );
});
