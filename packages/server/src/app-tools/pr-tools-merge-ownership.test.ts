// merge_when_ready: unbinding, worker ownership and stacked PRs.
import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_CHARTER } from "@gram/contracts";
import { Proc } from "@gram/git";
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
  openProject,
  waitSent,
  publishGit,
  spawn,
  waitReal,
  withServer,
} from "../orchestration/test-harness.ts";
import { Orchestration } from "../orchestration/service.ts";
import { workerPrBlocker, withOwnedBranch } from "../git/worker-pr.ts";
import { AppToolRegistry } from "./registry.ts";
import { ready, armedWorkerBadge } from "./pr-tools-kit.ts";

describe("merge_when_ready", () => {
  for (const change of ["unbind", "head branch", "hold"] as const) {
    it.effect.skipIf(!hasGit)(`rechecks a waived target after ${change}`, () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const store = yield* ThreadStore;
            const runtimes = yield* ThreadRuntimes;
            const registry = yield* AppToolRegistry;
            const { session, thread } = yield* openOrchestrator(world);
            const worker = yield* spawn(session, { feature: "recheck" });
            yield* completeTurn(worker.session);
            yield* atAutonomy(thread, "full");
            world.prHeads.set(12, { headRefName: worker.thread.checkout.branch! });
            yield* registry
              .forThread(worker.thread.id, "worker")
              .find((t) => t.descriptor.name === "pr_bind")!
              .run({ repo: "acme/app", number: 12 });
            const definition = registry.definitions.find(
              (t) => t.descriptor.name === "merge_when_ready",
            )!;
            const target = yield* definition.resolve!(worker.thread.id, {});
            expect(yield* definition.delegatedAtFullAutonomy!(worker.thread.id, {}, target)).toBe(
              true,
            );
            if (change === "unbind") {
              yield* runtimes.updateThread(worker.thread.id, ({ boundPr: _bound, ...t }) => t);
            } else if (change === "head branch") {
              world.prHeads.set(12, { headRefName: "feat/foreign" });
            } else {
              yield* runtimes.updateThread(worker.thread.id, (t) => ({
                ...t,
                boundPr: {
                  ...t.boundPr!,
                  mergeWhenReady: {
                    allowedBy: "autonomy",
                    method: "squash",
                    heldBy: "orchestrator",
                    hold: "release order",
                    setAt: 0,
                  },
                },
              }));
            }
            const result = definition.handle(worker.thread.id, target, { carded: false });
            if (change === "unbind") {
              yield* result;
              expect((yield* store.getThread(worker.thread.id)).boundPr).toMatchObject({
                number: 12,
                mergeWhenReady: { allowedBy: "autonomy" },
              });
            } else {
              expect((yield* result.pipe(Effect.flip)).message).toContain(
                "changed during the call",
              );
            }
            expect(world.ghCalls.filter((c) => c[2] === "merge")).toEqual([]);
          }),
        );
      }).pipe(Effect.scoped),
    );
  }

  for (const unbound of [true, false]) {
    it.effect.skipIf(!hasGit)(`waives a worker's own PR when unbound=${unbound}`, () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const store = yield* ThreadStore;
            const registry = yield* AppToolRegistry;
            const { session, thread } = yield* openOrchestrator(world);
            const worker = yield* spawn(session, { feature: "new-pr" });
            yield* completeTurn(worker.session);
            yield* atAutonomy(thread, "full");
            world.prHeads.set(12, { headRefName: worker.thread.checkout.branch! });
            const tools = registry.forTransport(worker.thread.id, "worker");
            if (!unbound)
              yield* tools
                .find((t) => t.descriptor.name === "pr_bind")!
                .run({ repo: "acme/app", number: 12 });
            yield* publishGit(world, worker.thread, { pr: armedWorkerBadge(false) });
            const merge = tools.find((t) => t.descriptor.name === "merge_when_ready")!;
            expect(yield* merge.delegatedAtFullAutonomy!({})).toBe(true);
            yield* merge.run({});
            expect(
              (yield* store.getThread(worker.thread.id)).boundPr?.mergeWhenReady,
            ).toMatchObject({ allowedBy: "autonomy" });
            expect(yield* store.listRequests(worker.thread.id)).toEqual([]);
          }),
        );
      }).pipe(Effect.scoped),
    );
  }

  it.effect.skipIf(!hasGit)("remembers branches a worker observed in its held worktree", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      yield* withServer(
        world,
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const registry = yield* AppToolRegistry;
          const { session, thread } = yield* openOrchestrator(world);
          const worker = yield* spawn(session, { feature: "stacked-pr" });
          yield* completeTurn(worker.session);
          yield* atAutonomy(thread, "full");
          run(worker.thread.checkout.path, "switch", "-c", "feat/stacked");
          yield* publishGit(world, worker.thread, { branch: "feat/stacked" });
          run(worker.thread.checkout.path, "switch", worker.thread.checkout.branch!);
          yield* publishGit(world, worker.thread, { branch: worker.thread.checkout.branch! });
          world.prHeads.set(13, { headRefName: "feat/stacked" });
          const tools = registry.forTransport(worker.thread.id, "worker");
          yield* tools
            .find((t) => t.descriptor.name === "pr_bind")!
            .run({ repo: "acme/app", number: 13 });
          const merge = tools.find((t) => t.descriptor.name === "merge_when_ready")!;
          expect(yield* merge.delegatedAtFullAutonomy!({})).toBe(true);
          yield* merge.run({});
          expect((yield* store.getThread(worker.thread.id)).boundPr?.mergeWhenReady).toMatchObject({
            allowedBy: "autonomy",
          });
          const latest = yield* store.getThread(worker.thread.id);
          yield* publishGit(world, latest, {
            pr: ready({ number: 13, url: "https://github.com/acme/app/pull/13" }),
          });
          yield* waitReal(
            "the stacked PR merged",
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
        }),
      );
    }).pipe(Effect.scoped),
  );

  for (const scenario of [
    "fork",
    "other worker",
    "never held",
    "outside repo",
    "closed",
    "supervised",
    "publish",
    "orchestrator hold",
  ] as const) {
    it.effect.skipIf(!hasGit)(`keeps a card for ${scenario}`, () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const store = yield* ThreadStore;
            const runtimes = yield* ThreadRuntimes;
            const registry = yield* AppToolRegistry;
            const { session, thread } = yield* openOrchestrator(world);
            const worker = yield* spawn(session, { feature: "ownership" });
            yield* completeTurn(worker.session);
            yield* atAutonomy(thread, "full");
            if (scenario === "supervised" || scenario === "publish") {
              yield* store.updateWorkspace(thread.workspaceId!, (state) => ({
                ...state,
                charter: { ...state.charter, autonomy: scenario },
              }));
            }
            let headRefName = worker.thread.checkout.branch!;
            if (scenario === "other worker") {
              const other = yield* spawn(session, { feature: "other-owner" });
              yield* completeTurn(other.session);
              headRefName = other.thread.checkout.branch!;
            }
            if (scenario === "never held") headRefName = "feat/never-held";
            world.prHeads.set(12, {
              headRefName,
              ...(scenario === "fork" ? { fork: true } : {}),
              ...(scenario === "closed" ? { state: "CLOSED" } : {}),
            });
            const repo = scenario === "outside repo" ? "elsewhere/tools" : "acme/app";
            yield* runtimes.updateThread(worker.thread.id, (t) => ({
              ...t,
              boundPr: {
                repo,
                number: 12,
                monitor: false,
                ...(scenario === "orchestrator hold"
                  ? {
                      mergeWhenReady: {
                        method: "squash" as const,
                        allowedBy: "autonomy" as const,
                        hold: "release order",
                        heldBy: "orchestrator" as const,
                        setAt: 0,
                      },
                    }
                  : {}),
              },
            }));
            const merge = registry
              .forTransport(worker.thread.id, "worker")
              .find((t) => t.descriptor.name === "merge_when_ready")!;
            expect(yield* merge.delegatedAtFullAutonomy!({})).toBe(false);
            const before = (yield* store.getThread(worker.thread.id)).boundPr;
            const call = yield* Effect.forkScoped(merge.run({ release: true }).pipe(Effect.flip));
            const card = yield* waitReal(
              "the approval card",
              store.listRequests(worker.thread.id).pipe(Effect.map((all) => all[0])),
            );
            expect(card).toMatchObject({ displayName: "merge_when_ready", scopes: ["once"] });
            yield* runtimes.respond(worker.thread.id, card.id, {
              kind: "approval",
              decision: "deny",
              scope: "once",
            });
            expect(yield* Fiber.join(call)).toMatchObject({ approvalRequired: true });
            expect((yield* store.getThread(worker.thread.id)).boundPr).toEqual(before);
            expect(world.ghCalls.filter((c) => c[2] === "merge")).toEqual([]);
          }),
        );
      }).pipe(Effect.scoped),
    );
  }

  for (const registered of [true, false]) {
    it.effect.skipIf(!hasGit)(
      `follow-on PR in a ${registered ? "registered" : "followed-only"} physical worktree keeps ownership scope`,
      () =>
        Effect.gen(function* () {
          const world = yield* makeWorld;
          yield* withServer(
            world,
            Effect.gen(function* () {
              const store = yield* ThreadStore;
              const runtimes = yield* ThreadRuntimes;
              const registry = yield* AppToolRegistry;
              yield* store.updateSettings((settings) => ({
                ...settings,
                agents: {
                  ...settings.agents,
                  defaultModel: { agent: "claude", model: "sonnet" },
                },
              }));
              const project = yield* openProject(world);
              const orchestration = yield* Orchestration;
              const state = yield* orchestration.saveWorkspace({
                name: "invented-full-workspace",
                projectIds: [project.id],
                homeProjectId: project.id,
              });
              yield* orchestration.setCharter(state.workspace.id, {
                ...DEFAULT_CHARTER,
                autonomy: "full",
                orchestratorModel: { agent: "codex", model: "gpt-6.1-sol" },
              });
              const thread = yield* orchestration.open({ projectId: project.id });
              const rootSession = yield* waitSent(thread.id, 1);
              yield* completeTurn(rootSession);
              const worker = yield* spawn(rootSession, { feature: "physical-follow-on" });
              yield* completeTurn(worker.session);
              expect((yield* store.getThread(thread.id)).model.agent).toBe("codex");
              expect((yield* store.getThread(thread.id)).mode).toBe("bypassPermissions");
              const path = `${world.dir}/physical-evidence-source`;
              run(world.repo, "worktree", "add", "-b", "feat/evidence", path);
              world.prHeads.set(13, { headRefName: "feat/evidence" });
              const checkout = {
                kind: "worktree" as const,
                path,
                repoRoot: world.repo,
                branch: "feat/evidence",
              };
              yield* runtimes.updateThread(worker.thread.id, (t) => ({
                ...t,
                ...(registered ? { extraCheckouts: [checkout] } : { currentCheckout: checkout }),
              }));
              const workerTools = registry.forTransport(worker.thread.id, "worker");
              const bind = workerTools.find((t) => t.descriptor.name === "pr_bind")!;
              yield* bind.run({ repo: "acme/app", number: 12 });
              yield* bind.run({ repo: "acme/app", number: 13, add: true });
              const merge = registry
                .forTransport(thread.id, "orchestrator")
                .find((t) => t.descriptor.name === "merge_when_ready")!;
              // Following PR 13 beside cached PR 12 confers no ownership; select 13 explicitly.
              expect((yield* store.getThread(worker.thread.id)).boundPr?.number).toBe(12);
              const input = {
                threadId: worker.thread.id,
                pr: "acme/app#13",
                hold: "Independent review",
              };
              expect(yield* merge.delegatedAtFullAutonomy!(input)).toBe(registered);
              if (registered) {
                yield* merge.run(input);
                const latest = yield* store.getThread(worker.thread.id);
                expect(latest.boundPr).toMatchObject({
                  number: 13,
                  mergeWhenReady: {
                    allowedBy: "autonomy",
                    heldBy: "orchestrator",
                    hold: "Independent review",
                  },
                });
                expect(latest.ownedBranches).toContainEqual({ path, branch: "feat/evidence" });
                expect(yield* store.listRequests(thread.id)).toEqual([]);
              } else {
                const before = (yield* store.getThread(worker.thread.id)).boundPr;
                const call = yield* Effect.forkScoped(merge.run(input).pipe(Effect.flip));
                const card = yield* waitReal(
                  "approval for unowned physical branch",
                  store.listRequests(thread.id).pipe(Effect.map(([r]) => r)),
                );
                expect(card).toMatchObject({
                  kind: "approval",
                  displayName: "merge_when_ready",
                  scopes: ["once"],
                });
                if (card.kind === "approval")
                  expect(card.description).toContain("ownership could not be verified");
                yield* runtimes.respond(thread.id, card.id, {
                  kind: "approval",
                  decision: "deny",
                  scope: "once",
                });
                expect(yield* Fiber.join(call)).toMatchObject({
                  message: "The user declined merge_when_ready.",
                  approvalResolution: { origin: "user", reason: "rejected", requestId: card.id },
                });
                expect((yield* store.getThread(worker.thread.id)).boundPr).toEqual(before);
                // A pending actual merge call spanning the orchestrator's turn end is a runtime
                // withdrawal, even in Full Auto/Bypass. It neither changes intent nor grants ownership.
                yield* runtimes.send(thread.id, { text: "invented root turn with nested merge" });
                yield* waitReal(
                  "root turn running",
                  runtimes.status(thread.id).pipe(Effect.map((s) => s === "running")),
                );
                const pending = yield* Effect.forkScoped(merge.run(input).pipe(Effect.flip));
                const waiting = yield* waitReal(
                  "a new approval card",
                  store.listRequests(thread.id).pipe(Effect.map(([r]) => r)),
                );
                // The orchestrator may immediately start a delivery turn; waiting for idle is
                // not the synchronization point. Await the cancelled request's own receipt.
                yield* rootSession.emit({ type: "turnEnd", reason: "completed" });
                expect(yield* Fiber.join(pending)).toMatchObject({
                  approvalResolution: {
                    origin: "runtime",
                    reason: "turn-completed",
                    requestId: waiting.id,
                  },
                });
                expect((yield* store.getThread(worker.thread.id)).boundPr).toEqual(before);
              }
              expect(world.ghCalls.filter((c) => c[2] === "merge")).toEqual([]);
            }),
          );
        }).pipe(Effect.scoped),
    );
  }

  it.effect.skipIf(!hasGit)("an orchestrator can target a worker's stacked PR by reference", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      yield* withServer(
        world,
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const registry = yield* AppToolRegistry;
          const { session, thread } = yield* openOrchestrator(world);
          const worker = yield* spawn(session, { feature: "stack-target" });
          yield* completeTurn(worker.session);
          yield* atAutonomy(thread, "full");
          run(worker.thread.checkout.path, "switch", "-c", "feat/stack-next");
          world.prHeads.set(13, { headRefName: "feat/stack-next" });
          const tools = registry.forTransport(worker.thread.id, "worker");
          yield* tools
            .find((t) => t.descriptor.name === "pr_bind")!
            .run({ repo: "acme/app", number: 12 });
          const merge = registry
            .forTransport(thread.id, "orchestrator")
            .find((t) => t.descriptor.name === "merge_when_ready")!;
          for (const pr of [13, "acme/app#13", "https://github.com/acme/app/pull/13"]) {
            expect(yield* merge.delegatedAtFullAutonomy!({ threadId: worker.thread.id, pr })).toBe(
              true,
            );
          }
          yield* merge.run({
            threadId: worker.thread.id,
            pr: "acme/app#13",
            after: ["acme/app#12"],
          });
          const latest = yield* store.getThread(worker.thread.id);
          expect(latest.boundPr).toMatchObject({
            number: 13,
            mergeWhenReady: { allowedBy: "autonomy", heldBy: "orchestrator" },
          });
          yield* publishGit(world, latest, { branch: "feat/stack-next" });
          expect((yield* store.getThread(worker.thread.id)).ownedBranches).toContainEqual({
            path: worker.thread.checkout.path,
            branch: "feat/stack-next",
          });
          expect(yield* store.listRequests(thread.id)).toEqual([]);
          const workerMerge = tools.find((t) => t.descriptor.name === "merge_when_ready")!;
          for (const release of [
            { release: true },
            { hold: null },
            { hold: "" },
            { hold: "   " },
          ]) {
            const held = yield* registry
              .forThread(worker.thread.id, "worker")
              .find((t) => t.descriptor.name === "merge_when_ready")!
              .run(release)
              .pipe(Effect.flip);
            expect(held.message).toContain("only it can lift");
          }
          expect(yield* workerMerge.delegatedAtFullAutonomy!({ pr: "acme/app#13" })).toBe(false);
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(!hasGit)(
    "does not inherit observed branches from a followed or released worktree",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const store = yield* ThreadStore;
            const runtimes = yield* ThreadRuntimes;
            const { session } = yield* openOrchestrator(world);
            const worker = yield* spawn(session, { feature: "held-boundary" });
            yield* completeTurn(worker.session);
            const foreign = { ...worker.thread.checkout, path: world.repo, branch: "feat/foreign" };
            const following = { ...worker.thread, currentCheckout: foreign };
            expect(withOwnedBranch(following, foreign.path, foreign.branch)).toBe(following);
            world.prHeads.set(13, { headRefName: "feat/released" });
            const released = yield* runtimes.updateThread(worker.thread.id, (t) => ({
              ...t,
              ownedBranches: [{ path: world.repo, branch: "feat/released" }],
            }));
            expect(
              yield* workerPrBlocker(released, "acme/app", 13).pipe(
                Effect.provideService(Proc, {
                  run: (bin, args) =>
                    Effect.succeed({
                      status: 0,
                      stdout:
                        bin === "git"
                          ? args[0] === "symbolic-ref"
                            ? released.checkout.branch!
                            : "https://github.com/acme/app.git"
                          : JSON.stringify({
                              number: 13,
                              url: "https://github.com/acme/app/pull/13",
                              headRefName: "feat/released",
                              state: "OPEN",
                              isCrossRepository: false,
                            }),
                      stderr: "",
                      truncated: false,
                    }),
                }),
              ),
            ).toContain("head branch");
            expect((yield* store.getThread(worker.thread.id)).checkout).toEqual(
              worker.thread.checkout,
            );
          }),
        );
      }).pipe(Effect.scoped),
  );
});
