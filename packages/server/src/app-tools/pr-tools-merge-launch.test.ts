// merge_when_ready: the launch, pauses during it, its lock, bot policy and holds.
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeKeyedLock } from "../git/keyed-lock.ts";
import { diagnoseExit } from "../git/local-checks.ts";
import { mergeBlocker, MergeWhenReady, parsePrRef } from "../git/merge-when-ready.ts";
import { GitStatePublisher } from "../git/publisher.ts";
import { eventually, hasGit, run } from "../git/test-repo.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { SqlClient } from "../platform/unstable.ts";
import { FakeAgentControl } from "../runtime/fake-agent.ts";
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
  type World,
} from "../orchestration/test-harness.ts";
import { Orchestration } from "../orchestration/service.ts";
import { AppToolRegistry } from "./registry.ts";
import {
  current,
  ghCalls,
  ok,
  gh,
  badge,
  mergeCall,
  command,
  liveThread,
  sentTo,
  MergeTestLayer,
  ready,
  armedWorkerBadge,
} from "./pr-tools-kit.ts";

const prMerges = () => ghCalls.filter((call) => command(call.slice(1)) === "pr merge");

/**
 * A worker under solo policy with its PR bound, on a branch one commit ahead of `main`, while
 * `main` moved on by a commit of its own. `runner` is Gram's own check, run in place of
 * `bun run check:ci`.
 */
const soloPr = (world: World, configured = true) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const registry = yield* AppToolRegistry;
    const { session, thread, workspaceId } = yield* openOrchestrator(world);
    const project = (yield* store.listProjects).find((p) => p.id === thread.projectId)!;
    if (configured)
      yield* store.updateProjectLocalCheckAudited(
        project.id,
        [
          {
            key: "project.localCheck.command",
            path: ["localCheck", "command"],
            before: undefined,
            after: "invented-check",
          },
        ],
        {
          at: 1,
          threadId: thread.id,
          proposerRole: "orchestrator",
          scope: "project",
          approvedBy: "user",
          approvedAt: 1,
          changes: [],
          shown: [],
        },
        project.localCheckRevision!,
      );
    const worker = yield* spawn(session, { feature: "local-check" });
    yield* completeTurn(worker.session);
    yield* atAutonomy(thread, "full");
    yield* store.updateWorkspace(workspaceId, (state) => ({
      ...state,
      charter: { ...state.charter, mergeReviewPolicy: "solo" },
    }));
    const tool = (name: string) =>
      registry.forTransport(worker.thread.id, "worker").find((t) => t.descriptor.name === name)!;
    yield* tool("pr_bind").run({ repo: "acme/app", number: 12 });
    const checkout = worker.thread.checkout.path;
    writeFileSync(join(checkout, "feature.txt"), "feature\n");
    run(checkout, "add", "feature.txt");
    run(checkout, "commit", "-q", "-m", "feature");
    const head = run(checkout, "rev-parse", "HEAD").trim();
    // Nothing outside the commit may reach the check: untracked, excluded or not.
    writeFileSync(join(checkout, "scratch.txt"), "uncommitted\n");
    const moveBase = (name: string) => {
      writeFileSync(join(world.repo, name), `${name}\n`);
      run(world.repo, "add", name);
      run(world.repo, "commit", "-q", "-m", name);
      return run(world.repo, "rev-parse", "HEAD").trim();
    };
    const publish = (base: string, at = head, checks: "passing" | "pending" = "pending") =>
      store.getThread(worker.thread.id).pipe(
        Effect.flatMap((workerState) =>
          publishGit(world, workerState, {
            pr: badge({
              number: 12,
              url: "https://github.com/acme/app/pull/12",
              mergeState: "CLEAN",
              headRefOid: at,
              baseRefOid: base,
              checks,
            }),
          }),
        ),
      );
    /** A new commit on the branch, pushed: GitHub's head moves to it. */
    const pushNext = (name: string) => {
      writeFileSync(join(checkout, name), `${name}\n`);
      run(checkout, "add", name);
      run(checkout, "commit", "-q", "-m", name);
      const next = run(checkout, "rev-parse", "HEAD").trim();
      world.prHeads.set(12, { headRefName: worker.thread.checkout.branch!, headRefOid: next });
      return next;
    };
    /** `main` moved by an empty commit: the head merges onto it into the very same tree. */
    const moveBaseEmpty = (name: string) => {
      run(world.repo, "commit", "-q", "--allow-empty", "-m", name);
      return run(world.repo, "rev-parse", "HEAD").trim();
    };
    const ledgerPr = () =>
      registry
        .forTransport(thread.id, "orchestrator")
        .find((t) => t.descriptor.name === "list_workers")!
        .run({})
        .pipe(
          Effect.map(
            (ledger) =>
              (
                ledger as {
                  features: ReadonlyArray<{
                    workers: ReadonlyArray<{ threadId: string; pr?: Record<string, unknown> }>;
                  }>;
                }
              ).features
                .flatMap((feature) => feature.workers)
                .find((row) => row.threadId === worker.thread.id)?.pr,
          ),
        );
    world.prHeads.set(12, { headRefName: worker.thread.checkout.branch!, headRefOid: head });
    const merges = () =>
      world.ghCalls.filter((c) => c[2] === "merge" && !c.includes("--disable-auto"));
    const merged = waitReal(
      "the merge",
      store
        .getThread(worker.thread.id)
        .pipe(Effect.map((workerState) => workerState.boundPr?.mergeWhenReady === undefined)),
    );
    const told = (text: string) =>
      Effect.gen(function* () {
        const fake = yield* FakeAgentControl;
        return yield* waitReal(
          text,
          Effect.sync(() => {
            // Sent as a turn, or steered into the one an earlier notice opened.
            const agent = fake.sessions.findLast((s) => s.options.threadId === worker.thread.id);
            return [...(agent?.sent ?? []), ...(agent?.steered ?? [])].some((input) =>
              input.text.includes(text),
            );
          }),
        );
      });
    return {
      workspaceId,
      thread: worker.thread,
      threadId: worker.thread.id,
      tool,
      head,
      moveBase,
      moveBaseEmpty,
      pushNext,
      publish,
      merges,
      merged,
      told,
      ledgerPr,
    };
  });

