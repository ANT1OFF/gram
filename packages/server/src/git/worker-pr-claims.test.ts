import { describe, expect, it } from "@effect/vitest";
import { Proc, ProcSpawnError, ProcTimeout } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  completeTurn,
  makeWorld,
  openOrchestrator,
  spawn,
  withServer,
} from "../orchestration/test-harness.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { hasGit, run } from "./test-repo.ts";
import { OWNERSHIP_BLOCKERS, ownershipRefusal, workerPrOwnership } from "./worker-pr.ts";

describe.skipIf(!hasGit)("other threads' repository claims", () => {
  it.effect("refuses a slow ownership read before the approval hook can fall back to a card", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      yield* withServer(
        world,
        Effect.gen(function* () {
          const { session } = yield* openOrchestrator(world);
          const worker = yield* spawn(session, { feature: "slow-read" });
          yield* completeTurn(worker.session);
          const call = yield* Effect.forkScoped(
            ownershipRefusal(worker.thread, "acme/app", 12, {
              audience: "worker",
              tool: "merge_when_ready",
              action: "merges it",
            }).pipe(Effect.provideService(Proc, { run: () => Effect.never })),
          );
          yield* TestClock.adjust("4 seconds");
          expect(yield* Fiber.join(call)).toContain(
            "Gram couldn't read the worker's worktree or the pull request on GitHub",
          );
        }),
      );
    }).pipe(Effect.scoped),
  );

  for (const scenario of [
    "plain folder",
    "gone folder",
    "timeout",
    "git error",
    "held branch",
    "bound PR",
    "broken git dir",
    "unreadable HEAD",
  ] as const) {
    it.effect(
      `a sibling with a ${scenario} ${scenario === "plain folder" ? "claims no branch" : "still blocks ownership"}`,
      () =>
        Effect.gen(function* () {
          const world = yield* makeWorld;
          yield* withServer(
            world,
            Effect.gen(function* () {
              const store = yield* ThreadStore;
              const runtimes = yield* ThreadRuntimes;
              const { session } = yield* openOrchestrator(world);
              const worker = yield* spawn(session, { feature: "publisher" });
              const sibling = yield* spawn(session, { feature: "sibling" });
              yield* completeTurn(worker.session);
              yield* completeTurn(sibling.session);
              // Add the synthetic origin only after worktree creation, so setup cannot fetch it.
              run(world.repo, "remote", "add", "origin", "https://github.com/acme/app.git");
              const branch = worker.thread.checkout.branch!;
              const folder = join(dirname(world.repo), "plain");
              mkdirSync(folder);
              if (scenario === "broken git dir") mkdirSync(join(folder, ".git"));
              if (scenario === "unreadable HEAD") {
                run(folder, "init", "-q");
                writeFileSync(join(folder, ".git", "HEAD"), "broken\n");
              }
              const at = scenario === "held branch" ? sibling.thread.checkout.path : folder;
              if (scenario === "held branch")
                run(at, "checkout", "-q", "--ignore-other-worktrees", branch);
              yield* runtimes.updateThread(sibling.thread.id, (t) => ({
                ...t,
                // No recorded branch or repoRoot is not proof that a folder isn't a repository.
                checkout:
                  scenario === "gone folder"
                    ? { kind: "worktree", path: join(folder, "gone"), repoRoot: world.repo }
                    : { kind: "main", path: at },
                ...(scenario === "bound PR"
                  ? { boundPr: { repo: "acme/app", number: 12, monitor: false } }
                  : {}),
              }));
              const proc: Proc["Service"] = {
                run: (bin, args, options) => {
                  if (bin === "gh")
                    return Effect.succeed({
                      status: 0,
                      stderr: "",
                      truncated: false,
                      stdout: JSON.stringify({
                        number: 12,
                        url: "https://github.com/acme/app/pull/12",
                        headRefName: branch,
                        headRefOid: "h1",
                        state: "OPEN",
                        isCrossRepository: false,
                      }),
                    });
                  if (options.cwd === at && scenario === "timeout")
                    return Effect.fail(new ProcTimeout({ bin, message: "timed out" }));
                  if (options.cwd === at && scenario === "git error")
                    return Effect.fail(new ProcSpawnError({ bin, message: "failed" }));
                  return Effect.sync(() => {
                    const out = spawnSync(bin, args, {
                      cwd: options.cwd,
                      encoding: "utf8",
                      timeout: 2_000,
                      env: { ...process.env, ...options.env },
                    });
                    return {
                      status: out.status ?? -1,
                      stdout: out.stdout ?? "",
                      stderr: out.stderr ?? "",
                      truncated: false,
                    };
                  });
                },
              };
              const ownership = yield* workerPrOwnership(
                yield* store.getThread(worker.thread.id),
                "acme/app",
                12,
              ).pipe(Effect.provideService(Proc, proc));
              expect(ownership).toEqual(
                scenario === "plain folder"
                  ? { path: worker.thread.checkout.path, branch }
                  : OWNERSHIP_BLOCKERS.otherThread,
              );
            }),
          );
        }).pipe(Effect.scoped),
    );
  }
});

