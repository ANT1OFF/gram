// Regressions for the independent review of #651: every error, unknown or missing state in the
// full-autonomy merge boundary counts as a claim or refuses, and the final check is part of the
// commit. Each case was a characterization probe asserting the unsafe behavior at 7d2ef62b; here it
// asserts the fix. The two controls keep the normal own-PR launch and a failed reservation write.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { hasGit, run } from "../git/test-repo.ts";
import { Orchestration } from "../orchestration/service.ts";
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
  type World,
} from "../orchestration/test-harness.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { armedWorkerBadge } from "./pr-tools-kit.ts";
import { AppToolRegistry } from "./registry.ts";

/**
 * Makes one field of `id`'s stored row undecodable (its title a number), as a corrupt or
 * incompatible row would be, leaving its binding of #12 and its `parked` column as they were.
 */
const corrupt = (world: World, id: string) => {
  const db = new DatabaseSync(`${world.dir}/gram.db`);
  try {
    db.prepare("UPDATE threads SET data = json_set(data, '$.title', 42) WHERE id = ?").run(id);
    const row = db
      .prepare(
        "SELECT json_extract(data, '$.boundPr.number') AS number, parked FROM threads WHERE id = ?",
      )
      .get(id) as { number: number; parked: number } | undefined;
    expect(row?.number).toBe(12);
    expect(row?.parked).toBe(0);
  } finally {
    db.close();
  }
};

const merges = (world: World) => world.ghCalls.filter((c) => c[2] === "merge");

