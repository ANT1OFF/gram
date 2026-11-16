// Regressions for the final #627 review's merge-ownership boundary findings: an unsampled sibling
// branch switch or rename, and a competing pr_bind that races the arm or the launch. Each was a
// characterization probe asserting the unsafe behavior at the reviewed head; here it asserts the
// fix — full auto no longer covers the PR, and no merge launches onto another thread's work.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { hasGit, run } from "../git/test-repo.ts";
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
import { armedWorkerBadge } from "./pr-tools-kit.ts";
import { AppToolRegistry } from "./registry.ts";

describe("merge_when_ready ownership boundary", () => {
  for (const change of ["rename", "switch"] as const) {
    it.effect.skipIf(!hasGit)(
      `a sibling's unsampled branch ${change} refuses an autonomous arm without a card`,
      () =>
        Effect.gen(function* () {
          const world = yield* makeWorld;
          yield* withServer(
            world,
            Effect.gen(function* () {
              const store = yield* ThreadStore;
              const registry = yield* AppToolRegistry;
              const { session, thread } = yield* openOrchestrator(world);
              const worker = yield* spawn(session, { feature: "adopter" });
              const sibling = yield* spawn(session, { feature: "original" });
              yield* completeTurn(worker.session);
              yield* completeTurn(sibling.session);
              yield* atAutonomy(thread, "full");
              const branch = "release/new-name";
              // The sibling takes the branch in its real worktree; its recorded checkout still
              // names the old one, so only a live read of its HEAD can see the claim.
              run(
                sibling.thread.checkout.path,
                ...(change === "rename" ? ["branch", "-m", branch] : ["switch", "-c", branch]),
              );
              expect(
                run(sibling.thread.checkout.path, "symbolic-ref", "--short", "HEAD").trim(),
              ).toBe(branch);
              expect((yield* store.getThread(sibling.thread.id)).checkout.branch).not.toBe(branch);
              run(worker.thread.checkout.path, "checkout", "--ignore-other-worktrees", branch);
              world.prHeads.set(21, { headRefName: branch });
              const merge = registry
                .forTransport(worker.thread.id, "worker")
                .find((t) => t.descriptor.name === "merge_when_ready")!;
              // Full auto must not cover the PR: the sibling's live branch is the claim.
              expect(yield* merge.delegatedAtFullAutonomy!({ pr: 21 })).toBe(false);
            }),
          );
        }).pipe(Effect.scoped),
    );
  }

  it.effect.skipIf(!hasGit)(
    "a sibling switching to the held branch during the launch read stops the merge",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const store = yield* ThreadStore;
            const registry = yield* AppToolRegistry;
            const { session, thread } = yield* openOrchestrator(world);
            const worker = yield* spawn(session, { feature: "owner" });
            const sibling = yield* spawn(session, { feature: "late-holder" });
            yield* completeTurn(worker.session);
            yield* completeTurn(sibling.session);
            yield* atAutonomy(thread, "full");
            const branch = worker.thread.checkout.branch!;
            world.prHeads.set(12, { headRefName: branch });
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
            let changed = false;
            // During the launch's fresh provider read, the sibling takes the PR's branch live; its
            // record never samples it. The launch's own recheck must still see the claim.
            world.freshPrRead = Effect.sync(() => {
              world.freshPrRead = undefined;
              run(sibling.thread.checkout.path, "checkout", "--ignore-other-worktrees", branch);
              changed = true;
            });
            yield* publish(true);
            yield* waitReal(
              "sibling switched",
              Effect.sync(() => changed || undefined),
            );
            yield* settle;
            expect(
              run(sibling.thread.checkout.path, "symbolic-ref", "--short", "HEAD").trim(),
            ).toBe(branch);
            expect((yield* store.getThread(sibling.thread.id)).checkout.branch).not.toBe(branch);
            // The launch attempt ran its fresh read, yet launched no merge onto the sibling's branch.
            expect(world.freshPrReads).toContain("acme/app#12");
            expect(world.ghCalls.filter((c) => c[2] === "merge")).toHaveLength(0);
          }),
        );
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(!hasGit)(
    "a competing pr_bind committed at the arming write stops the autonomous arm",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const store = yield* ThreadStore;
            const registry = yield* AppToolRegistry;
            const { session, thread } = yield* openOrchestrator(world);
            const worker = yield* spawn(session, { feature: "owner" });
            const sibling = yield* spawn(session, { feature: "late-bind" });
            yield* completeTurn(worker.session);
            yield* completeTurn(sibling.session);
            yield* atAutonomy(thread, "full");
            world.prHeads.set(21, { headRefName: worker.thread.checkout.branch! });
            const merge = registry
              .forTransport(worker.thread.id, "worker")
              .find((t) => t.descriptor.name === "merge_when_ready")!;
            const original = store.updateThread;
            let inject = true;
            // Place the sibling's real pr_bind immediately before the worker's arming write, in the
            // legal interleaving the review scheduled. The write's own scan must see it.
            store.updateThread = ((...args: Parameters<typeof original>) =>
              args[0] === worker.thread.id && inject
                ? Effect.gen(function* () {
                    inject = false;
                    yield* registry
                      .forTransport(sibling.thread.id, "worker")
                      .find((t) => t.descriptor.name === "pr_bind")!
                      .run({ repo: "acme/app", number: 21 });
                    return yield* original(...args);
                  })
                : original(...args)) as typeof original;
            yield* Effect.gen(function* () {
              const refusal = yield* merge.run({ pr: 21 }).pipe(Effect.flip);
              expect(refusal.message).toContain("Another thread bound this pull request");
              expect(inject).toBe(false);
              expect((yield* store.getThread(sibling.thread.id)).boundPr?.number).toBe(21);
              expect(
                (yield* store.getThread(worker.thread.id)).boundPr?.mergeWhenReady,
              ).toBeUndefined();
              expect(yield* store.listRequests(worker.thread.id)).toEqual([]);
            }).pipe(Effect.ensuring(Effect.sync(() => (store.updateThread = original))));
          }),
        );
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(!hasGit)(
    "a competing pr_bind committed at the launch reservation stops the merge",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const store = yield* ThreadStore;
            const registry = yield* AppToolRegistry;
            const { session, thread } = yield* openOrchestrator(world);
            const worker = yield* spawn(session, { feature: "owner" });
            const sibling = yield* spawn(session, { feature: "bind-at-fence" });
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
            const original = store.reserveMergeFence;
            let claimed = false;
            // The sibling binds the PR just before the launch reserves the base; the reservation's
            // in-transaction scan must refuse, so no merge launches onto the sibling's work.
            store.reserveMergeFence = ((fence, pr, excluding) =>
              Effect.gen(function* () {
                if (!claimed && excluding === worker.thread.id) {
                  claimed = true;
                  yield* registry
                    .forTransport(sibling.thread.id, "worker")
                    .find((t) => t.descriptor.name === "pr_bind")!
                    .run({ repo: "acme/app", number: 12 });
                }
                return yield* original(fence, pr, excluding);
              })) as typeof original;
            yield* Effect.gen(function* () {
              yield* publish(true);
              yield* waitReal(
                "sibling claimed at reservation",
                Effect.sync(() => claimed || undefined),
              );
              yield* settle;
              expect((yield* store.getThread(sibling.thread.id)).boundPr?.number).toBe(12);
              expect(world.ghCalls.filter((c) => c[2] === "merge")).toHaveLength(0);
            }).pipe(Effect.ensuring(Effect.sync(() => (store.reserveMergeFence = original))));
          }),
        );
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(!hasGit)("a moved sibling worktree keeps its recorded branch claim", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      yield* withServer(
        world,
        Effect.gen(function* () {
          const registry = yield* AppToolRegistry;
          const { session, thread } = yield* openOrchestrator(world);
          const worker = yield* spawn(session, { feature: "adopter" });
          const sibling = yield* spawn(session, { feature: "holder" });
          yield* completeTurn(worker.session);
          yield* completeTurn(sibling.session);
          yield* atAutonomy(thread, "full");
          const branch = sibling.thread.checkout.branch!;
          // The sibling's folder moves on disk; its record still names the branch, and a live read
          // at the stale path fails. The recorded claim must stand, so this is no fresh claim.
          run(
            world.repo,
            "worktree",
            "move",
            sibling.thread.checkout.path,
            sibling.thread.checkout.path + "-moved",
          );
          run(worker.thread.checkout.path, "checkout", "--ignore-other-worktrees", branch);
          world.prHeads.set(21, { headRefName: branch });
          const merge = registry
            .forTransport(worker.thread.id, "worker")
            .find((t) => t.descriptor.name === "merge_when_ready")!;
          expect(yield* merge.delegatedAtFullAutonomy!({ pr: 21 })).toBe(false);
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(!hasGit)("a closed sibling frees its bound PR while a live one blocks it", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      yield* withServer(
        world,
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const runtimes = yield* ThreadRuntimes;
          const registry = yield* AppToolRegistry;
          const { session, thread } = yield* openOrchestrator(world);
          const worker = yield* spawn(session, { feature: "adopter" });
          const sibling = yield* spawn(session, { feature: "holder" });
          yield* completeTurn(worker.session);
          yield* completeTurn(sibling.session);
          yield* atAutonomy(thread, "full");
          world.prHeads.set(21, { headRefName: worker.thread.checkout.branch! });
          yield* runtimes.updateThread(sibling.thread.id, (t) => ({
            ...t,
            boundPr: { repo: "acme/app", number: 21, monitor: false },
          }));
          const merge = registry
            .forTransport(worker.thread.id, "worker")
            .find((t) => t.descriptor.name === "merge_when_ready")!;
          expect(yield* merge.delegatedAtFullAutonomy!({ pr: 21 })).toBe(false);
          yield* store.closeThread(sibling.thread.id, Date.now());
          expect(yield* merge.delegatedAtFullAutonomy!({ pr: 21 })).toBe(true);
        }),
      );
    }).pipe(Effect.scoped),
  );
});