/** Real git, and `gh pr view` answering `pr` with `branch` as its head, from the repo itself. */
const ghAnswering = (pr: { readonly repo: string; readonly number: number }, branch: string) =>
  ({
    run: (bin, args, options) =>
      bin === "gh"
        ? Effect.succeed({
            status: 0,
            stderr: "",
            truncated: false,
            stdout: JSON.stringify({
              number: pr.number,
              url: `https://github.com/${pr.repo}/pull/${pr.number}`,
              headRefName: branch,
              headRefOid: "h1",
              state: "OPEN",
              isCrossRepository: false,
            }),
          })
        : Effect.sync(() => {
            const out = spawnSync(bin, args, {
              cwd: options.cwd,
              encoding: "utf8",
              timeout: 2_000,
              env: { ...process.env, ...options.env },
            });
            return {
              status: out.status ?? -1,
              stdout: out.stdout ?? "",
              stderr: out.stderr ?? "",
              truncated: false,
            };
          }),
  }) satisfies Proc["Service"];

describe.skipIf(!hasGit)("the origin a worker's ownership goes by", () => {
  it.effect("is the one Gram recorded, never the one the worker rewrites its config to", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      yield* withServer(
        world,
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const { session } = yield* openOrchestrator(world);
          const worker = yield* spawn(session, { feature: "forged" });
          yield* completeTurn(worker.session);
          const thread = yield* store.getThread(worker.thread.id);
          const branch = thread.checkout.branch!;
          // What a worker can do from its own worktree: point the repository's origin (one
          // config, shared with the main checkout) at another repository, and check out a branch
          // named as that repository's PR head.
          run(
            thread.checkout.path,
            "remote",
            "add",
            "origin",
            "https://github.com/elsewhere/other.git",
          );
          const outside = { repo: "elsewhere/other", number: 7 };
          expect(
            yield* workerPrOwnership(thread, outside.repo, outside.number).pipe(
              Effect.provideService(Proc, ghAnswering(outside, branch)),
            ),
          ).toBe(OWNERSHIP_BLOCKERS.repoNotInWorkspace);
          // Its own PR stays its own: the recorded origin still names it.
          const own = { repo: "acme/app", number: 12 };
          expect(
            yield* workerPrOwnership(thread, own.repo, own.number).pipe(
              Effect.provideService(Proc, ghAnswering(own, branch)),
            ),
          ).toEqual({ path: thread.checkout.path, branch });
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("owns nothing in a worktree made before it was recorded", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      yield* withServer(
        world,
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const runtimes = yield* ThreadRuntimes;
          const { session } = yield* openOrchestrator(world);
          const worker = yield* spawn(session, { feature: "legacy" });
          yield* completeTurn(worker.session);
          run(world.repo, "remote", "add", "origin", "https://github.com/acme/app.git");
          yield* runtimes.updateThread(worker.thread.id, (t) => {
            const { cloneIdentity: _recorded, ...checkout } = t.checkout;
            return { ...t, checkout };
          });
          const thread = yield* store.getThread(worker.thread.id);
          const own = { repo: "acme/app", number: 12 };
          expect(
            yield* workerPrOwnership(thread, own.repo, own.number).pipe(
              Effect.provideService(Proc, ghAnswering(own, thread.checkout.branch!)),
            ),
          ).toBe(OWNERSHIP_BLOCKERS.originUnrecorded);
        }),
      );
    }).pipe(Effect.scoped),
  );
});