describe("merge_when_ready fails closed", () => {
  for (const damage of ["move", "invalid-gitdir"] as const) {
    for (const phase of ["arm", "launch"] as const) {
      it.effect.skipIf(!hasGit)(
        `a sibling whose HEAD is unreadable (${damage}) after an unsampled switch blocks the ${phase}`,
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
                const sibling = yield* spawn(session, { feature: "sibling" });
                yield* completeTurn(worker.session);
                yield* completeTurn(sibling.session);
                yield* atAutonomy(thread, "full");
                const branch = worker.thread.checkout.branch!;
                world.prHeads.set(phase === "arm" ? 21 : 12, { headRefName: branch });
                // The sibling really takes the branch, then its HEAD becomes unreadable: its folder
                // moves, or its `.git` file names a git directory that isn't there.
                const damageSibling = () => {
                  run(sibling.thread.checkout.path, "checkout", "--ignore-other-worktrees", branch);
                  expect(
                    run(sibling.thread.checkout.path, "symbolic-ref", "--short", "HEAD").trim(),
                  ).toBe(branch);
                  if (damage === "move")
                    run(
                      world.repo,
                      "worktree",
                      "move",
                      sibling.thread.checkout.path,
                      `${sibling.thread.checkout.path}-moved`,
                    );
                  else
                    writeFileSync(
                      `${sibling.thread.checkout.path}/.git`,
                      "gitdir: /synthetic/missing-git-directory\n",
                    );
                };
                const tools = registry.forTransport(worker.thread.id, "worker");
                const merge = tools.find((t) => t.descriptor.name === "merge_when_ready")!;
                if (phase === "arm") {
                  damageSibling();
                  expect((yield* store.getThread(sibling.thread.id)).checkout.branch).not.toBe(
                    branch,
                  );
                  // An unreadable HEAD may hold the branch: full auto no longer covers the PR.
                  expect(yield* merge.delegatedAtFullAutonomy!({ pr: 21 })).toBe(false);
                } else {
                  yield* tools
                    .find((t) => t.descriptor.name === "pr_bind")!
                    .run({ repo: "acme/app", number: 12 });
                  const publish = (approved: boolean) =>
                    store
                      .getThread(worker.thread.id)
                      .pipe(
                        Effect.flatMap((t) =>
                          publishGit(world, t, { pr: armedWorkerBadge(approved) }),
                        ),
                      );
                  yield* publish(false);
                  yield* merge.run({});
                  let changed = false;
                  world.freshPrRead = Effect.sync(() => {
                    world.freshPrRead = undefined;
                    damageSibling();
                    changed = true;
                  });
                  yield* publish(true);
                  yield* waitReal(
                    "damaged sibling",
                    Effect.sync(() => changed || undefined),
                  );
                  yield* settle;
                  expect((yield* store.getThread(sibling.thread.id)).checkout.branch).not.toBe(
                    branch,
                  );
                  expect(world.freshPrReads).toContain("acme/app#12");
                  expect(merges(world)).toHaveLength(0);
                }
                expect(yield* store.listRequests(worker.thread.id)).toEqual([]);
              }),
            );
          }).pipe(Effect.scoped),
      );
    }
  }

  it.effect.skipIf(!hasGit)(
    "a pr_bind after the durable launch reservation is refused, not committed beside it",
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
            const sibling = yield* spawn(session, { feature: "late-binding" });
            yield* completeTurn(worker.session);
            yield* completeTurn(sibling.session);
            yield* atAutonomy(thread, "full");
            world.prHeads.set(12, { headRefName: worker.thread.checkout.branch! });
            const tools = registry.forTransport(worker.thread.id, "worker");
            yield* tools
              .find((t) => t.descriptor.name === "pr_bind")!
              .run({ repo: "acme/app", number: 12 });
            const publish = (approved: boolean) =>
              store
                .getThread(worker.thread.id)
                .pipe(
                  Effect.flatMap((t) => publishGit(world, t, { pr: armedWorkerBadge(approved) })),
                );
            yield* publish(false);
            yield* tools.find((t) => t.descriptor.name === "merge_when_ready")!.run({});
            const original = store.reserveMergeFence;
            let tried = false;
            let refusal: string | undefined;
            // After the reservation has committed and before gh starts, the sibling's real pr_bind
            // must give way to the launch that reserved the PR first.
            store.reserveMergeFence = ((...args: Parameters<typeof original>) =>
              original(...args).pipe(
                Effect.tap((reserved) =>
                  Effect.gen(function* () {
                    if (!reserved || tried || args[2] !== worker.thread.id) return;
                    tried = true;
                    expect(
                      (yield* store.listMergeFences).some(
                        (fence) => fence.pending?.threadId === worker.thread.id,
                      ),
                    ).toBe(true);
                    expect(merges(world)).toHaveLength(0);
                    refusal = (yield* registry
                      .forTransport(sibling.thread.id, "worker")
                      .find((t) => t.descriptor.name === "pr_bind")!
                      .run({ repo: "acme/app", number: 12 })
                      .pipe(Effect.flip)).message;
                  }),
                ),
              )) as typeof original;
            yield* Effect.gen(function* () {
              yield* publish(true);
              yield* waitReal(
                "post-reservation bind",
                Effect.sync(() => refusal),
              );
              expect(refusal).toContain("is being merged by another thread");
              const after = yield* store.getThread(sibling.thread.id);
              expect(after.boundPr).toBeUndefined();
              expect(after.extraPrs?.map((pr) => pr.number)).toEqual([12]);
              // The launch that reserved the PR first goes ahead, alone.
              yield* waitReal(
                "the reserved merge",
                Effect.sync(() => merges(world).length === 1 || undefined),
              );
            }).pipe(Effect.ensuring(Effect.sync(() => (store.reserveMergeFence = original))));
          }),
        );
      }).pipe(Effect.scoped),
  );

  for (const phase of ["arm", "launch"] as const) {
    it.effect.skipIf(!hasGit)(`an unreadable bound thread row blocks the ${phase}`, () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const store = yield* ThreadStore;
            const registry = yield* AppToolRegistry;
            const { session, thread } = yield* openOrchestrator(world);
            const worker = yield* spawn(session, { feature: "owner" });
            const sibling = yield* spawn(session, { feature: "bound" });
            yield* completeTurn(worker.session);
            yield* completeTurn(sibling.session);
            yield* atAutonomy(thread, "full");
            world.prHeads.set(12, { headRefName: worker.thread.checkout.branch! });
            const tools = registry.forTransport(worker.thread.id, "worker");
            const merge = tools.find((t) => t.descriptor.name === "merge_when_ready")!;
            const claim = registry
              .forTransport(sibling.thread.id, "worker")
              .find((t) => t.descriptor.name === "pr_bind")!
              .run({ repo: "acme/app", number: 12 });
            if (phase === "arm") {
              yield* claim;
              expect(yield* merge.delegatedAtFullAutonomy!({ pr: 12 })).toBe(false);
              corrupt(world, sibling.thread.id);
              // The row no longer decodes, but it can't be ruled out: it still blocks.
              expect(yield* merge.delegatedAtFullAutonomy!({ pr: 12 })).toBe(false);
            } else {
              yield* tools
                .find((t) => t.descriptor.name === "pr_bind")!
                .run({ repo: "acme/app", number: 12 });
              const publish = (approved: boolean) =>
                store
                  .getThread(worker.thread.id)
                  .pipe(
                    Effect.flatMap((t) => publishGit(world, t, { pr: armedWorkerBadge(approved) })),
                  );
              yield* publish(false);
              yield* merge.run({});
              let changed = false;
              world.freshPrRead = claim.pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    world.freshPrRead = undefined;
                    corrupt(world, sibling.thread.id);
                    changed = true;
                  }),
                ),
                Effect.asVoid,
                Effect.orDie,
              );
              yield* publish(true);
              yield* waitReal(
                "corrupted claim",
                Effect.sync(() => changed || undefined),
              );
              yield* settle;
              expect(merges(world)).toHaveLength(0);
            }
            expect(yield* store.listRequests(worker.thread.id)).toEqual([]);
          }),
        );
      }).pipe(Effect.scoped),
    );
  }

  for (const phase of ["arm", "launch"] as const) {
    it.effect.skipIf(!hasGit)(`autonomy revoked just before the ${phase} commits refuses it`, () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const store = yield* ThreadStore;
            const registry = yield* AppToolRegistry;
            const orchestration = yield* Orchestration;
            const { session, thread, workspaceId } = yield* openOrchestrator(world);
            const worker = yield* spawn(session, { feature: "owner" });
            yield* completeTurn(worker.session);
            yield* atAutonomy(thread, "full");
            world.prHeads.set(12, { headRefName: worker.thread.checkout.branch! });
            const tools = registry.forTransport(worker.thread.id, "worker");
            const merge = tools.find((t) => t.descriptor.name === "merge_when_ready")!;
            // The real charter service, as the user's downgrade to Publish would run.
            const revoke = store.getWorkspace(workspaceId).pipe(
              Effect.flatMap((state) =>
                orchestration.setCharter(workspaceId, { ...state.charter, autonomy: "publish" }),
              ),
              Effect.asVoid,
            );
            let changed = false;
            if (phase === "arm") {
              const original = store.updateThread;
              store.updateThread = ((...args: Parameters<typeof original>) =>
                args[0] === worker.thread.id && !changed && args[3] !== undefined
                  ? Effect.gen(function* () {
                      changed = true;
                      yield* revoke;
                      return yield* original(...args);
                    })
                  : original(...args)) as typeof original;
              yield* Effect.gen(function* () {
                const refusal = yield* merge.run({ pr: 12 }).pipe(Effect.flip);
                expect(changed).toBe(true);
                expect(refusal.message).toContain("autonomy");
                expect((yield* store.getWorkspace(workspaceId)).charter.autonomy).toBe("publish");
                expect(
                  (yield* store.getThread(worker.thread.id)).boundPr?.mergeWhenReady,
                ).toBeUndefined();
              }).pipe(Effect.ensuring(Effect.sync(() => (store.updateThread = original))));
            } else {
              yield* tools
                .find((t) => t.descriptor.name === "pr_bind")!
                .run({ repo: "acme/app", number: 12 });
              const publish = (approved: boolean) =>
                store
                  .getThread(worker.thread.id)
                  .pipe(
                    Effect.flatMap((t) => publishGit(world, t, { pr: armedWorkerBadge(approved) })),
                  );
              yield* publish(false);
              yield* merge.run({});
              const original = store.reserveMergeFence;
              store.reserveMergeFence = ((...args: Parameters<typeof original>) =>
                Effect.gen(function* () {
                  if (!changed && args[2] === worker.thread.id) {
                    changed = true;
                    yield* revoke;
                  }
                  return yield* original(...args);
                })) as typeof original;
              yield* Effect.gen(function* () {
                yield* publish(true);
                yield* waitReal(
                  "revoked",
                  Effect.sync(() => changed || undefined),
                );
                yield* settle;
                expect((yield* store.getWorkspace(workspaceId)).charter.autonomy).toBe("publish");
                expect(merges(world)).toHaveLength(0);
                expect(
                  (yield* store.listMergeFences).some(
                    (fence) => fence.pending?.threadId === worker.thread.id,
                  ),
                ).toBe(false);
              }).pipe(Effect.ensuring(Effect.sync(() => (store.reserveMergeFence = original))));
            }
            expect(yield* store.listRequests(worker.thread.id)).toEqual([]);
          }),
        );
      }).pipe(Effect.scoped),
    );
  }

  it.effect.skipIf(!hasGit)(
    "an own PR arms and launches without a card beside a following-only observer",
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
            const observer = yield* spawn(session, { feature: "observer" });
            yield* completeTurn(worker.session);
            yield* completeTurn(observer.session);
            yield* atAutonomy(thread, "full");
            world.prHeads.set(12, { headRefName: worker.thread.checkout.branch! });
            const observing = registry
              .forTransport(observer.thread.id, "worker")
              .find((t) => t.descriptor.name === "pr_bind")!;
            yield* observing.run({ repo: "acme/app", number: 99 });
            yield* observing.run({ repo: "acme/app", number: 12, add: true });
            const tools = registry.forTransport(worker.thread.id, "worker");
            yield* tools
              .find((t) => t.descriptor.name === "pr_bind")!
              .run({ repo: "acme/app", number: 12 });
            const publish = (approved: boolean) =>
              store
                .getThread(worker.thread.id)
                .pipe(
                  Effect.flatMap((t) => publishGit(world, t, { pr: armedWorkerBadge(approved) })),
                );
            yield* publish(false);
            const merge = tools.find((t) => t.descriptor.name === "merge_when_ready")!;
            expect(yield* merge.delegatedAtFullAutonomy!({})).toBe(true);
            yield* merge.run({});
            expect(
              (yield* store.getThread(worker.thread.id)).boundPr?.mergeWhenReady?.allowedBy,
            ).toBe("autonomy");
            yield* publish(true);
            yield* waitReal(
              "the normal merge launch",
              Effect.sync(() => merges(world).length > 0 || undefined),
            );
            expect(merges(world)).toHaveLength(1);
            expect(merges(world)[0]).toContain("--match-head-commit");
            expect(merges(world)[0]).toContain("h1");
            expect(yield* store.listRequests(worker.thread.id)).toEqual([]);
          }),
        );
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(!hasGit)(
    "a failed reservation write commits no fence, and a later one can proceed",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const store = yield* ThreadStore;
            const { session } = yield* openOrchestrator(world);
            const worker = yield* spawn(session, { feature: "owner" });
            yield* completeTurn(worker.session);
            const db = new DatabaseSync(`${world.dir}/gram.db`);
            try {
              db.exec(
                "CREATE TRIGGER reject_reservation BEFORE INSERT ON merge_fences BEGIN SELECT RAISE(ABORT, 'synthetic reservation write failure'); END",
              );
            } finally {
              db.close();
            }
            const pr = { repo: "acme/app", number: 12 };
            const fence = {
              key: "acme/app\u0000main",
              moved: [],
              pending: { pr, threadId: worker.thread.id, head: "h1", at: 1 },
            };
            const failed = yield* store
              .reserveMergeFence(fence, pr, worker.thread.id)
              .pipe(Effect.exit);
            expect(failed._tag).toBe("Failure");
            expect(yield* store.listMergeFences).toEqual([]);
            expect(merges(world)).toHaveLength(0);
            const recovery = new DatabaseSync(`${world.dir}/gram.db`);
            try {
              recovery.exec("DROP TRIGGER reject_reservation");
            } finally {
              recovery.close();
            }
            expect(yield* store.reserveMergeFence(fence, pr, worker.thread.id)).toBe(true);
            expect(yield* store.listMergeFences).toContainEqual(fence);
          }),
        );
      }).pipe(Effect.scoped),
  );
});
