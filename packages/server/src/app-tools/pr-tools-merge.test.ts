// merge_when_ready: arming, holds, policy and what invalidates an armed merge.
import { describe, expect, it } from "@effect/vitest";
import { initialBabysitState, type ThreadNotFound, type NotFound } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { MergeWhenReady } from "../git/merge-when-ready.ts";
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
import { AppToolRegistry } from "./registry.ts";
import { ready, armedWorkerBadge, approvedRecovery, otherRecoveryRoot } from "./pr-tools-kit.ts";

describe("merge_when_ready", () => {
  for (const change of [
    "method",
    "PR",
    "repo",
    "scope",
    "worker",
    "sibling",
    "different root",
    "workspace",
    "no user authorization",
    "no approval",
    "user hold",
    "fork",
    "project",
    "autonomy",
    "pause",
    "park",
  ] as const) {
    it.effect.skipIf(!hasGit)(`approved recovery requires a card after ${change}`, () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const store = yield* ThreadStore;
            const runtimes = yield* ThreadRuntimes;
            const registry = yield* AppToolRegistry;
            const { root, worker, merge: rootMerge, input } = yield* approvedRecovery(world);
            let merge = rootMerge;
            let callerId = root.thread.id;
            let changedInput: Record<string, unknown> = input;
            if (change === "method") changedInput = { ...input, method: "rebase" };
            if (change === "PR") changedInput = { ...input, pr: "acme/app#13" };
            if (change === "repo") changedInput = { ...input, pr: "foreign/app#12" };
            if (change === "scope") changedInput = { ...input, after: ["acme/app#13"] };
            if (change === "worker" || change === "sibling") {
              const caller =
                change === "worker" ? worker : yield* spawn(root.session, { feature: "sibling" });
              if (change === "sibling") yield* completeTurn(caller.session);
              callerId = caller.thread.id;
              merge = registry
                .forTransport(callerId, "worker")
                .find((t) => t.descriptor.name === "merge_when_ready")!;
            }
            if (change === "different root") {
              const other = yield* otherRecoveryRoot(root.project.id);
              callerId = other.thread.id;
              merge = registry
                .forTransport(callerId, "orchestrator")
                .find((t) => t.descriptor.name === "merge_when_ready")!;
            }
            if (change === "workspace") {
              const other = yield* otherRecoveryRoot(root.project.id);
              yield* runtimes.updateThread(worker.thread.id, (t) => ({
                ...t,
                workspaceId: other.workspaceId,
              }));
            }
            if (
              change === "no user authorization" ||
              change === "no approval" ||
              change === "user hold"
            ) {
              yield* runtimes.updateThread(worker.thread.id, (t) => {
                const { userAuthorization: _approval, ...intent } = t.boundPr!.mergeWhenReady!;
                const { mergeWhenReady: _intent, ...binding } = t.boundPr!;
                if (change === "no approval") return { ...t, boundPr: binding };
                return {
                  ...t,
                  boundPr: {
                    ...t.boundPr!,
                    mergeWhenReady:
                      change === "no user authorization"
                        ? intent
                        : { ...t.boundPr!.mergeWhenReady!, heldBy: "thread" },
                  },
                };
              });
            }
            if (change === "fork")
              world.prHeads.set(12, { headRefName: "codex/historical-user-branch", fork: true });
            if (change === "project") {
              const other = yield* store.ensureProject({ root: world.dir, name: "other" });
              yield* store.updateWorkspace(root.workspaceId, (state) => ({
                ...state,
                workspace: { ...state.workspace, projectIds: [other.id], homeProjectId: other.id },
              }));
            }
            if (change === "autonomy") yield* atAutonomy(root.thread, "publish");
            if (change === "pause")
              yield* store.updateWorkspace(root.workspaceId, (state) => ({
                ...state,
                paused: { reason: "user", at: 1 },
              }));
            if (change === "park")
              yield* runtimes.updateThread(worker.thread.id, (t) => ({ ...t, parked: true }));
            const before = yield* store.getThread(worker.thread.id);
            expect(yield* merge.delegatedAtFullAutonomy!(changedInput)).toBe(false);
            const call = yield* Effect.forkScoped(merge.run(changedInput).pipe(Effect.flip));
            const card = yield* waitReal(
              "changed recovery approval",
              store.listRequests(callerId).pipe(Effect.map((all) => all[0])),
            );
            expect(card).toMatchObject({ displayName: "merge_when_ready", scopes: ["once"] });
            yield* runtimes.respond(callerId, card.id, {
              kind: "approval",
              decision: "deny",
              scope: "once",
            });
            expect(yield* Fiber.join(call)).toMatchObject({ approvalRequired: true });
            expect((yield* store.getThread(worker.thread.id)).boundPr).toEqual(before.boundPr);
            expect((yield* store.getThread(worker.thread.id)).ownedBranches).toEqual(
              before.ownedBranches,
            );
            expect(world.ghCalls.filter((c) => c[2] === "merge")).toEqual([]);
          }),
        );
      }).pipe(Effect.scoped),
    );
  }

  for (const change of [
    "replacement",
    "rebind",
    "method",
    "user hold",
    "caller",
    "workspace",
    "autonomy",
    "pause",
    "park",
    "project",
    "babysit",
    "scope",
  ] as const) {
    it.effect.skipIf(!hasGit)(
      `approved recovery atomically refuses a ${change} race at the write`,
      () =>
        Effect.gen(function* () {
          const world = yield* makeWorld;
          yield* withServer(
            world,
            Effect.gen(function* () {
              const store = yield* ThreadStore;
              const registry = yield* AppToolRegistry;
              const { root, worker, input } = yield* approvedRecovery(world);
              const definition = registry.definitions.find(
                (t) => t.descriptor.name === "merge_when_ready",
              )!;
              const target = yield* definition.resolve!(root.thread.id, input);
              expect(
                yield* definition.delegatedAtFullAutonomy!(root.thread.id, input, target),
              ).toBe(true);
              const other = yield* store.ensureProject({ root: world.dir, name: "other" });
              const original = store.updateThread;
              // Inject the change at the persistence boundary, after handler lookups and merge lock.
              // The actual transaction must see it, rather than trusting the gate's earlier snapshot.
              let inject = true;
              store.updateThread = (id, f, authorityCaller) => {
                if (!inject || id !== worker.thread.id || authorityCaller === undefined)
                  return original(id, f, authorityCaller);
                inject = false;
                const mutation: Effect.Effect<unknown, ThreadNotFound | NotFound> =
                  change === "autonomy" || change === "pause" || change === "project"
                    ? store.updateWorkspace(root.workspaceId, (state) => ({
                        ...state,
                        ...(change === "autonomy"
                          ? { charter: { ...state.charter!, autonomy: "publish" as const } }
                          : {}),
                        ...(change === "pause"
                          ? { paused: { reason: "user" as const, at: 1 } }
                          : {}),
                        ...(change === "project"
                          ? {
                              workspace: {
                                ...state.workspace,
                                projectIds: [other.id],
                                homeProjectId: other.id,
                              },
                            }
                          : {}),
                      }))
                    : original(change === "caller" ? root.thread.id : worker.thread.id, (t) => {
                        if (change === "caller" || change === "park") return { ...t, parked: true };
                        if (change === "workspace") {
                          const { workspaceId: _workspace, ...rest } = t;
                          return rest;
                        }
                        if (change === "babysit") return { ...t, babysit: initialBabysitState(1) };
                        const intent = t.boundPr!.mergeWhenReady!;
                        return {
                          ...t,
                          boundPr: {
                            ...t.boundPr!,
                            ...(change === "rebind" ? { number: 13 } : {}),
                            mergeWhenReady: {
                              ...intent,
                              ...(change === "replacement"
                                ? {
                                    userAuthorization: {
                                      ...intent.userAuthorization!,
                                      id: "replacement-approval",
                                    },
                                  }
                                : {}),
                              ...(change === "method" ? { method: "rebase" as const } : {}),
                              ...(change === "user hold" ? { heldBy: "thread" as const } : {}),
                              ...(change === "scope"
                                ? { after: [{ repo: "acme/app", number: 99 }] }
                                : {}),
                            },
                          },
                        };
                      });
                return mutation.pipe(
                  Effect.orDie,
                  Effect.andThen(original(id, f, authorityCaller)),
                );
              };
              const error = yield* definition
                .handle(root.thread.id, target, { carded: false })
                .pipe(
                  Effect.flip,
                  Effect.ensuring(
                    Effect.sync(() => {
                      store.updateThread = original;
                    }),
                  ),
                );
              expect(error.message).toContain("changed during the call");
              expect((yield* store.getThread(worker.thread.id)).boundPr?.mergeWhenReady?.hold).toBe(
                "independent review",
              );
              expect(world.ghCalls.filter((c) => c[2] === "merge")).toEqual([]);
              expect(yield* store.listRequests(root.thread.id)).toEqual([]);
            }),
          );
        }).pipe(Effect.scoped),
    );
  }

  it.effect.skipIf(!hasGit)(
    "reuses the approved recovery intent for its Full Auto orchestrator release",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const store = yield* ThreadStore;
            const { root, worker, merge, input } = yield* approvedRecovery(world);
            const before = yield* store.getThread(worker.thread.id);
            expect(before.boundPr?.mergeWhenReady).toMatchObject({
              allowedBy: "user",
              heldBy: "orchestrator",
            });
            expect(yield* merge.delegatedAtFullAutonomy!(input)).toBe(true);
            yield* merge.run(input);
            const after = yield* store.getThread(worker.thread.id);
            expect(after.boundPr?.mergeWhenReady).toMatchObject({
              allowedBy: "user",
              method: "squash",
            });
            expect(after.boundPr?.mergeWhenReady?.hold).toBeUndefined();
            expect(after.ownedBranches).toEqual(before.ownedBranches);
            expect(yield* store.listRequests(root.thread.id)).toEqual([]);
            yield* publishGit(world, after, { pr: armedWorkerBadge(true) });
            yield* waitReal(
              "released recovery merge",
              store
                .getThread(worker.thread.id)
                .pipe(Effect.map((t) => t.boundPr?.mergeWhenReady === undefined)),
            );
            expect(world.freshPrReads).toContain("acme/app#12");
            expect(world.ghCalls.filter((c) => c[2] === "merge")).toEqual([
              [
                "gh",
                "pr",
                "merge",
                "12",
                "--squash",
                "--match-head-commit",
                "h1",
                "--repo",
                "acme/app",
              ],
            ]);
          }),
        );
      }).pipe(Effect.scoped),
  );

  for (const change of [
    "identity CI",
    "identity policy",
    "identity project",
    "identity checkout",
    "fresh park",
    "fresh caller",
    "fresh autonomy",
    "fresh policy",
  ] as const) {
    it.effect.skipIf(!hasGit)(`approved recovery launch refuses ${change} after provider I/O`, () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const store = yield* ThreadStore;
            const gate = yield* MergeWhenReady;
            const { root, worker, merge, input } = yield* approvedRecovery(world);
            yield* merge.run(input);
            const other = yield* store.ensureProject({ root: world.dir, name: "other" });
            let observed = false;
            const race = Effect.gen(function* () {
              world.prHeadRead = undefined;
              world.freshPrRead = undefined;
              if (change === "identity CI")
                world.prBadges.set(
                  "acme/app#12",
                  ready({
                    number: 12,
                    url: "https://github.com/acme/app/pull/12",
                    checks: "failing",
                  }),
                );
              if (change === "identity policy")
                yield* store.updateSettings((settings) => ({ ...settings, reviewBots: [] }));
              if (change === "identity project")
                yield* store.updateWorkspace(root.workspaceId, (state) => ({
                  ...state,
                  workspace: {
                    ...state.workspace,
                    projectIds: [other.id],
                    homeProjectId: other.id,
                  },
                }));
              if (change === "identity checkout")
                yield* store.updateThread(worker.thread.id, (t) => ({
                  ...t,
                  checkout: { ...t.checkout, repoRoot: world.dir },
                }));
              if (change === "fresh park" || change === "fresh caller")
                yield* store.updateThread(
                  change === "fresh caller" ? root.thread.id : worker.thread.id,
                  (t) => ({ ...t, parked: true }),
                );
              if (change === "fresh autonomy")
                yield* store.updateWorkspace(root.workspaceId, (state) => ({
                  ...state,
                  charter: { ...state.charter!, autonomy: "publish" },
                }));
              if (change === "fresh policy")
                yield* store.updateSettings((settings) => ({ ...settings, reviewBots: [] }));
              observed = true;
            }).pipe(Effect.orDie);
            if (change.startsWith("identity")) world.prHeadRead = race;
            else world.freshPrRead = race;
            yield* publishGit(world, yield* store.getThread(worker.thread.id), {
              pr: armedWorkerBadge(true),
            });
            yield* gate.check(worker.thread.id);
            yield* waitReal(
              "launch race reached",
              Effect.sync(() => observed || undefined),
            );
            yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 30)));
            expect(world.ghCalls.filter((c) => c[2] === "merge")).toEqual([]);
            expect(
              (yield* store.getThread(worker.thread.id)).boundPr?.mergeWhenReady,
            ).toBeDefined();
          }),
        );
      }).pipe(Effect.scoped),
    );
  }

  it.effect.skipIf(!hasGit)(
    "approved recovery retains its explicitly approved effective rebase method",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const store = yield* ThreadStore;
            const { root, worker, merge, input } = yield* approvedRecovery(world, "rebase");
            expect(yield* merge.delegatedAtFullAutonomy!(input)).toBe(true);
            yield* merge.run(input);
            expect(
              (yield* store.getThread(worker.thread.id)).boundPr?.mergeWhenReady,
            ).toMatchObject({ method: "rebase", allowedBy: "user" });
            expect(yield* store.listRequests(root.thread.id)).toEqual([]);
          }),
        );
      }).pipe(Effect.scoped),
  );

  for (const extra of [false, true]) {
    it.effect.skipIf(!hasGit)(
      `arming remembers an unsampled branch in ${extra ? "an extra" : "the main"} worktree`,
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
              const worker = yield* spawn(session, { feature: "unsampled" });
              yield* completeTurn(worker.session);
              yield* atAutonomy(thread, "full");
              const path = extra ? `${world.dir}/extra-worktree` : worker.thread.checkout.path;
              if (extra) {
                run(world.repo, "worktree", "add", "-b", "feat/extra-start", path);
                yield* runtimes.updateThread(worker.thread.id, (t) => ({
                  ...t,
                  extraCheckouts: [
                    { kind: "worktree", path, repoRoot: world.repo, branch: "feat/extra-start" },
                  ],
                }));
              }
              run(path, "switch", "-c", "feat/unsampled-stack");
              world.prHeads.set(13, { headRefName: "feat/unsampled-stack" });
              const merge = registry
                .forTransport(worker.thread.id, "worker")
                .find((t) => t.descriptor.name === "merge_when_ready")!;
              const before = (yield* store.getThread(worker.thread.id)).ownedBranches;
              expect(yield* merge.delegatedAtFullAutonomy!({ pr: 13 })).toBe(true);
              expect((yield* store.getThread(worker.thread.id)).ownedBranches).toEqual(before);
              yield* merge.run({ pr: 13 });
              expect((yield* store.getThread(worker.thread.id)).ownedBranches ?? []).toContainEqual(
                {
                  path,
                  branch: "feat/unsampled-stack",
                },
              );
              run(path, "switch", "-c", "feat/next-stack");
              // No branch observation between arming and switching; only the PR's readiness changes.
              yield* publishGit(world, yield* store.getThread(worker.thread.id), {
                pr: ready({
                  number: 13,
                  url: "https://github.com/acme/app/pull/13",
                }),
              });
              yield* waitReal(
                "the unsampled PR merged",
                store
                  .getThread(worker.thread.id)
                  .pipe(Effect.map((t) => t.boundPr?.mergeWhenReady === undefined)),
              );
              expect(world.ghCalls.filter((c) => c[2] === "merge")).toEqual([
                [
                  "gh",
                  "pr",
                  "merge",
                  "13",
                  "--squash",
                  "--match-head-commit",
                  "h1",
                  "--repo",
                  "acme/app",
                ],
              ]);
              expect(yield* store.listRequests(worker.thread.id)).toEqual([]);
            }),
          );
        }).pipe(Effect.scoped),
    );
  }
});
