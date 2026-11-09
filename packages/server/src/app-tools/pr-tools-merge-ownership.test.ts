// merge_when_ready: unbinding, worker ownership and stacked PRs.
import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_CHARTER, type GitState, HostId, initialBabysitState } from "@gram/contracts";
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
import { cloneFoldersOf } from "../host/repos.ts";
import { AppToolRegistry } from "./registry.ts";
import { ready, armedWorkerBadge } from "./pr-tools-kit.ts";

/** A worktree on a joined machine with `branch` checked out, as its host reads it. */
const gitThere = (branch: string): GitState => ({
  repo: true,
  branch,
  worktree: true,
  head: "h1",
  changesToken: "",
  changedFiles: 0,
  behindBase: 0,
  aheadBase: 0,
  conflicts: false,
});

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
            // Only ownership is explained as an exception to full auto; other cards say nothing more.
            const explained: Partial<Record<typeof scenario, string>> = {
              fork: "its branch is on a fork, not in the repository itself",
              "other worker": "its branch isn't checked out in a worktree Gram gave the worker",
              "never held": "its branch isn't checked out in a worktree Gram gave the worker",
              "outside repo":
                "its repository isn't a workspace project the worker has a worktree in",
              closed: "it is closed, not open",
            };
            const reason = explained[scenario];
            if (card.kind !== "approval") throw new Error("not an approval");
            expect(card.description).not.toContain("ownership");
            if (reason === undefined) {
              expect(card.decisionReason).toBeUndefined();
              expect(card.autonomyNote).toBeUndefined();
            } else {
              expect(card.decisionReason).toBe(
                `Full auto merges a worker's own pull requests without asking, but Gram couldn't confirm this one is the worker's own: ${reason}. Approve to merge it once checks pass.`,
              );
              expect(card.autonomyNote).toBe(`full auto, PR ownership unverified: ${reason}`);
              // The orchestrator's ledger line leads with the tag, inside what the line keeps.
              const ledger = yield* (yield* Orchestration).ledger(thread.workspaceId!);
              const row = ledger.features
                .flatMap((feature) => feature.workers)
                .find((w) => w.threadId === worker.thread.id);
              expect(row?.pendingRequests[0]?.summary?.slice(0, 200)).toContain(
                `merge_when_ready (full auto, PR ownership unverified: ${reason}): Merge ${scenario === "outside repo" ? "elsewhere/tools" : "acme/app"}#12`,
              );
            }
            yield* runtimes.respond(worker.thread.id, card.id, {
              kind: "approval",
              decision: "deny",
              scope: "once",
            });
            const refused = yield* Fiber.join(call);
            expect(refused).toMatchObject({ approvalRequired: true });
            if (reason === undefined)
              expect(refused.message).toBe("The user declined merge_when_ready.");
            else
              expect(refused.message).toBe(
                `The user declined merge_when_ready. It needed the user: Full auto covers only a worker's own pull request, and Gram couldn't confirm this one is the worker's own: ${reason}. ${
                  {
                    fork: "Push the branch to the repository from the worktree Gram gave you and open the pull request from there. Gram can then merge it without asking.",
                    "other worker":
                      "Check the branch out inside the worktree Gram gave you (or ask your orchestrator to start a fresh worker for the follow-up), then call again. Gram can then merge it without asking.",
                    "never held":
                      "Check the branch out inside the worktree Gram gave you (or ask your orchestrator to start a fresh worker for the follow-up), then call again. Gram can then merge it without asking.",
                    "outside repo":
                      "Open the pull request from the worktree Gram gave you; for a repository outside the workspace, the user has to add it or approve this.",
                    closed: "There is nothing to merge; check it with pr_status.",
                  }[scenario as "fork"]
                }`,
              );
            expect((yield* store.getThread(worker.thread.id)).boundPr).toEqual(before);
            expect(world.ghCalls.filter((c) => c[2] === "merge")).toEqual([]);
          }),
        );
      }).pipe(Effect.scoped),
    );
  }

  it.effect.skipIf(!hasGit)("tells a worker approved past full auto why it was asked", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      yield* withServer(
        world,
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const runtimes = yield* ThreadRuntimes;
          const registry = yield* AppToolRegistry;
          const { session, thread } = yield* openOrchestrator(world);
          const worker = yield* spawn(session, { feature: "own-worktree" });
          yield* completeTurn(worker.session);
          yield* atAutonomy(thread, "full");
          // The follow-up's branch was checked out in a worktree the worker made for itself.
          world.prHeads.set(12, { headRefName: "feat/self-made" });
          yield* runtimes.updateThread(worker.thread.id, (t) => ({
            ...t,
            boundPr: { repo: "acme/app", number: 12, monitor: false },
          }));
          const merge = registry
            .forTransport(worker.thread.id, "worker")
            .find((t) => t.descriptor.name === "merge_when_ready")!;
          const call = yield* Effect.forkScoped(merge.run({}));
          const card = yield* waitReal(
            "the approval card",
            store.listRequests(worker.thread.id).pipe(Effect.map((all) => all[0])),
          );
          yield* runtimes.respond(worker.thread.id, card.id, {
            kind: "approval",
            decision: "allow",
            scope: "once",
          });
          expect(yield* Fiber.join(call)).toMatchObject({
            approvalNeededBecause:
              "Full auto covers only a worker's own pull request, and Gram couldn't confirm this one is the worker's own: its branch isn't checked out in a worktree Gram gave the worker. Check the branch out inside the worktree Gram gave you (or ask your orchestrator to start a fresh worker for the follow-up), then call again. Gram can then merge it without asking.",
          });
          expect((yield* store.getThread(worker.thread.id)).boundPr?.mergeWhenReady).toMatchObject({
            allowedBy: "user",
          });
        }),
      );
    }).pipe(Effect.scoped),
  );

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
                if (card.kind !== "approval") throw new Error("not an approval");
                expect(card.decisionReason).toBe(
                  "Full auto merges a worker's own pull requests without asking, but Gram couldn't confirm this one is the worker's own: its branch isn't checked out in a worktree Gram gave the worker. Approve to merge it once checks pass.",
                );
                yield* runtimes.respond(thread.id, card.id, {
                  kind: "approval",
                  decision: "deny",
                  scope: "once",
                });
                expect(yield* Fiber.join(call)).toMatchObject({
                  message:
                    "The user declined merge_when_ready. It needed the user: Full auto covers only a worker's own pull request, and Gram couldn't confirm this one is the worker's own: its branch isn't checked out in a worktree Gram gave the worker. Have the worker check the branch out inside the worktree Gram gave it, or start a fresh worker for the follow-up. Gram can then merge it without asking.",
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
                const withdrawn = yield* Fiber.join(pending);
                expect(withdrawn.message).toContain(
                  "It needed the user: Full auto covers only a worker's own pull request",
                );
                expect(withdrawn).toMatchObject({
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
    "an active Watch PR hands the merge to the user; a stopped one lets Gram merge",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const runtimes = yield* ThreadRuntimes;
            const registry = yield* AppToolRegistry;
            const { session } = yield* openOrchestrator(world);
            const worker = yield* spawn(session, { feature: "watch-merge" });
            yield* completeTurn(worker.session);
            world.prHeads.set(12, { headRefName: worker.thread.checkout.branch! });
            yield* registry
              .forThread(worker.thread.id, "worker")
              .find((t) => t.descriptor.name === "pr_bind")!
              .run({ repo: "acme/app", number: 12 });
            const definition = registry.definitions.find(
              (t) => t.descriptor.name === "merge_when_ready",
            )!;

            // While Watch PR is actively watching, the merge is the user's: refused in plain words.
            yield* runtimes.updateThread(worker.thread.id, (t) => ({
              ...t,
              babysit: initialBabysitState(1),
            }));
            const refused = yield* definition.resolve!(worker.thread.id, {}).pipe(Effect.flip);
            expect(refused.message).toContain("Watch PR is on");
            expect(refused.message).not.toContain("Not in babysit mode");

            // Once Watch PR has stopped, it no longer holds the merge: resolve goes through.
            yield* runtimes.updateThread(worker.thread.id, (t) => ({
              ...t,
              babysit: {
                ...initialBabysitState(1),
                phase: "stopped" as const,
                stopReason: "rounds" as const,
              },
            }));
            const target = yield* definition.resolve!(worker.thread.id, {});
            expect((target as { pr?: { repo: string; number: number } }).pr).toMatchObject({
              repo: "acme/app",
              number: 12,
            });
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

  describe("on a joined machine", () => {
    const MACHINE = HostId.make("m-0123456789abcdef01234567");
    /** The host's clone of the project's origin, in the folder its identity names. */
    const CLONE = `/home/invented/gram-host/repos/${cloneFoldersOf("https://github.com/acme/app.git")![0]}`;
    const WORKTREE = "/home/invented/gram-host/worktrees/app/feat-remote";

    for (const scenario of [
      "own",
      "switched there",
      "foreign branch",
      "offline",
      "other clone",
    ] as const) {
      it.effect.skipIf(!hasGit)(
        scenario === "own"
          ? "arms a worker's own PR from its worktree there without a card"
          : scenario === "switched there"
            ? "reads the branch checked out there from its host"
            : `keeps a card for ${scenario}`,
        () =>
          Effect.gen(function* () {
            const world = yield* makeWorld;
            const worktrees = new Map<string, GitState>();
            world.joinedMachine = { id: MACHINE, online: scenario !== "offline", worktrees };
            yield* withServer(
              world,
              Effect.gen(function* () {
                const store = yield* ThreadStore;
                const runtimes = yield* ThreadRuntimes;
                const registry = yield* AppToolRegistry;
                const { session, thread } = yield* openOrchestrator(world);
                const worker = yield* spawn(session, { feature: "remote-own" });
                yield* completeTurn(worker.session);
                yield* atAutonomy(thread, "full");
                const branch = "feat/remote-own";
                // The worktree Gram made for it there, from the machine's clone of the project.
                yield* runtimes.updateThread(worker.thread.id, (t) => ({
                  ...t,
                  checkout: {
                    kind: "worktree" as const,
                    path: WORKTREE,
                    repoRoot:
                      scenario === "other clone"
                        ? "/home/invented/gram-host/repos/github.com/elsewhere/app"
                        : CLONE,
                    branch,
                    hostId: MACHINE,
                  },
                  boundPr: { repo: "acme/app", number: 12, monitor: false },
                }));
                // Its agent may switch branches there: the host's HEAD counts, as one here does.
                const checkedOut = scenario === "switched there" ? "feat/remote-next" : branch;
                worktrees.set(WORKTREE, gitThere(checkedOut));
                world.prHeads.set(12, {
                  headRefName: scenario === "foreign branch" ? "feat/by-hand" : checkedOut,
                });
                const merge = registry
                  .forTransport(worker.thread.id, "worker")
                  .find((t) => t.descriptor.name === "merge_when_ready")!;
                if (scenario === "own" || scenario === "switched there") {
                  expect(yield* merge.delegatedAtFullAutonomy!({})).toBe(true);
                  yield* merge.run({});
                  expect(
                    (yield* store.getThread(worker.thread.id)).boundPr?.mergeWhenReady,
                  ).toMatchObject({ allowedBy: "autonomy" });
                  expect(yield* store.listRequests(worker.thread.id)).toEqual([]);
                  return;
                }
                expect(yield* merge.delegatedAtFullAutonomy!({})).toBe(false);
                const call = yield* Effect.forkScoped(merge.run({}).pipe(Effect.flip));
                const card = yield* waitReal(
                  "the approval card",
                  store.listRequests(worker.thread.id).pipe(Effect.map((all) => all[0])),
                );
                if (card.kind !== "approval") throw new Error("not an approval");
                const reason = {
                  "foreign branch":
                    "its branch isn't checked out in a worktree Gram gave the worker",
                  offline: "Gram couldn't read the worker's worktree or the pull request on GitHub",
                  "other clone":
                    "its repository isn't a workspace project the worker has a worktree in",
                }[scenario];
                expect(card.autonomyNote).toBe(`full auto, PR ownership unverified: ${reason}`);
                yield* runtimes.respond(worker.thread.id, card.id, {
                  kind: "approval",
                  decision: "deny",
                  scope: "once",
                });
                expect(yield* Fiber.join(call)).toMatchObject({ approvalRequired: true });
                expect(
                  (yield* store.getThread(worker.thread.id)).boundPr?.mergeWhenReady,
                ).toBeUndefined();
              }),
            );
          }).pipe(Effect.scoped),
      );
    }
  });
});
