// Merge freezes (`merge_freeze`): Gram's merge gate waits under one, saying who froze the base and
// why; only the thread that froze it or its orchestrator lifts it; it always expires, over a
// restart too; and a `freezeLifted` wake fires when it ends.
import { describe, expect, it } from "@effect/vitest";
import { type PrStatus, type Thread, type ThreadId } from "@gram/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { AppToolRegistry } from "../app-tools/registry.ts";
import { hasGit } from "../git/test-repo.ts";
import { MergeFreezes } from "../git/merge-freezes.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { SqlClient } from "../platform/unstable.ts";
import { FakeAgentControl } from "../runtime/fake-agent.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { WakeConditions } from "../wakes/conditions.ts";
import { Orchestration } from "./service.ts";
import {
  atAutonomy,
  autoMergeHead,
  completeTurn,
  makeWorld,
  openOrchestrator,
  prBadge,
  publishGit,
  settle,
  spawn,
  waitReal,
  waitSent,
  type World,
  withServer,
} from "./test-harness.ts";

/** acme/app#12 onto main: approved on its head, green and clean when `ready`. */
const workerBadge = (ready: boolean): PrStatus =>
  prBadge({
    url: "https://github.com/acme/app/pull/12",
    headRefOid: "h1",
    baseRef: "main",
    ...(ready
      ? {
          checks: "passing",
          mergeState: "CLEAN",
          review: {
            bots: ["example-code-review"],
            reviewedHead: true,
            roundInFlight: false,
            verdictOnHead: "approved",
            threads: { unresolved: 0, blockers: 0, suggestions: 0, outdatedUnresolved: 0 },
          },
        }
      : {}),
  });

/**
 * A workspace at full autonomy with a worker whose PR (acme/app#12) has merge_when_ready armed,
 * and a release worker; the PR isn't ready yet.
 */
const armedWorkspace = (world: World) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    const store = yield* ThreadStore;
    const registry = yield* AppToolRegistry;
    const opened = yield* openOrchestrator(world);
    const impl = yield* spawn(opened.session, { feature: "mail-trigger", title: "Mail trigger" });
    yield* completeTurn(impl.session);
    const release = yield* spawn(opened.session, { feature: "release", title: "Release 1.6" });
    yield* completeTurn(release.session);
    yield* atAutonomy(opened.thread, "full");
    world.prHeads.set(12, { headRefName: impl.thread.checkout.branch! });
    // The synthetic merge applies on GitHub, so the gate's authoritative outcome read can
    // reconcile its durable fence. The published badge may still lag that mutation.
    world.mergeLaunch = Effect.sync(() => {
      world.prHeads.set(12, {
        ...world.prHeads.get(12)!,
        state: "MERGED",
        headRefOid: "h1",
      });
    });
    world.defaultBranches.set("acme/app", "main");
    world.originRepos.set(world.repo, "acme/app");
    // The release worker's own PR, with GitHub's auto-merge armed on it.
    yield* runtimes.updateThread(release.thread.id, (t) => ({
      ...t,
      boundPr: { repo: "acme/app", number: 13, monitor: false },
    }));
    world.autoMerges.set("acme/app#13", { base: "main", method: "rebase" });
    yield* runtimes.updateThread(impl.thread.id, (t) => ({
      ...t,
      boundPr: { repo: "acme/app", number: 12, monitor: false },
    }));
    const publish = (ready: boolean) =>
      Effect.gen(function* () {
        yield* publishGit(world, yield* store.getThread(impl.thread.id), {
          pr: workerBadge(ready),
        });
      });
    yield* publish(false);
    yield* registry
      .forTransport(opened.thread.id, "orchestrator")
      .find((tool) => tool.descriptor.name === "merge_when_ready")!
      .run({ threadId: impl.thread.id });
    const waiting = store
      .getThread(impl.thread.id)
      .pipe(Effect.map((t) => t.boundPr?.mergeWaiting?.why));
    const merges = () => world.ghCalls.filter((call) => call[2] === "merge");
    return { ...opened, impl, release, publish, waiting, merges };
  });