/** What a fake check saw of the worktree Gram made for it. */
const sawOf = (dir: string) => ({
  parents: run(dir, "rev-parse", "HEAD^1", "HEAD^2").trim().split("\n"),
  files: ["feature.txt", "base.txt", "scratch.txt"].filter((file) => existsSync(join(dir, file))),
});

describe("merge_when_ready", () => {
  for (const scenario of [
    "branch switched",
    "head branch changed",
    "repo removed",
    "autonomy lowered",
    "closed",
    "head moved",
    "worktree deleted",
  ] as const) {
    it.effect.skipIf(!hasGit)(`an armed worker PR: ${scenario}`, () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const store = yield* ThreadStore;
            const runtimes = yield* ThreadRuntimes;
            const registry = yield* AppToolRegistry;
            const { session, thread, workspaceId } = yield* openOrchestrator(world);
            const worker = yield* spawn(session, { feature: "voice-desktop" });
            yield* completeTurn(worker.session);
            yield* atAutonomy(thread, "full");
            world.prHeads.set(12, { headRefName: worker.thread.checkout.branch! });
            const tools = registry.forTransport(worker.thread.id, "worker");
            const tool = (name: string) => tools.find((t) => t.descriptor.name === name)!;
            yield* tool("pr_bind").run({ repo: "acme/app", number: 12 });
            const publish = (approved: boolean) =>
              store
                .getThread(worker.thread.id)
                .pipe(
                  Effect.flatMap((t) => publishGit(world, t, { pr: armedWorkerBadge(approved) })),
                );
            yield* publish(false);
            yield* tool("merge_when_ready").run({});
            const intent = store
              .getThread(worker.thread.id)
              .pipe(Effect.map((t) => t.boundPr?.mergeWhenReady));
            expect(yield* intent).toMatchObject({ allowedBy: "autonomy" });
            expect(yield* store.listRequests(worker.thread.id)).toEqual([]);
            const merges = () => world.ghCalls.filter((c) => c[2] === "merge");
            if (scenario === "branch switched") {
              run(worker.thread.checkout.path, "switch", "-c", "feat/voice-speech-process");
              world.branchPrs.set(
                worker.thread.checkout.path,
                ready({ number: 13, url: "https://github.com/acme/app/pull/13" }),
              );
              yield* runtimes.updateThread(worker.thread.id, (t) => ({
                ...t,
                currentCheckout: { ...t.checkout, branch: "feat/voice-speech-process" },
              }));
              const original = yield* intent;
              yield* tool("pr_bind").run({ repo: "ACME/app", number: 12 });
              expect(yield* intent).toEqual(original);
              const refused = yield* tool("pr_bind")
                .run({ repo: "acme/app", number: 13 })
                .pipe(Effect.flip);
              expect(refused.message).toContain("armed on acme/app#12");
              const misnamed = yield* tool("merge_when_ready")
                .run({ number: 13 })
                .pipe(Effect.flip);
              expect(misnamed.message).toMatch(/^Invalid input:/);
              expect(yield* intent).toEqual(original);
              yield* tool("pr_bind").run({ repo: "acme/app", number: 13, add: true });
              expect((yield* store.getThread(worker.thread.id)).extraPrs?.[0]?.number).toBe(13);
            } else if (scenario === "head branch changed") {
              world.prHeads.set(12, { headRefName: "somebody-else" });
            } else if (scenario === "repo removed") {
              const other = yield* store.ensureProject({ root: world.dir, name: "other" });
              yield* store.updateWorkspace(workspaceId, (s) => ({
                ...s,
                workspace: { ...s.workspace, projectIds: [other.id], homeProjectId: other.id },
              }));
            } else if (scenario === "autonomy lowered") {
              yield* atAutonomy(thread, "publish");
            } else if (scenario === "closed") {
              world.prHeads.set(12, {
                headRefName: worker.thread.checkout.branch!,
                state: "CLOSED",
              });
            } else if (scenario === "worktree deleted") {
              // Outside Gram: ownership is read from the recorded branch and GitHub.
              rmSync(worker.thread.checkout.path, { recursive: true, force: true });
            } else {
              world.prHeads.set(12, {
                headRefName: worker.thread.checkout.branch!,
                headRefOid: "h2",
              });
            }
            yield* publish(true);
            yield* waitReal("the intent cleared", intent.pipe(Effect.map((i) => i === undefined)));
            if (scenario === "branch switched" || scenario === "worktree deleted") {
              expect(merges()).toEqual([
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
              if (scenario === "worktree deleted") {
                const at = world.ghCalls.findIndex((c) => c[2] === "merge");
                expect(world.ghDirs[at]).toBe(worker.thread.checkout.repoRoot);
              }
            } else {
              expect(merges()).toEqual([]);
              const fake = yield* FakeAgentControl;
              const told = yield* waitReal(
                "the drop notice",
                Effect.sync(() =>
                  sentTo(fake, worker.thread.id).find((text) => text.includes("was dropped:")),
                ),
              );
              const reasons = {
                "head branch changed":
                  "head branch is no longer a worktree branch held by this worker",
                "repo removed": "repo is no longer one of the worker's workspace projects",
                "autonomy lowered": "the workspace's autonomy is no longer full",
                closed: "it is closed",
                "head moved": "head moved since the reviewed head was checked",
              };
              expect(told).toContain(reasons[scenario]);
              expect(told).not.toContain("or the pull request");
            }
          }),
        );
      }).pipe(Effect.scoped),
    );
  }

  it.effect.skipIf(!hasGit)(
    "a pause that lands during a merge's last checks holds it, armed, for the resume",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const store = yield* ThreadStore;
            const registry = yield* AppToolRegistry;
            const orchestration = yield* Orchestration;
            const { session, thread, workspaceId } = yield* openOrchestrator(world);
            const worker = yield* spawn(session, { feature: "voice-desktop" });
            yield* completeTurn(worker.session);
            yield* atAutonomy(thread, "full");
            world.prHeads.set(12, { headRefName: worker.thread.checkout.branch! });
            const tools = registry.forTransport(worker.thread.id, "worker");
            const tool = (name: string) => tools.find((t) => t.descriptor.name === name)!;
            yield* tool("pr_bind").run({ repo: "acme/app", number: 12 });
            const publish = (approved: boolean) =>
              store
                .getThread(worker.thread.id)
                .pipe(
                  Effect.flatMap((t) => publishGit(world, t, { pr: armedWorkerBadge(approved) })),
                );
            yield* publish(false);
            yield* tool("merge_when_ready").run({});
            const intent = store
              .getThread(worker.thread.id)
              .pipe(Effect.map((t) => t.boundPr?.mergeWhenReady));
            const merges = () => world.ghCalls.filter((c) => c[2] === "merge");
            let paused = false;
            // The pause completes while the launch reads GitHub afresh, after its other checks.
            world.freshPrRead = Effect.suspend(() => {
              world.freshPrRead = undefined;
              return orchestration.setPaused(workspaceId, true).pipe(
                Effect.tap(() => Effect.sync(() => (paused = true))),
                Effect.asVoid,
                Effect.orDie,
              );
            });
            yield* publish(true);
            yield* waitReal(
              "the pause",
              Effect.sync(() => paused || undefined),
            );
            yield* settle;
            expect(merges()).toEqual([]);
            expect(yield* intent).toMatchObject({ allowedBy: "autonomy" });
            yield* orchestration.setPaused(workspaceId, false);
            yield* waitReal(
              "the held merge",
              Effect.sync(() => merges().length === 1 || undefined),
            );
          }),
        );
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(!hasGit)(
    "a pause asked for while a merge launches waits for it, and none launches after",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const store = yield* ThreadStore;
            const registry = yield* AppToolRegistry;
            const orchestration = yield* Orchestration;
            const { session, thread, workspaceId } = yield* openOrchestrator(world);
            const worker = yield* spawn(session, { feature: "voice-desktop" });
            yield* completeTurn(worker.session);
            yield* atAutonomy(thread, "full");
            world.prHeads.set(12, { headRefName: worker.thread.checkout.branch! });
            const tools = registry.forTransport(worker.thread.id, "worker");
            const tool = (name: string) => tools.find((t) => t.descriptor.name === name)!;
            yield* tool("pr_bind").run({ repo: "acme/app", number: 12 });
            const publish = (approved: boolean) =>
              store
                .getThread(worker.thread.id)
                .pipe(
                  Effect.flatMap((t) => publishGit(world, t, { pr: armedWorkerBadge(approved) })),
                );
            yield* publish(false);
            yield* tool("merge_when_ready").run({});
            const intent = store
              .getThread(worker.thread.id)
              .pipe(Effect.map((t) => t.boundPr?.mergeWhenReady));
            const merges = () => world.ghCalls.filter((c) => c[2] === "merge");
            const release = yield* Deferred.make<void>();
            let launching = false;
            world.mergeLaunch = Effect.sync(() => (launching = true)).pipe(
              Effect.andThen(Deferred.await(release)),
            );
            yield* publish(true);
            yield* waitReal(
              "the launch",
              Effect.sync(() => launching || undefined),
            );
            const order: Array<string> = [];
            const pausing = yield* Effect.forkScoped(
              orchestration
                .setPaused(workspaceId, true)
                .pipe(Effect.tap(() => Effect.sync(() => void order.push("paused")))),
            );
            yield* settle;
            // In flight from its launch: the pause takes effect once GitHub has answered.
            expect(order).toEqual([]);
            world.mergeLaunch = undefined;
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(pausing);
            expect(order).toEqual(["paused"]);
            expect(merges()).toHaveLength(1);
            // It went through before the pause took effect, so it is done, not held.
            yield* waitReal("the intent cleared", intent.pipe(Effect.map((i) => i === undefined)));
            yield* settle;
            expect(merges()).toHaveLength(1);
          }),
        );
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(!hasGit)(
    "an armed worker PR waits out the user's pause, armed, and merges on the resume",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const store = yield* ThreadStore;
            const registry = yield* AppToolRegistry;
            const orchestration = yield* Orchestration;
            const { session, thread, workspaceId } = yield* openOrchestrator(world);
            const worker = yield* spawn(session, { feature: "voice-desktop" });
            yield* completeTurn(worker.session);
            yield* atAutonomy(thread, "full");
            world.prHeads.set(12, { headRefName: worker.thread.checkout.branch! });
            const tools = registry.forTransport(worker.thread.id, "worker");
            const tool = (name: string) => tools.find((t) => t.descriptor.name === name)!;
            yield* tool("pr_bind").run({ repo: "acme/app", number: 12 });
            const publish = (approved: boolean) =>
              store
                .getThread(worker.thread.id)
                .pipe(
                  Effect.flatMap((t) => publishGit(world, t, { pr: armedWorkerBadge(approved) })),
                );
            yield* publish(false);
            yield* tool("merge_when_ready").run({});
            const intent = store
              .getThread(worker.thread.id)
              .pipe(Effect.map((t) => t.boundPr?.mergeWhenReady));
            const merges = () => world.ghCalls.filter((c) => c[2] === "merge");
            yield* orchestration.setPaused(workspaceId, true);
            // Ready while paused: nothing merges, and the intent stays armed.
            yield* publish(true);
            yield* settle;
            expect(merges()).toEqual([]);
            expect(yield* intent).toMatchObject({ allowedBy: "autonomy" });
            yield* orchestration.setPaused(workspaceId, false);
            yield* waitReal(
              "the held merge",
              Effect.sync(() => merges().length === 1 || undefined),
            );
            expect(merges()[0]).toContain("--match-head-commit");
            yield* waitReal("the intent cleared", intent.pipe(Effect.map((i) => i === undefined)));
          }),
        );
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(!hasGit)(
    "a scoped solo worker merges without a bot and pins its current CI head",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const store = yield* ThreadStore;
            const registry = yield* AppToolRegistry;
            const { session, thread, workspaceId } = yield* openOrchestrator(world);
            const worker = yield* spawn(session, { feature: "solo-policy" });
            yield* completeTurn(worker.session);
            yield* atAutonomy(thread, "full");
            yield* store.updateWorkspace(workspaceId, (state) => ({
              ...state,
              charter: {
                ...state.charter,
                mergeReviewPolicy: "bot",
                repoMergeReviewPolicies: [{ repo: "ACME/app", policy: "solo" }],
              },
            }));
            // Keep an inherited placeholder untouched; it cannot be mistaken for a review.
            yield* store.updateSettings((settings) => ({
              ...settings,
              reviewBots: [
                {
                  loginPattern: "example-code-review[bot]",
                  rereviewCommand: "/agent review",
                  canApprove: true,
                },
              ],
            }));
            world.prHeads.set(12, { headRefName: worker.thread.checkout.branch! });
            const tool = (name: string) =>
              registry
                .forTransport(worker.thread.id, "worker")
                .find((t) => t.descriptor.name === name)!;
            yield* tool("pr_bind").run({ repo: "acme/app", number: 12 });
            const publish = (checks: "pending" | "passing") =>
              store.getThread(worker.thread.id).pipe(
                Effect.flatMap((workerState) =>
                  publishGit(world, workerState, {
                    pr: badge({
                      number: 12,
                      url: "https://github.com/acme/app/pull/12",
                      mergeState: "CLEAN",
                      headRefOid: "h1",
                      checks,
                    }),
                  }),
                ),
              );
            yield* publish("pending");
            const autoRefused = yield* tool("set_auto_merge").run({}).pipe(Effect.flip);
            expect(autoRefused.message).toContain("Solo development uses merge_when_ready");
            expect(yield* tool("set_auto_merge").run({ enabled: false })).toMatchObject({
              autoMerge: false,
            });
            expect(yield* tool("pr_status").run({})).toMatchObject({ mergeReviewPolicy: "solo" });
            expect(yield* tool("merge_when_ready").run({})).toMatchObject({
              waiting:
                "not fresh, green (or locally checked on its head) and allowed by GitHub yet",
            });
            const definition = registry.definitions.find(
              (entry) => entry.descriptor.name === "merge_when_ready",
            )!;
            const target = yield* definition.resolve!(worker.thread.id, {});
            const card = yield* definition.describe!(worker.thread.id, target);
            expect(card).toContain(
              "fresh CI passes, or Gram's own full check of it merged onto its base passes, and GitHub allows it",
            );
            expect(card).not.toContain("approved on its head");
            expect(
              world.ghCalls.filter((c) => c[2] === "merge" && !c.includes("--disable-auto")),
            ).toEqual([]);
            expect(
              (yield* store.getThread(worker.thread.id)).boundPr?.mergeWhenReady,
            ).toMatchObject({ allowedBy: "autonomy" });
            expect(yield* store.listRequests(worker.thread.id)).toEqual([]);
            world.prBadges.set(
              "acme/app#12",
              badge({
                number: 12,
                url: "https://github.com/acme/app/pull/12",
                mergeState: "CLEAN",
                headRefOid: "h1",
                checks: "failing",
              }),
            );
            yield* publish("passing");
            yield* waitReal(
              "the solo launch provider read or incorrect merge",
              Effect.sync(
                () =>
                  world.freshPrReads.includes("acme/app#12") ||
                  world.ghCalls.some(
                    (call) => call[2] === "merge" && !call.includes("--disable-auto"),
                  ),
              ),
            );
            expect(
              world.ghCalls.filter(
                (call) => call[2] === "merge" && !call.includes("--disable-auto"),
              ),
            ).toEqual([]);
            world.prBadges.delete("acme/app#12");
            yield* tool("merge_when_ready").run({});
            yield* waitReal(
              "the solo merge",
              store
                .getThread(worker.thread.id)
                .pipe(
                  Effect.map((workerState) => workerState.boundPr?.mergeWhenReady === undefined),
                ),
            );
            expect(
              world.ghCalls.filter((c) => c[2] === "merge" && !c.includes("--disable-auto")),
            ).toEqual([
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

  it.effect.skipIf(!hasGit)(
    "read-only status projects known unavailable settings without a local attempt",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        let runs = 0;
        world.localCheckRunner = () =>
          Effect.sync(() => {
            runs++;
            return { ok: true };
          });
        yield* withServer(
          world,
          Effect.gen(function* () {
            const pr = yield* soloPr(world, false);
            const base = pr.moveBase("base.txt");
            yield* pr.publish(base);
            const sql = yield* SqlClient.SqlClient;
            const raw =
              '{"profile":"unsupported-native-version","private":"invented-private-settings"}';
            yield* sql`UPDATE projects SET local_check = ${raw} WHERE id = ${pr.thread.projectId}`.pipe(
              Effect.orDie,
            );
            const store = yield* ThreadStore;
            const audits = (yield* store.listSettingsAudit(20)).length;
            const status = yield* pr.tool("pr_status").run({});
            expect(status).toMatchObject({
              localGate: { status: "unavailable", reason: expect.stringContaining("unreadable") },
            });
            expect(status).not.toHaveProperty("localCheck");
            const report = yield* pr.tool("local_check").run({ rerun: false }).pipe(Effect.flip);
            expect(report.message).toContain("unreadable");
            expect(report.message).not.toContain("call local_check");
            expect(JSON.stringify(status) + report.message).not.toContain(
              "invented-private-settings",
            );
            expect(runs).toBe(0);
            expect(pr.merges()).toEqual([]);
            expect((yield* store.listSettingsAudit(20)).length).toBe(audits);
            expect(yield* sql`SELECT key FROM local_checks`.pipe(Effect.orDie)).toEqual([]);
            expect(
              (yield* sql<{
                local_check: string;
              }>`SELECT local_check FROM projects WHERE id = ${pr.thread.projectId}`.pipe(
                Effect.orDie,
              ))[0]!.local_check,
            ).toBe(raw);
            // Unavailable LOCAL evidence does not introduce a veto on qualifying GitHub CI.
            yield* pr.publish(base, pr.head, "passing");
            yield* pr.tool("merge_when_ready").run({});
            yield* pr.merged;
            expect(pr.merges()).toHaveLength(1);
            expect(runs).toBe(0);
          }),
        );
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(!hasGit)(
    "no project command means no gate; the result and ledger say OFF and CI still gates",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        let runs = 0;
        world.localCheckRunner = () =>
          Effect.sync(() => {
            runs++;
            return { ok: true };
          });
        yield* withServer(
          world,
          Effect.gen(function* () {
            const pr = yield* soloPr(world, false);
            const base = pr.moveBase("base.txt");
            yield* pr.publish(base);
            expect(yield* pr.tool("merge_when_ready").run({})).toMatchObject({
              localGate: {
                status: "off",
                reason: expect.stringContaining("no local check configured for"),
              },
              waiting: expect.any(String),
            });
            expect(yield* pr.tool("pr_status").run({})).toMatchObject({
              localGate: { status: "off" },
            });
            const disabled = yield* pr.tool("local_check").run({}).pipe(Effect.flip);
            expect(disabled.message).toContain("no local check configured for");
            yield* settle;
            expect(runs).toBe(0);
            expect(pr.merges()).toEqual([]);
            const store = yield* ThreadStore;
            const events = yield* store.listOrchestrationEvents(pr.workspaceId, 0);
            expect(
              events.some(
                (e) =>
                  e.kind === "localGateOff" &&
                  JSON.stringify(e.data).includes("no local check configured for"),
              ),
            ).toBe(true);
            expect(events.some((e) => e.kind === "merge")).toBe(false);
            yield* pr.publish(base, pr.head, "passing");
            yield* pr.merged;
            yield* pr.told("Local gate OFF: no local check configured for");
            expect(runs).toBe(0);
            expect(pr.merges()).toHaveLength(1);
          }),
        );
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(!hasGit)(
    "a configuration change during the fresh GitHub read retires the pass",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        world.localCheckRunner = () => Effect.succeed({ ok: true });
        yield* withServer(
          world,
          Effect.gen(function* () {
            const pr = yield* soloPr(world);
            const store = yield* ThreadStore;
            const base = pr.moveBase("base.txt");
            yield* pr.publish(base);
            yield* pr.tool("local_check").run({});
            yield* waitReal(
              "the local pass",
              pr
                .tool("pr_status")
                .run({})
                .pipe(
                  Effect.map(
                    (status) =>
                      (status as { localCheck?: { status: string } }).localCheck?.status ===
                      "passed",
                  ),
                ),
            );
            let changed = false;
            world.freshPrRead = Effect.gen(function* () {
              world.freshPrRead = undefined;
              yield* store.updateProjectLocalCheckAudited(
                pr.thread.projectId,
                [
                  {
                    key: "project.localCheck.command",
                    path: ["localCheck", "command"],
                    before: "invented-check",
                    after: undefined,
                  },
                ],
                {
                  at: 1,
                  threadId: pr.threadId,
                  proposerRole: "plain",
                  scope: "project",
                  approvedBy: "user",
                  approvedAt: 1,
                  changes: [],
                  shown: [],
                },
                (yield* store.listProjects).find((p) => p.id === pr.thread.projectId)!
                  .localCheckRevision!,
              );
              changed = true;
            });
            yield* pr.tool("merge_when_ready").run({});
            yield* waitReal(
              "the changed configuration",
              Effect.sync(() => changed),
            );
            yield* settle;
            expect(pr.merges()).toEqual([]);
            expect((yield* store.getThread(pr.threadId)).boundPr?.mergeWhenReady).toBeDefined();
            expect(yield* pr.tool("pr_status").run({})).toMatchObject({
              localGate: { status: "off" },
            });
          }),
        );
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(!hasGit)(
    "a solo merge waits for Gram's own check of the head merged onto its base, then merges without CI",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const release = yield* Deferred.make<void>();
        const saw: Array<ReturnType<typeof sawOf>> = [];
        world.localCheckRunner = (dir) =>
          Effect.sync(() => void saw.push(sawOf(dir))).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as({ ok: true }),
          );
        yield* withServer(
          world,
          Effect.gen(function* () {
            const pr = yield* soloPr(world);
            const base = pr.moveBase("base.txt");
            yield* pr.publish(base);
            expect(yield* pr.tool("merge_when_ready").run({})).toMatchObject({
              waiting:
                "not fresh, green (or locally checked on its head) and allowed by GitHub yet",
            });
            yield* waitReal(
              "Gram's check to start",
              Effect.sync(() => saw.length === 1),
            );
            // It checks the head merged onto the current base, and nothing outside the commit.
            expect(saw[0]).toEqual({
              parents: [base, pr.head],
              files: ["feature.txt", "base.txt"],
            });
            expect(yield* pr.tool("pr_status").run({})).toMatchObject({
              localCheck: { status: "running", head: pr.head, base },
            });
            yield* settle;
            expect(pr.merges()).toEqual([]);

            yield* Deferred.succeed(release, undefined);
            yield* pr.merged;
            expect(pr.merges()).toEqual([
              [
                "gh",
                "pr",
                "merge",
                "12",
                "--squash",
                "--match-head-commit",
                pr.head,
                "--repo",
                "acme/app",
              ],
            ]);
            yield* pr.told("Gram's own full check passed on this head merged onto");
            expect(saw).toHaveLength(1);
          }),
        );
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(!hasGit)(
    "a failed own check holds the merge and says why, and a moved base is checked again",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const saw: Array<ReturnType<typeof sawOf>> = [];
        world.localCheckRunner = (dir) =>
          Effect.sync(() => {
            saw.push(sawOf(dir));
            return saw.length === 1 ? { ok: false, reason: "exited 1" } : { ok: true };
          });
        yield* withServer(
          world,
          Effect.gen(function* () {
            const pr = yield* soloPr(world);
            const first = pr.moveBase("base.txt");
            yield* pr.publish(first);
            yield* pr.tool("merge_when_ready").run({});
            yield* pr.told("failed: exited 1");
            expect(yield* pr.tool("pr_status").run({})).toMatchObject({
              localCheck: { status: "failed", reason: "exited 1", base: first },
            });
            yield* settle;
            expect(pr.merges()).toEqual([]);
            expect(saw).toHaveLength(1);

            // The base moved: a pass for the old one would not be what merges, so it checks again.
            const second = pr.moveBase("later.txt");
            yield* pr.publish(second);
            yield* pr.merged;
            expect(saw).toHaveLength(2);
            expect(saw[1]!.parents).toEqual([second, pr.head]);
            expect(pr.merges()).toHaveLength(1);
          }),
        );
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(!hasGit)(
    "local_check runs Gram's check ahead, and merge_when_ready reuses its pass for that head and base",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const saw: Array<ReturnType<typeof sawOf>> = [];
        world.localCheckRunner = (dir) => Effect.sync(() => (saw.push(sawOf(dir)), { ok: true }));
        yield* withServer(
          world,
          Effect.gen(function* () {
            const pr = yield* soloPr(world);
            const base = pr.moveBase("base.txt");
            yield* pr.publish(base);
            expect(yield* pr.tool("local_check").run({})).toMatchObject({
              status: "running",
              reused: false,
              head: pr.head,
              base,
            });
            yield* pr.told(`passed on ${pr.head.slice(0, 7)} merged onto ${base.slice(0, 7)}`);
            expect(saw).toEqual([{ parents: [base, pr.head], files: ["feature.txt", "base.txt"] }]);
            expect(yield* pr.ledgerPr()).toMatchObject({ localCheck: { status: "passed" } });
            // Asked again, the recorded pass is reused rather than run again.
            expect(yield* pr.tool("local_check").run({})).toMatchObject({
              status: "passed",
              reused: true,
            });
            yield* pr.tool("merge_when_ready").run({});
            yield* pr.merged;
            expect(saw).toHaveLength(1);
            expect(pr.merges()).toEqual([
              [
                "gh",
                "pr",
                "merge",
                "12",
                "--squash",
                "--match-head-commit",
                pr.head,
                "--repo",
                "acme/app",
              ],
            ]);
          }),
        );
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(!hasGit)(
    "a pass on the old base is stale once the base moves, even into the same merged tree",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const saw: Array<ReturnType<typeof sawOf>> = [];
        world.localCheckRunner = (dir) => Effect.sync(() => (saw.push(sawOf(dir)), { ok: true }));
        yield* withServer(
          world,
          Effect.gen(function* () {
            const pr = yield* soloPr(world);
            const base = pr.moveBase("base.txt");
            yield* pr.publish(base);
            yield* pr.tool("local_check").run({});
            yield* pr.told("passed on");
            const moved = pr.moveBaseEmpty("empty");
            yield* pr.publish(moved);
            // The old pass doesn't qualify the new base: the gate checks the new pair first.
            yield* pr.tool("merge_when_ready").run({});
            yield* pr.merged;
            expect(saw.map((each) => each.parents)).toEqual([
              [base, pr.head],
              [moved, pr.head],
            ]);
            expect(pr.merges()).toHaveLength(1);
          }),
        );
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(!hasGit)(
    "a new head needs its own check, and a failure says which command was missing",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const saw: Array<ReturnType<typeof sawOf>> = [];
        world.localCheckRunner = (dir) =>
          Effect.sync(() => {
            saw.push(sawOf(dir));
            return saw.length === 1
              ? { ok: true }
              : diagnoseExit(127, null, "sh: line 1: tsc: command not found\n", "/usr/bin:/bin");
          });
        yield* withServer(
          world,
          Effect.gen(function* () {
            const pr = yield* soloPr(world);
            const base = pr.moveBase("base.txt");
            yield* pr.publish(base);
            yield* pr.tool("local_check").run({});
            yield* pr.told("passed on");
            const next = pr.pushNext("next.txt");
            yield* pr.publish(base, next);
            yield* pr.tool("merge_when_ready").run({});
            yield* pr.told("`tsc` was not found on the check's PATH (exit 127)");
            yield* pr.told("PATH=/usr/bin:/bin");
            yield* pr.told("the machine running Gram needs the command on its login-shell PATH");
            yield* settle;
            // The first head's pass never qualified the second: nothing merged.
            expect(pr.merges()).toEqual([]);
            expect(saw.map((each) => each.parents)).toEqual([
              [base, pr.head],
              [base, next],
            ]);
            expect(yield* pr.tool("pr_status").run({})).toMatchObject({
              localCheck: {
                status: "failed",
                head: next,
                failure: { kind: "not-found", command: "tsc", path: "/usr/bin:/bin" },
              },
            });
            expect(yield* pr.ledgerPr()).toMatchObject({
              localCheck: {
                status: "failed",
                kind: "not-found",
                reason: expect.stringContaining("`tsc` was not found"),
              },
            });
          }),
        );
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(!hasGit)(
    "local_check runs only the worker's own PR, asks the user otherwise, and nothing while paused",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const saw: Array<ReturnType<typeof sawOf>> = [];
        world.localCheckRunner = (dir) => Effect.sync(() => (saw.push(sawOf(dir)), { ok: true }));
        yield* withServer(
          world,
          Effect.gen(function* () {
            const orchestration = yield* Orchestration;
            const store = yield* ThreadStore;
            const merges = yield* MergeWhenReady;
            const pr = yield* soloPr(world);
            const base = pr.moveBase("base.txt");
            yield* pr.publish(base);
            // Its own PR, at full autonomy: no card.
            expect(yield* pr.tool("local_check").delegatedAtFullAutonomy!({})).toBe(true);

            // A contributor's fork branch the worker never made, bound as its PR.
            run(world.repo, "checkout", "-q", "-b", "contributor");
            writeFileSync(join(world.repo, "evil.txt"), "evil\n");
            run(world.repo, "add", "evil.txt");
            run(world.repo, "commit", "-q", "-m", "evil");
            const evil = run(world.repo, "rev-parse", "HEAD").trim();
            run(world.repo, "checkout", "-q", "main");
            world.prHeads.set(12, { headRefName: "contributor", headRefOid: evil, fork: true });
            yield* pr.publish(base, evil);
            // The user is asked, and even an approved call runs none of its code.
            expect(yield* pr.tool("local_check").delegatedAtFullAutonomy!({})).toBe(false);
            expect(yield* merges.runLocalCheck(pr.threadId)).toEqual({
              refused: expect.stringContaining("isn't this worker's own pull request"),
            });

            // Its own again, but the workspace paused.
            world.prHeads.set(12, {
              headRefName: (yield* store.getThread(pr.threadId)).checkout.branch!,
              headRefOid: pr.head,
            });
            yield* pr.publish(base);
            const workspaceId = (yield* store.listWorkspaces)[0]!.workspace.id;
            yield* orchestration.setPaused(workspaceId, true).pipe(Effect.orDie);
            expect(yield* merges.runLocalCheck(pr.threadId)).toEqual({
              refused: "the workspace is paused",
            });
            yield* settle;
            expect(saw).toEqual([]);
          }),
        );
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(!hasGit)("local_check is refused outside the solo policy", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      let runs = 0;
      world.localCheckRunner = () => Effect.sync(() => (++runs, { ok: true }));
      yield* withServer(
        world,
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const pr = yield* soloPr(world, false);
          yield* pr.publish(pr.moveBase("base.txt"));
          const workspace = (yield* store.listWorkspaces)[0]!;
          yield* store.updateWorkspace(workspace.workspace.id, (state) => ({
            ...state,
            charter: { ...state.charter, mergeReviewPolicy: "bot" },
          }));
          const refused = yield* pr.tool("local_check").run({}).pipe(Effect.flip);
          expect(refused.message).toContain("only solo accepts Gram's own check");
          expect(runs).toBe(0);
          expect(yield* pr.tool("pr_status").run({})).not.toHaveProperty("localGate");
          expect(yield* pr.tool("merge_when_ready").run({})).not.toHaveProperty("localGate");
          expect(
            (yield* store.listOrchestrationEvents(pr.workspaceId, 0)).some(
              (e) => e.kind === "localGateOff",
            ),
          ).toBe(false);
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("keeps a thread's lock only while somebody holds or waits for it", () =>
    Effect.gen(function* () {
      const locks = makeKeyedLock<string>();
      const order: Array<string> = [];
      const open = yield* Deferred.make<void>();
      const first = yield* Effect.forkScoped(
        locks.withLock(
          "t",
          Effect.andThen(
            Deferred.await(open),
            Effect.sync(() => order.push("1")),
          ),
        ),
        { startImmediately: true },
      );
      const second = yield* Effect.forkScoped(
        locks.withLock(
          "t",
          Effect.sync(() => order.push("2")),
        ),
        { startImmediately: true },
      );
      const given = yield* Effect.forkScoped(locks.withLock("t", Effect.never), {
        startImmediately: true,
      });
      // A waiter that gives up takes nothing from the ones still there.
      yield* Fiber.interrupt(given);
      expect(locks.size()).toBe(1);
      yield* Deferred.succeed(open, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      expect(order).toEqual(["1", "2"]);
      expect(locks.size()).toBe(0);
    }).pipe(Effect.scoped),
  );

  it("waits for the bot's approval on the head, green checks and a merge GitHub allows", () => {
    const intent = { method: "squash", allowedBy: "user", setAt: 0 } as const;
    expect(mergeBlocker(intent, ready())).toBeUndefined();
    expect(mergeBlocker(intent, ready({ mergeState: "UNSTABLE" }))).toBeUndefined();
    expect(mergeBlocker(intent, ready({ mergeState: "BLOCKED" }))).toMatch(/not approved/);
    expect(mergeBlocker(intent, ready({ checks: "pending" }))).toMatch(/not approved/);
    expect(
      mergeBlocker(intent, badge({ checks: "passing", mergeState: "CLEAN", headRefOid: "h1" })),
    ).toMatch(/not approved/);
    expect(mergeBlocker(intent, ready({ reviewUnread: true }))).toMatch(/weren't read/);
    expect(mergeBlocker({ ...intent, failedOn: "h1" }, ready())).toMatch(/refused/);
    expect(mergeBlocker({ ...intent, hold: "not before 0.8.0" }, ready())).toBe(
      "held: not before 0.8.0",
    );
    expect(parsePrRef("ANT1OFF/gram#199")).toEqual({
      repo: "ANT1OFF/gram",
      number: 199,
    });
    expect(parsePrRef("https://github.com/ANT1OFF/gram/pull/199")).toEqual({
      repo: "ANT1OFF/gram",
      number: 199,
    });
    expect(parsePrRef("#199")).toBeUndefined();
  });

  for (const change of [
    "CI turned red",
    "approver removed",
    "approver downgraded",
    "remaining commenter disabled",
  ] as const) {
    it.live.skipIf(!hasGit)(`refuses launch after ${change} despite a cached green approval`, () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const publisher = yield* GitStatePublisher;
        const { thread, hosted } = yield* liveThread;
        const cached = ready();
        current.badge = {
          ...cached,
          review: { ...cached.review!, bots: ["example-code-review", "comment-bot"] },
        };
        let freshReads = 0;
        current.fresh = () => {
          freshReads++;
          return change === "CI turned red" ? ready({ checks: "failing" }) : current.badge;
        };
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            current.fresh = undefined;
          }),
        );
        yield* hosted("pr_bind").run({});
        yield* eventually(
          "the cached green badge",
          store.getThread(thread.id).pipe(Effect.flatMap(publisher.badgeFor)),
        );
        yield* store.updateSettings((settings) => ({
          ...settings,
          reviewBots: [
            {
              loginPattern: "example-code-review[bot]",
              rereviewCommand: "/review",
              canApprove: true,
            },
            { loginPattern: "comment-bot[bot]", rereviewCommand: "/review", canApprove: true },
          ],
        }));
        yield* hosted("merge_when_ready").run({ hold: "prepare launch regression" });
        if (change !== "CI turned red")
          yield* store.updateSettings((settings) => ({
            ...settings,
            reviewBots: [
              ...(change === "approver removed" || change === "remaining commenter disabled"
                ? []
                : [
                    {
                      loginPattern: "example-code-review[bot]",
                      rereviewCommand: "/review",
                      canApprove: false,
                    },
                  ]),
              {
                loginPattern: "comment-bot[bot]",
                rereviewCommand: "/review",
                canApprove: change !== "remaining commenter disabled",
              },
            ],
          }));
        ghCalls.length = 0;
        yield* hosted("merge_when_ready").run({ release: true });
        // Wait until the attempt either consults the provider or incorrectly merges.
        // A revoked approval may also stop before the fresh lookup.
        for (let i = 0; i < 100; i++) yield* Effect.yieldNow;
        if (change === "CI turned red")
          yield* eventually(
            "the launch state read or merge",
            Effect.sync(
              () => freshReads > 0 || ghCalls.some((call) => command(call.slice(1)) === "pr merge"),
            ),
          );
        expect(ghCalls.filter((call) => command(call.slice(1)) === "pr merge")).toEqual([]);
        expect((yield* store.getThread(thread.id)).boundPr?.mergeWhenReady).toBeDefined();
        if (change === "CI turned red") expect(freshReads).toBeGreaterThan(0);
      }).pipe(Effect.scoped, Effect.provide(MergeTestLayer)),
    );
  }

  it.live.skipIf(!hasGit)(
    "merges pinned to the head once it is ready, after the PRs it waits on",
    () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const publisher = yield* GitStatePublisher;
        const { thread, hosted } = yield* liveThread;
        let release = "OPEN";
        gh.answer = (args) =>
          args[1] === "view" && args.includes("199") ? { ...ok, stdout: `${release}\n` } : ok;
        current.badge = ready();
        yield* hosted("pr_bind").run({});
        yield* eventually(
          "the bound PR's badge",
          store.getThread(thread.id).pipe(Effect.flatMap(publisher.badgeFor)),
        );
        ghCalls.length = 0;

        expect(yield* hosted("merge_when_ready").run({ after: ["acme/web#199"] })).toMatchObject({
          pr: "acme/web#7",
          mergeWhenReady: true,
          after: ["acme/web#199"],
        });
        yield* eventually(
          "the release PR looked up",
          Effect.sync(() => ghCalls.some((call) => call.includes("199"))),
        );
        expect(prMerges()).toEqual([]);

        const tooMany = yield* hosted("merge_when_ready")
          .run({ after: Array.from({ length: 9 }, (_, i) => `acme/web#${i + 100}`) })
          .pipe(Effect.flip);
        expect(tooMany.message).toMatch(/Invalid input/);

        release = "MERGED";
        yield* hosted("merge_when_ready").run({});
        yield* eventually(
          "the merge",
          Effect.sync(() => prMerges().length > 0),
        );
        expect(prMerges()).toEqual([mergeCall("7", "--squash", "--match-head-commit", "h1")]);
        yield* eventually(
          "the intent cleared",
          store
            .getThread(thread.id)
            .pipe(Effect.map((t) => t.boundPr?.mergeWhenReady === undefined)),
        );
        gh.answer = () => ok;
      }).pipe(Effect.scoped, Effect.provide(MergeTestLayer)),
  );

  for (const hold of [null, "", "   "] as const) {
    it.live.skipIf(!hasGit)(
      `clears a merge hold explicitly with ${JSON.stringify(hold)} without dropping dependencies`,
      () =>
        Effect.gen(function* () {
          current.badge = badge();
          current.fresh = undefined;
          gh.answer = () => ok;
          const store = yield* ThreadStore;
          const { thread, hosted } = yield* liveThread;
          yield* hosted("pr_bind").run({ repo: "acme/web", number: 7 });
          yield* hosted("merge_when_ready").run({
            hold: "review",
            holdWaitsOn: "agent",
            after: ["acme/web#99"],
          });
          const result = yield* hosted("merge_when_ready").run({ hold });
          expect(result).toMatchObject({
            mergeWhenReady: true,
            hold: null,
            note: "no hold",
            after: ["acme/web#99"],
          });
          const intent = (yield* store.getThread(thread.id)).boundPr?.mergeWhenReady;
          expect(intent).not.toHaveProperty("hold");
          expect(intent).not.toHaveProperty("holdWaitsOn");
          expect(intent?.after).toEqual([{ repo: "acme/web", number: 99 }]);
        }).pipe(Effect.scoped, Effect.provide(MergeTestLayer)),
    );
  }

  it.live.skipIf(!hasGit)("says whom a hold waits on, and keeps it with the hold", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const { thread, hosted } = yield* liveThread;
      const intent = () =>
        store.getThread(thread.id).pipe(Effect.map((t) => t.boundPr?.mergeWhenReady));
      yield* hosted("pr_bind").run({});
      // Held for a review bot's re-review: agent work.
      expect(
        yield* hosted("merge_when_ready").run({ hold: "codex re-review", holdWaitsOn: "agent" }),
      ).toMatchObject({ hold: "codex re-review", holdWaitsOn: "agent" });
      yield* hosted("merge_when_ready").run({ method: "merge" });
      expect(yield* intent()).toMatchObject({ hold: "codex re-review", holdWaitsOn: "agent" });
      // A new hold says afresh; without it, it waits on a person.
      yield* hosted("merge_when_ready").run({ hold: "the user's say-so" });
      expect((yield* intent())?.holdWaitsOn).toBeUndefined();
      yield* hosted("merge_when_ready").run({ release: true });
      expect(yield* intent()).not.toHaveProperty("hold");
      expect(yield* intent()).not.toHaveProperty("holdWaitsOn");
    }).pipe(Effect.scoped, Effect.provide(MergeTestLayer)),
  );
});
