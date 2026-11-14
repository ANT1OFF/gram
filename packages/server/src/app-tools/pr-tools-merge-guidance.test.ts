// merge_when_ready at full autonomy: what the agent can fix itself is refused to it with the fix,
// never put to the user; dropping an intent and a merged PR need neither ownership nor a card.
import { describe, expect, it } from "@effect/vitest";
import { HostId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { hasGit, run } from "../git/test-repo.ts";
import { cloneIdentityOf } from "../host/repos.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import {
  atAutonomy,
  completeTurn,
  makeWorld,
  openOrchestrator,
  publishGit,
  settle,
  spawn,
  waitReal,
  withServer,
} from "../orchestration/test-harness.ts";
import { armedWorkerBadge, badge } from "./pr-tools-kit.ts";
import { AppToolRegistry } from "./registry.ts";

/** The deploy PR a release script opened from a scratch worktree it then removed. */
const DEPLOY = "release/prod-6d5d5050";

describe("merge_when_ready guidance at full autonomy", () => {
  it.effect.skipIf(!hasGit)(
    "refuses a PR whose branch the worktree doesn't hold with the fix, then merges it once held",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const store = yield* ThreadStore;
            const registry = yield* AppToolRegistry;
            const { session, thread } = yield* openOrchestrator(world);
            const worker = yield* spawn(session, { feature: "release" });
            yield* completeTurn(worker.session);
            yield* atAutonomy(thread, "full");
            world.prHeads.set(21, { headRefName: DEPLOY });
            const merge = registry
              .forTransport(worker.thread.id, "worker")
              .find((t) => t.descriptor.name === "merge_when_ready")!;
            expect(yield* merge.delegatedAtFullAutonomy!({ pr: 21 })).toBe(false);
            const refused = yield* merge.run({ pr: 21 }).pipe(Effect.flip);
            expect(refused.message).toBe(
              `Full auto covers only a worker's own pull request: one whose head branch is checked out in the worktree Gram gave the worker. acme/app#21's head branch \`${DEPLOY}\` isn't checked out there. Check it out in the worktree Gram gave you (\`git fetch origin ${DEPLOY}\` then \`git switch ${DEPLOY}\`; commit your own work first), then call merge_when_ready again; Gram then merges it once its checks pass without asking. That holds only while no other thread has it as its pull request or holds its branch: checking out another thread's branch never makes it yours. The user wasn't asked, and their approval isn't the way through for this.`,
            );
            expect(yield* store.listRequests(worker.thread.id)).toEqual([]);
            expect((yield* store.getThread(worker.thread.id)).boundPr).toBeUndefined();

            // Following the fix: the branch checked out in its own worktree makes the PR its own.
            run(worker.thread.checkout.path, "switch", "-q", "-c", DEPLOY);
            expect(yield* merge.delegatedAtFullAutonomy!({ pr: 21 })).toBe(true);
            yield* merge.run({ pr: 21 });
            expect((yield* store.getThread(worker.thread.id)).boundPr).toMatchObject({
              number: 21,
              mergeWhenReady: { allowedBy: "autonomy" },
            });
            expect(yield* store.listRequests(worker.thread.id)).toEqual([]);
          }),
        );
      }).pipe(Effect.scoped),
  );

  for (const claim of ["bound", "held"] as const) {
    it.effect.skipIf(!hasGit)(
      `checking out a sibling's ${claim === "bound" ? "bound PR's branch" : "branch"} doesn't make it the worker's own`,
      () =>
        Effect.gen(function* () {
          const world = yield* makeWorld;
          yield* withServer(
            world,
            Effect.gen(function* () {
              const store = yield* ThreadStore;
              const runtimes = yield* ThreadRuntimes;
              const registry = yield* AppToolRegistry;
              const { session, thread } = yield* openOrchestrator(world);
              const worker = yield* spawn(session, { feature: "taker" });
              const sibling = yield* spawn(session, { feature: "owner" });
              yield* completeTurn(worker.session);
              yield* completeTurn(sibling.session);
              yield* atAutonomy(thread, "full");
              const theirs = sibling.thread.checkout.branch!;
              world.prHeads.set(30, { headRefName: theirs });
              if (claim === "bound") {
                // The sibling's PR, its branch since left in the sibling's worktree.
                yield* runtimes.updateThread(sibling.thread.id, (t) => ({
                  ...t,
                  boundPr: { repo: "acme/app", number: 30, monitor: false },
                }));
                run(sibling.thread.checkout.path, "switch", "-q", "--detach");
                run(worker.thread.checkout.path, "switch", "-q", theirs);
              } else {
                // Still checked out in the sibling's worktree; forced out here as well.
                run(
                  worker.thread.checkout.path,
                  "checkout",
                  "-q",
                  "--ignore-other-worktrees",
                  theirs,
                );
              }
              const merge = registry
                .forTransport(worker.thread.id, "worker")
                .find((t) => t.descriptor.name === "merge_when_ready")!;
              expect(yield* merge.delegatedAtFullAutonomy!({ pr: 30 })).toBe(false);
              const call = yield* Effect.forkScoped(merge.run({ pr: 30 }).pipe(Effect.flip));
              const card = yield* waitReal(
                "the approval card",
                store.listRequests(worker.thread.id).pipe(Effect.map((all) => all[0])),
              );
              if (card.kind !== "approval") throw new Error("not an approval");
              expect(card.autonomyNote).toBe(
                "full auto, PR ownership unverified: another thread has it as its pull request, or holds its branch in a worktree of its own, so it is that thread's work even where the worker has the branch checked out",
              );
              yield* runtimes.respond(worker.thread.id, card.id, {
                kind: "approval",
                decision: "deny",
                scope: "once",
              });
              expect((yield* Fiber.join(call)).message).toContain(
                "Leave it to the thread that holds it",
              );
              expect(world.ghCalls.filter((c) => c[2] === "merge")).toEqual([]);
            }),
          );
        }).pipe(Effect.scoped),
    );
  }

  for (const origin of [
    "https://github.com/acme/app.git",
    "https://github.com/elsewhere/other.git",
  ] as const) {
    const same = origin.includes("acme/app");
    it.effect.skipIf(!hasGit)(
      same
        ? "a branch a live worker holds on another machine stays that worker's"
        : "the same branch name in another repository on another machine claims nothing",
      () =>
        Effect.gen(function* () {
          const world = yield* makeWorld;
          const machine = HostId.make("m-0123456789abcdef01234567");
          const remoteBranch = "feat/remote-held";
          const remoteRoot = "/synthetic/clone";
          const remotePath = "/synthetic/worktree";
          world.joinedMachine = {
            id: machine,
            online: true,
            worktrees: new Map([[remotePath, { clone: remoteRoot, origin, branch: remoteBranch }]]),
          };
          yield* withServer(
            world,
            Effect.gen(function* () {
              const store = yield* ThreadStore;
              const runtimes = yield* ThreadRuntimes;
              const registry = yield* AppToolRegistry;
              const { session, thread } = yield* openOrchestrator(world);
              const worker = yield* spawn(session, { feature: "local-adopter" });
              const sibling = yield* spawn(session, { feature: "remote-holder" });
              yield* completeTurn(worker.session);
              yield* completeTurn(sibling.session);
              yield* atAutonomy(thread, "full");
              // The sibling only follows the PR, and holds its branch in its worktree there.
              yield* runtimes.updateThread(sibling.thread.id, (t) => ({
                ...t,
                extraPrs: [{ repo: "acme/app", number: 21, monitor: true }],
                checkout: {
                  kind: "worktree" as const,
                  path: remotePath,
                  repoRoot: remoteRoot,
                  branch: remoteBranch,
                  hostId: machine,
                  cloneIdentity: cloneIdentityOf(origin)!,
                },
              }));
              world.prHeads.set(21, { headRefName: remoteBranch });
              run(worker.thread.checkout.path, "switch", "-q", "-c", remoteBranch);
              const merge = registry
                .forTransport(worker.thread.id, "worker")
                .find((t) => t.descriptor.name === "merge_when_ready")!;
              expect(yield* merge.delegatedAtFullAutonomy!({ pr: 21 })).toBe(!same);
              if (!same) return;
              const call = yield* Effect.forkScoped(merge.run({ pr: 21 }).pipe(Effect.flip));
              const card = yield* waitReal(
                "the approval card",
                store.listRequests(worker.thread.id).pipe(Effect.map((all) => all[0])),
              );
              if (card.kind !== "approval") throw new Error("not an approval");
              expect(card.autonomyNote).toContain("another thread has it as its pull request");
              yield* runtimes.respond(worker.thread.id, card.id, {
                kind: "approval",
                decision: "deny",
                scope: "once",
              });
              yield* Fiber.join(call);
              expect(
                (yield* store.getThread(worker.thread.id)).boundPr?.mergeWhenReady,
              ).toBeUndefined();
            }),
          );
        }).pipe(Effect.scoped),
    );
  }

  for (const state of ["MERGED", "CLOSED"] as const) {
    it.effect.skipIf(!hasGit)(
      `set_auto_merge refuses an unbound ${state.toLowerCase()} PR without a card`,
      () =>
        Effect.gen(function* () {
          const world = yield* makeWorld;
          yield* withServer(
            world,
            Effect.gen(function* () {
              const store = yield* ThreadStore;
              const registry = yield* AppToolRegistry;
              const { session, thread } = yield* openOrchestrator(world);
              const worker = yield* spawn(session, { feature: "ended-unbound" });
              yield* completeTurn(worker.session);
              yield* atAutonomy(thread, "full", { mergeReviewPolicy: "bot" });
              world.prHeads.set(21, { headRefName: worker.thread.checkout.branch!, state });
              yield* publishGit(world, worker.thread, {
                pr: badge({ number: 21, url: "https://github.com/acme/app/pull/21", state }),
              });
              const tool = registry
                .forTransport(worker.thread.id, "worker")
                .find((t) => t.descriptor.name === "set_auto_merge")!;
              const refused = yield* tool.run({ number: 21 }).pipe(Effect.flip);
              expect(refused.message).toBe(
                `acme/app#21 is ${state.toLowerCase()}, so there is nothing to merge; check it with pr_status. Nobody was asked.`,
              );
              expect(yield* store.listRequests(worker.thread.id)).toEqual([]);
              expect(world.ghCalls.filter((c) => c[2] === "merge")).toEqual([]);
            }),
          );
        }).pipe(Effect.scoped),
    );
  }

  for (const when of ["before the launch", "during the fresh read"] as const) {
    it.effect.skipIf(!hasGit)(`a sibling binding the armed PR ${when} stops its merge`, () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const store = yield* ThreadStore;
            const runtimes = yield* ThreadRuntimes;
            const registry = yield* AppToolRegistry;
            const { session, thread } = yield* openOrchestrator(world);
            const worker = yield* spawn(session, { feature: "armed" });
            const sibling = yield* spawn(session, { feature: "claimant" });
            yield* completeTurn(worker.session);
            yield* completeTurn(sibling.session);
            yield* atAutonomy(thread, "full");
            world.prHeads.set(12, { headRefName: worker.thread.checkout.branch! });
            const tools = registry.forTransport(worker.thread.id, "worker");
            yield* tools
              .find((t) => t.descriptor.name === "pr_bind")!
              .run({
                repo: "acme/app",
                number: 12,
              });
            const publish = (approved: boolean) =>
              store
                .getThread(worker.thread.id)
                .pipe(
                  Effect.flatMap((t) => publishGit(world, t, { pr: armedWorkerBadge(approved) })),
                );
            yield* publish(false);
            yield* tools.find((t) => t.descriptor.name === "merge_when_ready")!.run({});
            expect(
              (yield* store.getThread(worker.thread.id)).boundPr?.mergeWhenReady,
            ).toMatchObject({ allowedBy: "autonomy" });
            const claim = runtimes
              .updateThread(sibling.thread.id, (t) => ({
                ...t,
                boundPr: { repo: "acme/app", number: 12, monitor: false },
              }))
              .pipe(Effect.asVoid, Effect.orDie);
            let claimed = false;
            if (when === "before the launch") {
              yield* claim;
              claimed = true;
            } else
              world.freshPrRead = Effect.suspend(() => {
                world.freshPrRead = undefined;
                return claim.pipe(Effect.tap(() => Effect.sync(() => void (claimed = true))));
              });
            yield* publish(true);
            yield* waitReal(
              "the claim",
              Effect.sync(() => claimed || undefined),
            );
            yield* settle;
            expect(world.ghCalls.filter((c) => c[2] === "merge")).toEqual([]);
          }),
        );
      }).pipe(Effect.scoped),
    );
  }

  it.effect.skipIf(!hasGit)("tells an orchestrator how its worker can hold the branch", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      yield* withServer(
        world,
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const registry = yield* AppToolRegistry;
          const { session, thread } = yield* openOrchestrator(world);
          const worker = yield* spawn(session, { feature: "release" });
          yield* completeTurn(worker.session);
          yield* atAutonomy(thread, "full");
          world.prHeads.set(21, { headRefName: DEPLOY });
          const merge = registry
            .forTransport(thread.id, "orchestrator")
            .find((t) => t.descriptor.name === "merge_when_ready")!;
          const refused = yield* merge
            .run({ threadId: worker.thread.id, pr: 21 })
            .pipe(Effect.flip);
          expect(refused.message).toContain(
            `Have the worker check it out in the worktree Gram gave it (\`git fetch origin ${DEPLOY}\` then \`git switch ${DEPLOY}\`), then call merge_when_ready again`,
          );
          expect(yield* store.listRequests(thread.id)).toEqual([]);
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(!hasGit)("still asks below full autonomy", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      yield* withServer(
        world,
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const runtimes = yield* ThreadRuntimes;
          const registry = yield* AppToolRegistry;
          const { session, thread } = yield* openOrchestrator(world);
          const worker = yield* spawn(session, { feature: "release" });
          yield* completeTurn(worker.session);
          yield* atAutonomy(thread, "full");
          yield* store.updateWorkspace(thread.workspaceId!, (state) => ({
            ...state,
            charter: { ...state.charter, autonomy: "publish" as const },
          }));
          world.prHeads.set(21, { headRefName: DEPLOY });
          const merge = registry
            .forTransport(worker.thread.id, "worker")
            .find((t) => t.descriptor.name === "merge_when_ready")!;
          const call = yield* Effect.forkScoped(merge.run({ pr: 21 }).pipe(Effect.flip));
          const card = yield* waitReal(
            "the approval card",
            store.listRequests(worker.thread.id).pipe(Effect.map((all) => all[0])),
          );
          expect(card).toMatchObject({ displayName: "merge_when_ready" });
          yield* runtimes.respond(worker.thread.id, card.id, {
            kind: "approval",
            decision: "deny",
            scope: "once",
          });
          expect((yield* Fiber.join(call)).message).toContain("The user declined merge_when_ready");
        }),
      );
    }).pipe(Effect.scoped),
  );

  for (const state of ["MERGED", "CLOSED"] as const) {
    it.effect.skipIf(!hasGit)(`refuses arming a ${state.toLowerCase()} PR without a card`, () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const store = yield* ThreadStore;
            const runtimes = yield* ThreadRuntimes;
            const registry = yield* AppToolRegistry;
            const { session, thread } = yield* openOrchestrator(world);
            const worker = yield* spawn(session, { feature: "done" });
            yield* completeTurn(worker.session);
            yield* atAutonomy(thread, "full");
            world.prHeads.set(12, { headRefName: worker.thread.checkout.branch!, state });
            yield* runtimes.updateThread(worker.thread.id, (t) => ({
              ...t,
              boundPr: { repo: "acme/app", number: 12, monitor: false },
            }));
            const merge = registry
              .forTransport(worker.thread.id, "worker")
              .find((t) => t.descriptor.name === "merge_when_ready")!;
            const refused = yield* merge.run({}).pipe(Effect.flip);
            expect(refused.message).toBe(
              `acme/app#12 is ${state.toLowerCase()}, so there is nothing to merge; check it with pr_status. Nobody was asked.`,
            );
            expect(yield* store.listRequests(worker.thread.id)).toEqual([]);
          }),
        );
      }).pipe(Effect.scoped),
    );
  }

  for (const autonomy of ["full", "publish"] as const) {
    it.effect.skipIf(!hasGit)(
      `refuses a change to a merged PR's intent without ownership or a card at ${autonomy}`,
      () =>
        Effect.gen(function* () {
          const world = yield* makeWorld;
          yield* withServer(
            world,
            Effect.gen(function* () {
              const store = yield* ThreadStore;
              const runtimes = yield* ThreadRuntimes;
              const registry = yield* AppToolRegistry;
              const { session, thread } = yield* openOrchestrator(world);
              const worker = yield* spawn(session, { feature: "merged" });
              yield* completeTurn(worker.session);
              yield* atAutonomy(thread, "full");
              if (autonomy === "publish")
                yield* store.updateWorkspace(thread.workspaceId!, (state) => ({
                  ...state,
                  charter: { ...state.charter, autonomy: "publish" as const },
                }));
              // The deploy PR, merged from a branch the worker never held, with its intent left.
              world.prHeads.set(21, { headRefName: DEPLOY, state: "MERGED" });
              yield* runtimes.updateThread(worker.thread.id, (t) => ({
                ...t,
                boundPr: {
                  repo: "acme/app",
                  number: 21,
                  monitor: false,
                  mergeWhenReady: {
                    method: "squash",
                    allowedBy: "user",
                    hold: "deploy window",
                    heldBy: "thread",
                    setAt: 0,
                  },
                },
              }));
              // Its badge says so; below full nothing else is read before refusing.
              yield* publishGit(world, yield* store.getThread(worker.thread.id), {
                pr: badge({
                  number: 21,
                  url: "https://github.com/acme/app/pull/21",
                  state: "MERGED",
                }),
              });
              const merge = registry
                .forTransport(worker.thread.id, "worker")
                .find((t) => t.descriptor.name === "merge_when_ready")!;
              for (const input of [{ release: true }, { hold: "later" }, {}]) {
                const refused = yield* merge.run(input).pipe(Effect.flip);
                expect(refused.message).toBe(
                  "acme/app#21 is merged, so there is nothing to merge; check it with pr_status. Nobody was asked.",
                );
              }
              expect(yield* store.listRequests(worker.thread.id)).toEqual([]);
              // Dropping it goes through, and needs nothing either.
              yield* merge.run({ enabled: false });
              expect(
                (yield* store.getThread(worker.thread.id)).boundPr?.mergeWhenReady,
              ).toBeUndefined();
              expect(yield* store.listRequests(worker.thread.id)).toEqual([]);
            }),
          );
        }).pipe(Effect.scoped),
    );
  }

  for (const autonomy of ["full", "supervised"] as const) {
    it.effect.skipIf(!hasGit)(
      `drops an intent on a merged PR without ownership or a card at ${autonomy}`,
      () =>
        Effect.gen(function* () {
          const world = yield* makeWorld;
          yield* withServer(
            world,
            Effect.gen(function* () {
              const store = yield* ThreadStore;
              const runtimes = yield* ThreadRuntimes;
              const registry = yield* AppToolRegistry;
              const { session, thread } = yield* openOrchestrator(world);
              const worker = yield* spawn(session, { feature: "merged" });
              yield* completeTurn(worker.session);
              yield* atAutonomy(thread, autonomy);
              // Merged by hand from a branch the worker never held.
              world.prHeads.set(21, { headRefName: DEPLOY, state: "MERGED" });
              yield* runtimes.updateThread(worker.thread.id, (t) => ({
                ...t,
                boundPr: {
                  repo: "acme/app",
                  number: 21,
                  monitor: false,
                  mergeWhenReady: { method: "squash", allowedBy: "user", setAt: 0 },
                },
              }));
              const merge = registry
                .forTransport(worker.thread.id, "worker")
                .find((t) => t.descriptor.name === "merge_when_ready")!;
              expect(yield* merge.delegatedAtFullAutonomy!({ enabled: false })).toBe(true);
              expect(yield* merge.run({ enabled: false })).toMatchObject({
                mergeWhenReady: false,
              });
              expect(
                (yield* store.getThread(worker.thread.id)).boundPr?.mergeWhenReady,
              ).toBeUndefined();
              expect(yield* store.listRequests(worker.thread.id)).toEqual([]);
            }),
          );
        }).pipe(Effect.scoped),
    );
  }

  it.effect.skipIf(!hasGit)("still asks before dropping another thread's intent", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      yield* withServer(
        world,
        Effect.gen(function* () {
          const runtimes = yield* ThreadRuntimes;
          const registry = yield* AppToolRegistry;
          const { session, thread } = yield* openOrchestrator(world);
          const worker = yield* spawn(session, { feature: "mine" });
          const sibling = yield* spawn(session, { feature: "theirs" });
          yield* completeTurn(worker.session);
          yield* completeTurn(sibling.session);
          yield* atAutonomy(thread, "full");
          yield* runtimes.updateThread(sibling.thread.id, (t) => ({
            ...t,
            boundPr: {
              repo: "acme/app",
              number: 30,
              monitor: false,
              mergeWhenReady: { method: "squash", allowedBy: "user", setAt: 0 },
            },
          }));
          const merge = registry
            .forTransport(worker.thread.id, "worker")
            .find((t) => t.descriptor.name === "merge_when_ready")!;
          expect(
            yield* merge.delegatedAtFullAutonomy!({ enabled: false, threadId: sibling.thread.id }),
          ).toBe(false);
        }),
      );
    }).pipe(Effect.scoped),
  );
});
