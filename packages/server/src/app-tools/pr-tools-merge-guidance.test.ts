// merge_when_ready at full autonomy: what the agent can fix itself is refused to it with the fix,
// never put to the user; dropping an intent and a merged PR need neither ownership nor a card.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { hasGit, run } from "../git/test-repo.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import {
  atAutonomy,
  completeTurn,
  makeWorld,
  openOrchestrator,
  publishGit,
  spawn,
  waitReal,
  withServer,
} from "../orchestration/test-harness.ts";
import { badge } from "./pr-tools-kit.ts";
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
              `Full auto covers only a worker's own pull request: one whose head branch is checked out in the worktree Gram gave the worker. acme/app#21's head branch \`${DEPLOY}\` isn't checked out there. Check it out in the worktree Gram gave you (\`git fetch origin ${DEPLOY}\` then \`git switch ${DEPLOY}\`; commit your own work first), then call merge_when_ready again; Gram then merges it once its checks pass without asking. The user wasn't asked, and their approval isn't the way through for this.`,
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