/** A plain thread at rest. */
const openPlain = (world: World, title: string) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    const thread: Thread = yield* runtimes.create({
      projectRoot: world.repo,
      checkout: { kind: "main", path: world.repo },
      title,
      input: { text: "hello" },
    });
    const session = yield* waitSent(thread.id, 1);
    yield* completeTurn(session);
    return { thread, session };
  });

describe.skipIf(!hasGit)("merge freezes", () => {
  it.effect(
    "a freeze holds Gram's merge with a plain line; only its thread or the orchestrator lifts it",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const { session, impl, release, publish, waiting, merges } =
              yield* armedWorkspace(world);

            // Frozen on the default branch, with a reason.
            const frozen = yield* release.session.callTool("merge_freeze", {
              repo: "acme/app",
              reason: "the 1.6 release cut",
              minutes: 30,
            });
            expect(frozen).toMatchObject({ frozen: true, repo: "acme/app", branch: "main" });
            const tooLong = yield* release.session
              .callTool("merge_freeze", { repo: "acme/app", reason: "x", minutes: 61 })
              .pipe(Effect.flip);
            expect(tooLong.message).toContain("between 1 and 60");

            // The PR is ready: Gram waits, and says who froze main and why.
            yield* publish(true);
            const why = yield* waitReal(
              "the merge waiting on the freeze",
              waiting.pipe(Effect.map((text) => text?.includes("frozen") === true && text)),
            );
            expect(why).toMatch(
              /^main is frozen by "Release 1\.6" for the 1\.6 release cut until \d\d:\d\dZ$/,
            );
            yield* settle;
            expect(merges()).toEqual([]);
            // GitHub's auto-merge would merge under it: refused.
            const auto = yield* impl.session.callTool("set_auto_merge", {}).pipe(Effect.flip);
            expect(auto.message).toContain('main is frozen by "Release 1.6"');

            // Another thread can't freeze over it, nor lift it.
            const over = yield* impl.session
              .callTool("merge_freeze", { repo: "acme/app", reason: "mine" })
              .pipe(Effect.flip);
            expect(over.message).toContain("freezeLifted");
            const notYours = yield* impl.session
              .callTool("merge_freeze", { repo: "acme/app", lift: true })
              .pipe(Effect.flip);
            expect(notYours.message).toContain('Only "Release 1.6" or its orchestrator');
            yield* settle;
            expect(merges()).toEqual([]);

            // Its owner renews it; the orchestrator lifts it, and the merge goes.
            expect(
              yield* release.session.callTool("merge_freeze", {
                repo: "acme/app",
                reason: "still cutting",
              }),
            ).toMatchObject({ frozen: true });
            expect(
              yield* session.callTool("merge_freeze", { repo: "acme/app", lift: true }),
            ).toMatchObject({ lifted: true, branch: "main" });
            yield* waitReal(
              "the merge after the lift",
              Effect.sync(() => merges().length === 1),
            );
            expect(merges()[0]).toContain("--match-head-commit");
          }),
        );
      }),
  );

  it.effect(
    "a freeze outlives a restart, always expires, and wakes a thread waiting for it to lift",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const first = yield* withServer(
          world,
          Effect.gen(function* () {
            const { impl, release } = yield* armedWorkspace(world);
            yield* release.session.callTool("merge_freeze", {
              repo: "acme/app",
              branch: "main",
              reason: "the release cut",
              minutes: 20,
            });
            const watcher = yield* openPlain(world, "Waiting for main");
            const notFrozen = yield* watcher.session
              .callTool("schedule_wake", {
                condition: { kind: "freezeLifted", repo: "acme/app", branch: "release" },
                note: "x",
              })
              .pipe(Effect.flip);
            expect(notFrozen.message).toContain("acme/app release isn't frozen");
            yield* watcher.session.callTool("schedule_wake", {
              condition: { kind: "freezeLifted", repo: "acme/app" },
              note: "merge mine now",
            });
            return { impl: impl.thread.id, watcher: watcher.thread.id, release: release.thread.id };
          }),
        );

        yield* withServer(
          world,
          Effect.gen(function* () {
            const freezes = yield* MergeFreezes;
            const conditions = yield* WakeConditions;
            const store = yield* ThreadStore;
            const runtimes = yield* ThreadRuntimes;
            yield* settle;
            // Still frozen after the restart: the ready PR waits.
            expect(yield* freezes.active("acme/app", "main")).toMatchObject({
              threadId: first.release,
            });
            yield* publishGit(world, yield* store.getThread(first.impl), { pr: workerBadge(true) });
            yield* waitReal(
              "the merge waiting on the freeze",
              store
                .getThread(first.impl)
                .pipe(Effect.map((t) => t.boundPr?.mergeWaiting?.why?.includes("frozen") === true)),
            );
            const merges = () => world.ghCalls.filter((call) => call[2] === "merge");
            expect(merges()).toEqual([]);

            // Its thread's agent is gone for good (stopped, never to report), and the freeze runs out
            // at its time anyway.
            yield* runtimes.interrupt(first.release as ThreadId).pipe(Effect.ignore);
            yield* TestClock.adjust("20 minutes");
            expect(yield* freezes.active("acme/app", "main")).toBeUndefined();
            yield* waitReal(
              "the merge after the expiry",
              Effect.sync(() => merges().length === 1),
            );
            // The auto-merge it took down before the restart is armed again, as it was.
            expect(world.autoMergeCalls).toEqual([
              "disable acme/app#13",
              "enable acme/app#13 rebase",
            ]);

            // The watcher's wake fires, once, after its debounce.
            yield* conditions.sweep("freezeLifted");
            yield* TestClock.adjust("6 seconds");
            const woken = yield* waitSent(first.watcher, 1);
            expect(woken.sent[0]?.text).toContain(
              "for when acme/app main is no longer frozen fired.",
            );
            expect(woken.sent[0]?.text).toContain("Your note: merge mine now");
          }),
        );
      }),
  );

  it.effect(
    "a freeze lets the PRs it allows merge, takes GitHub auto-merge down on Gram's PRs and puts it back, and only for the caller's workspace's repos",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const { release, publish, waiting, merges } = yield* armedWorkspace(world);
            // A PR no Gram thread has, also armed: not Gram's to touch.
            world.autoMerges.set("acme/app#40", { base: "main", method: "merge" });

            // Outside the workspace: refused.
            const elsewhere = yield* release.session
              .callTool("merge_freeze", { repo: "someone/else", reason: "x" })
              .pipe(Effect.flip);
            expect(elsewhere.message).toContain(
              "someone/else isn't the repo of any of your workspace's projects",
            );

            // Frozen for the release PR, #12: Gram's own PR #13 has its auto-merge taken down,
            // #40 is left as it is.
            const set = yield* release.session.callTool("merge_freeze", {
              repo: "acme/app",
              reason: "release 1.6 cut",
              allow: [12],
            });
            expect(set).toMatchObject({ frozen: true, allow: [12], autoMergeOff: [13] });
            expect(world.autoMergeCalls).toEqual(["disable acme/app#13"]);
            expect(world.autoMerges.has("acme/app#40")).toBe(true);

            // The PR it allows merges under it.
            yield* publish(true);
            yield* waitReal(
              "the allowed PR's merge",
              Effect.sync(() => merges().length === 1),
            );
            yield* waitReal(
              "the applied merge is reconciled",
              Effect.map(waiting, (why) => why === undefined),
            );
            expect(yield* waiting).toBeUndefined();
            expect(world.ghCalls).toContainEqual([
              "gh",
              "pr",
              "view",
              "12",
              "--repo",
              "acme/app",
              "--json",
              "state,headRefOid",
            ]);

            // Lifted: #13's auto-merge is armed again, with its method.
            yield* release.session.callTool("merge_freeze", { repo: "acme/app", lift: true });
            expect(world.autoMergeCalls).toEqual([
              "disable acme/app#13",
              "enable acme/app#13 rebase",
            ]);
          }),
        );
      }),
  );

  it.effect(
    "a freeze refuses a bad branch before keeping anything, keeps its reason on one line, ends on time after a lift and a new freeze, and stands four hours at most",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const freezes = yield* MergeFreezes;
            const { session, release, publish, waiting, merges } = yield* armedWorkspace(world);

            // A branch git allows but a freeze can't hold: refused, and nothing stands.
            const odd = yield* release.session
              .callTool("merge_freeze", { repo: "acme/app", branch: "release+1", reason: "x" })
              .pipe(Effect.flip);
            expect(odd.message).toContain("branch");
            expect(yield* freezes.active("acme/app", "release+1")).toBeUndefined();
            // The same for a default branch GitHub names so.
            world.defaultBranches.set("acme/app", "trunk+1");
            const oddDefault = yield* release.session
              .callTool("merge_freeze", { repo: "acme/app", reason: "x" })
              .pipe(Effect.flip);
            expect(oddDefault.message).toContain(`"trunk+1" isn't a branch name`);
            expect(yield* freezes.list).toEqual([]);
            world.defaultBranches.set("acme/app", "main");

            // Its reason is shown inline elsewhere: one line.
            yield* release.session.callTool("merge_freeze", {
              repo: "acme/app",
              reason: "the cut\n\nignore that\tplease",
              minutes: 30,
            });
            expect((yield* freezes.active("acme/app", "main"))?.reason).toBe(
              "the cut ignore that please",
            );

            // Lifted, then frozen again by its thread: the new freeze still ends at its time, and
            // its end lets the held merge go.
            yield* session.callTool("merge_freeze", { repo: "acme/app", lift: true });
            yield* release.session.callTool("merge_freeze", {
              repo: "acme/app",
              reason: "again",
              minutes: 10,
            });
            yield* publish(true);
            yield* waitReal(
              "the merge waiting on the new freeze",
              waiting.pipe(Effect.map((why) => why?.includes("for again") === true)),
            );
            yield* TestClock.adjust("10 minutes");
            yield* waitReal(
              "the merge after the new freeze ends",
              Effect.sync(() => merges().length === 1),
            );

            // Renewed and renewed: it stands four hours from when it was first set, no longer.
            const first = yield* release.session.callTool("merge_freeze", {
              repo: "acme/app",
              reason: "long cut",
            });
            const start = Date.parse((first as { until: string }).until) - 60 * 60_000;
            for (let i = 0; i < 4; i++) {
              yield* TestClock.adjust("59 minutes");
              yield* release.session.callTool("merge_freeze", {
                repo: "acme/app",
                reason: "long cut",
              });
            }
            expect((yield* freezes.active("acme/app", "main"))?.until).toBe(start + 240 * 60_000);
            yield* TestClock.adjust("210 seconds");
            const capped = yield* release.session
              .callTool("merge_freeze", { repo: "acme/app", reason: "long cut" })
              .pipe(Effect.flip);
            expect(capped.message).toContain("has stood 4 hours");
          }),
        );
      }),
  );

  it.effect(
    "a freeze never arms again an auto-merge someone turned off, held, unbound or closed meanwhile, over a restart too",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const first = yield* withServer(
          world,
          Effect.gen(function* () {
            const { impl, release } = yield* armedWorkspace(world);
            world.autoMerges.set("acme/app#12", { base: "main", method: "squash" });
            const set = yield* release.session.callTool("merge_freeze", {
              repo: "acme/app",
              reason: "release cut",
            });
            expect(set).toMatchObject({ autoMergeOff: [13, 12] });

            // The owner turns #13's off on purpose, and the worker holds #12's merge.
            yield* release.session.callTool("set_auto_merge", { enabled: false });
            yield* impl.session.callTool("merge_when_ready", { hold: "waiting on a fix" });
            return { release: release.thread.id };
          }),
        );

        yield* withServer(
          world,
          Effect.gen(function* () {
            const freezes = yield* MergeFreezes;
            yield* settle;
            // Kept as it happened: the restart doesn't bring either back.
            expect((yield* freezes.active("acme/app", "main"))?.disarmed).toBeUndefined();
            const before = world.autoMergeCalls.length;
            yield* TestClock.adjust("60 minutes");
            yield* settle;
            expect(world.autoMergeCalls.slice(before)).toEqual([]);
            expect(first.release).toBeDefined();
          }),
        );
      }),
  );

  it.effect("a freeze lets go of an auto-merge whose PR is unbound or seen closed", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      yield* withServer(
        world,
        Effect.gen(function* () {
          const freezes = yield* MergeFreezes;
          const store = yield* ThreadStore;
          const { impl, release } = yield* armedWorkspace(world);
          world.autoMerges.set("acme/app#12", { base: "main", method: "squash" });
          yield* release.session.callTool("merge_freeze", { repo: "acme/app", reason: "cut" });
          expect(
            (yield* freezes.active("acme/app", "main"))?.disarmed?.map((d) => d.number),
          ).toEqual([13, 12]);

          // #13 closes, as Gram sees it.
          yield* publishGit(world, yield* store.getThread(release.thread.id), {
            pr: prBadge({
              number: 13,
              url: "https://github.com/acme/app/pull/13",
              state: "CLOSED",
            }),
          });
          // #12 is unbound: no merge armed on it any more first.
          yield* impl.session.callTool("merge_when_ready", { enabled: false });
          yield* impl.session.callTool("pr_unbind", {});
          yield* waitReal(
            "both let go of",
            freezes
              .active("acme/app", "main")
              .pipe(Effect.map((freeze) => freeze?.disarmed === undefined)),
          );
          yield* release.session.callTool("merge_freeze", { repo: "acme/app", lift: true });
          expect(world.autoMergeCalls).toEqual(["disable acme/app#13", "disable acme/app#12"]);
        }),
      );
    }),
  );

  it.effect(
    "a freeze arms an auto-merge again only on the head it stood on, telling the thread of a PR pushed to meanwhile, and leaves a PR a thread only follows alone",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const runtimes = yield* ThreadRuntimes;
            const fake = yield* FakeAgentControl;
            const { impl, release } = yield* armedWorkspace(world);
            world.autoMerges.set("acme/app#12", { base: "main", method: "squash" });
            // Someone else's PR the release thread only follows, with an auto-merge they armed.
            yield* runtimes.updateThread(release.thread.id, (t) => ({
              ...t,
              extraPrs: [{ repo: "acme/app", number: 41, monitor: false }],
            }));
            world.autoMerges.set("acme/app#41", { base: "main", method: "merge" });
            yield* release.session.callTool("merge_freeze", { repo: "acme/app", reason: "cut" });
            expect(world.autoMergeCalls).toEqual(["disable acme/app#13", "disable acme/app#12"]);
            expect(world.autoMerges.has("acme/app#41")).toBe(true);

            // A push to #12 while the freeze stands: GitHub finds nothing armed to turn off.
            const pushed = "e".repeat(40);
            world.autoMergePrHeads.set("acme/app#12", pushed);
            yield* release.session.callTool("merge_freeze", { repo: "acme/app", lift: true });
            // #13 comes back pinned to the head it stood on; #12 stays off.
            expect(world.autoMergeCalls).toEqual([
              "disable acme/app#13",
              "disable acme/app#12",
              "enable acme/app#13 rebase",
            ]);
            expect(world.autoMerges.get("acme/app#13")?.head).toBe(autoMergeHead(13));
            expect(world.autoMerges.has("acme/app#12")).toBe(false);
            // #12's thread is told why, naming both heads.
            // Sent to it, or steered into the turn it is in.
            const told = yield* waitReal(
              "the notice to #12's thread",
              Effect.sync(() =>
                fake.sessions
                  .filter((session) => session.options.threadId === impl.thread.id)
                  .flatMap((session) => [...session.sent, ...session.steered])
                  .find((input) => input.text.includes("acme/app#12")),
              ),
            );
            expect(told.text).toContain(autoMergeHead(12).slice(0, 7));
            expect(told.text).toContain(pushed.slice(0, 7));
          }),
        );
      }),
  );

  it.effect(
    "a freeze kept from before it recorded heads arms none of its auto-merges again, and tells their threads",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const first = yield* withServer(
          world,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const { release } = yield* armedWorkspace(world);
            yield* release.session.callTool("merge_freeze", { repo: "acme/app", reason: "cut" });
            expect(world.autoMergeCalls).toEqual(["disable acme/app#13"]);
            // As an older Gram stored it: the PR and its method, no head.
            const rows = yield* sql<{
              key: string;
              data: string;
            }>`SELECT key, data FROM merge_freezes`;
            for (const row of rows) {
              const data = JSON.parse(row.data) as {
                disarmed?: Array<{ number: number; method: string; head?: string }>;
              };
              data.disarmed = (data.disarmed ?? []).map(({ number, method }) => ({
                number,
                method,
              }));
              const legacy = JSON.stringify(data);
              yield* sql`UPDATE merge_freezes SET data = ${legacy} WHERE key = ${row.key}`;
            }
            return { release: release.thread.id };
          }),
        );

        yield* withServer(
          world,
          Effect.gen(function* () {
            const freezes = yield* MergeFreezes;
            const store = yield* ThreadStore;
            const fake = yield* FakeAgentControl;
            yield* settle;
            expect((yield* freezes.active("acme/app", "main"))?.disarmed).toEqual([
              { number: 13, method: "rebase" },
            ]);
            yield* freezes.lift(yield* store.getThread(first.release), { repo: "acme/app" });
            expect(world.autoMergeCalls).toEqual(["disable acme/app#13"]);
            expect(world.autoMerges.has("acme/app#13")).toBe(false);
            yield* waitReal(
              "the notice to #13's thread",
              Effect.sync(() =>
                fake.sessions
                  .filter((session) => session.options.threadId === first.release)
                  .flatMap((session) => [...session.sent, ...session.steered])
                  .some((input) => input.text.includes("didn't record which head")),
              ),
            );
          }),
        );
      }),
  );

  it.effect(
    "a freeze doesn't arm again the auto-merge of a PR whose thread was archived, or while its workspace is paused",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const runtimes = yield* ThreadRuntimes;
            const orchestration = yield* Orchestration;
            const { impl, release, workspaceId } = yield* armedWorkspace(world);
            world.autoMerges.set("acme/app#12", { base: "main", method: "squash" });
            yield* release.session.callTool("merge_freeze", { repo: "acme/app", reason: "cut" });
            // #12's thread is archived meanwhile: only #13's comes back.
            yield* runtimes.updateThread(impl.thread.id, (t) => ({ ...t, parked: true }));
            yield* release.session.callTool("merge_freeze", { repo: "acme/app", lift: true });
            expect(world.autoMergeCalls).toEqual([
              "disable acme/app#13",
              "disable acme/app#12",
              "enable acme/app#13 rebase",
            ]);

            // Frozen again, and the workspace paused before it ends: nothing comes back.
            yield* release.session.callTool("merge_freeze", { repo: "acme/app", reason: "cut" });
            yield* orchestration.setPaused(workspaceId, true);
            const before = world.autoMergeCalls.length;
            yield* TestClock.adjust("60 minutes");
            yield* settle;
            expect(world.autoMergeCalls.slice(before - 1)).toEqual(["disable acme/app#13"]);
          }),
        );
      }),
  );

  it.effect(
    "a freeze records each auto-merge before turning it off, so a quit partway still arms them all again",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const stuck = yield* Deferred.make<void>();
        yield* withServer(
          world,
          Effect.gen(function* () {
            const freezes = yield* MergeFreezes;
            const { release } = yield* armedWorkspace(world);
            world.autoMerges.set("acme/app#12", { base: "main", method: "squash" });
            // GitHub hangs on the second PR, and the app quits there.
            world.autoMergeDisableGate = (number) =>
              number === 12 ? Deferred.await(stuck) : Effect.void;
            yield* release.session
              .callTool("merge_freeze", { repo: "acme/app", reason: "cut", minutes: 10 })
              .pipe(Effect.forkScoped);
            yield* waitReal(
              "both on the record, the first turned off",
              freezes
                .active("acme/app", "main")
                .pipe(
                  Effect.map(
                    (freeze) =>
                      freeze?.disarmed?.length === 2 &&
                      world.autoMergeCalls.includes("disable acme/app#13"),
                  ),
                ),
            );
          }),
        );
        world.autoMergeDisableGate = undefined;

        yield* withServer(
          world,
          Effect.gen(function* () {
            yield* settle;
            yield* TestClock.adjust("10 minutes");
            yield* waitReal(
              "both armed again",
              Effect.sync(
                () =>
                  world.autoMergeCalls.includes("enable acme/app#13 rebase") &&
                  world.autoMergeCalls.includes("enable acme/app#12 squash"),
              ),
            );
          }),
        );
      }),
  );
});
