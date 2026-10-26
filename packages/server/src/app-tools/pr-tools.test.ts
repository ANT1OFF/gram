// PR app tools and run_monitor.
import { describe, expect, it } from "@effect/vitest";
import { MAX_RUN_WATCHES, ORCHESTRATOR_HAS_NO_PR, type PrStatus } from "@gram/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { EventHub } from "../events/event-hub.ts";
import { GitStatePublisher } from "../git/publisher.ts";
import { RunMonitor } from "../git/run-monitor.ts";
import { eventually, hasGit, removeDir, run } from "../git/test-repo.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentControl } from "../runtime/fake-agent.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { AppToolRegistry } from "./registry.ts";
import {
  current,
  ghCalls,
  ghDirs,
  type GhReply,
  ok,
  gh,
  badge,
  TestLayer,
  mergeCall,
  viewCall,
  command,
  liveThread,
  RunTestLayer,
  monitorReads,
  RunLoopTestLayer,
  viewsOf,
  sentTo,
  runJson,
  watches,
} from "./pr-tools-kit.ts";

/** Runs set_auto_merge on a fresh thread whose branch PR is `pr`, answering gh with `answer`. */
const setAutoMerge = (pr: PrStatus, answer: (args: ReadonlyArray<string>) => GhReply = () => ok) =>
  Effect.gen(function* () {
    current.badge = pr;
    gh.answer = answer;
    ghCalls.length = 0;
    const { hosted } = yield* liveThread;
    return yield* hosted("set_auto_merge").run({});
  }).pipe(Effect.ensuring(Effect.sync(() => (gh.answer = () => ok))));

describe.skipIf(!hasGit)("PR app tools", () => {
  it.live(
    "pr_bind follows the branch's PR, pr_status reads it, pr_monitor and pr_unbind update it",
    () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const { thread, hosted } = yield* liveThread;
        current.badge = undefined;
        const unbound = yield* hosted("pr_bind").run({}).pipe(Effect.flip);
        expect(unbound.message).toMatch(/pass repo and number/);

        current.badge = badge();
        expect(yield* hosted("pr_bind").run({})).toEqual({
          bound: { repo: "acme/web", number: 7, monitor: false },
        });
        expect(yield* hosted("pr_status").run({})).toMatchObject({
          bound: { repo: "acme/web", number: 7, monitor: false },
          pr: badge(),
        });
        expect(yield* hosted("pr_monitor").run({})).toMatchObject({ monitor: true });
        expect((yield* store.getThread(thread.id)).boundPr).toEqual({
          repo: "acme/web",
          number: 7,
          monitor: true,
        });
        const invalid = yield* hosted("pr_bind")
          .run({ repo: "not a repo", number: 1 })
          .pipe(Effect.flip);
        expect(invalid.message).toBe("invalid pull request not a repo#1");

        expect(yield* hosted("pr_bind").run({ repo: "acme/lib", number: 42, add: true })).toEqual({
          bound: { repo: "acme/lib", number: 42, monitor: false },
        });
        const following = yield* store.getThread(thread.id);
        expect(following.boundPr?.number).toBe(7);
        expect(following.extraPrs).toEqual([{ repo: "acme/lib", number: 42, monitor: false }]);
        const twice = yield* hosted("pr_bind")
          .run({ repo: "acme/lib", number: 42, add: true })
          .pipe(Effect.flip);
        expect(twice.message).toContain("already followed");

        // Half a reference is refused rather than taken for the main PR.
        const half = yield* hosted("pr_unbind").run({ repo: "acme/lib" }).pipe(Effect.flip);
        expect(half.message).toContain("both repo and number");
        expect((yield* store.getThread(thread.id)).boundPr?.number).toBe(7);
        expect((yield* store.getThread(thread.id)).extraPrs).toHaveLength(1);

        yield* hosted("pr_unbind").run({ repo: "acme/lib", number: 42 });
        const unfollowed = yield* store.getThread(thread.id);
        expect(unfollowed.extraPrs).toBeUndefined();
        expect(unfollowed.boundPr?.number).toBe(7);

        yield* hosted("pr_unbind").run({});
        expect((yield* store.getThread(thread.id)).boundPr).toBeUndefined();
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.live("an orchestrator follows no PR: its tools refuse, and a worker's PR is still read", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const runtimes = yield* ThreadRuntimes;
      const registry = yield* AppToolRegistry;
      const publisher = yield* GitStatePublisher;
      const { thread, hosted } = yield* liveThread;
      current.badge = badge();
      yield* hosted("pr_bind").run({ monitor: true });
      // Made one while it followed a PR, as an earlier build could leave it: the write drops it.
      const orchestrator = yield* runtimes.updateThread(thread.id, (t) => ({
        ...t,
        role: "orchestrator",
      }));
      expect(orchestrator.boundPr).toBeUndefined();
      expect(yield* publisher.badgeFor(orchestrator)).toBeUndefined();
      for (const name of ["pr_bind", "pr_monitor", "pr_status", "set_auto_merge"]) {
        const refused = yield* hosted(name).run({}).pipe(Effect.flip);
        expect(refused.message, name).toBe(ORCHESTRATOR_HAS_NO_PR);
      }
      expect((yield* store.getThread(thread.id)).boundPr).toBeUndefined();
      expect(yield* store.listRequests(thread.id)).toEqual([]);

      const offered = registry.forThread(thread.id, "orchestrator").map((t) => t.descriptor.name);
      expect(offered).toEqual(expect.arrayContaining(["pr_status", "set_auto_merge"]));
      for (const name of ["pr_bind", "pr_unbind", "pr_monitor"])
        expect(offered).not.toContain(name);

      const worker = yield* liveThread;
      yield* worker.hosted("pr_bind").run({});
      expect(yield* hosted("pr_status").run({ threadId: worker.thread.id })).toMatchObject({
        bound: { repo: "acme/web", number: 7 },
        pr: badge(),
      });
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.live("set_auto_merge names the PR, asks every time and only runs gh once allowed", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const runtimes = yield* ThreadRuntimes;
      const { thread, hosted, transport } = yield* liveThread;
      const publisher = yield* GitStatePublisher;
      current.badge = badge({ title: "Fix login" });
      yield* hosted("pr_bind").run({});
      // The card names the PR from the badge already fetched, never from a lookup of its own.
      yield* eventually(
        "the bound PR's badge",
        store.getThread(thread.id).pipe(Effect.flatMap(publisher.badgeFor)),
      );
      ghCalls.length = 0;

      const card = (decision: "allow" | "deny", description: string) =>
        Effect.gen(function* () {
          const request = yield* eventually(
            "the approval card",
            store.listRequests(thread.id).pipe(Effect.map((requests) => requests[0])),
          );
          expect(request).toMatchObject({
            toolName: "mcp__gram__set_auto_merge",
            scopes: ["once"],
            description,
          });
          yield* runtimes.respond(thread.id, request.id, {
            kind: "approval",
            decision,
            scope: "once",
          });
        });

      const allowed = yield* Effect.forkScoped(
        transport("set_auto_merge").run({ method: "rebase" }),
      );
      yield* card("allow", "Merge acme/web#7 “Fix login” (rebase) once GitHub allows it");
      expect(yield* Fiber.join(allowed)).toEqual({
        number: 7,
        merged: false,
        autoMerge: true,
        method: "rebase",
      });
      // Armed, then asked whether gh merged it at once instead.
      expect(ghCalls).toEqual([
        ["gh", "pr", "merge", "7", "--auto", "--rebase", "--repo", "acme/web"],
        ["gh", "pr", "view", "7", "--json", "state", "--jq", ".state", "--repo", "acme/web"],
      ]);

      const declined = yield* Effect.forkScoped(
        transport("set_auto_merge").run({ enabled: false }),
      );
      yield* card("deny", "Stop auto-merging acme/web#7 “Fix login”");
      expect(yield* Fiber.join(declined).pipe(Effect.flip)).toMatchObject({
        approvalRequired: true,
      });
      expect(ghCalls).toHaveLength(2);

      // Where nothing orchestrates, nothing is delegated: the named check says no, there is no
      // `needsApproval` to say yes with, and naming another thread is a card like any other.
      const tool = hosted("set_auto_merge");
      expect(tool.needsApproval).toBeUndefined();
      expect(yield* tool.delegatedAtFullAutonomy!({ threadId: thread.id })).toBe(false);
      expect(yield* tool.delegatedAtFullAutonomy!({})).toBe(false);
      const other = yield* liveThread;
      yield* runtimes.updateThread(other.thread.id, (t) => ({ ...t, title: "API work" }));
      run(other.thread.checkout.path, "remote", "add", "origin", "https://github.com/acme/api.git");
      const onAnother = yield* Effect.forkScoped(
        transport("set_auto_merge").run({ threadId: other.thread.id, number: 9 }),
      );
      // The card says which repo the number is in, and gh is told the same one.
      yield* card("allow", "Merge acme/api#9 (squash) once GitHub allows it, on “API work”");
      expect(yield* Fiber.join(onAnother)).toEqual({
        threadId: other.thread.id,
        number: 9,
        merged: false,
        autoMerge: true,
        method: "squash",
      });
      expect(ghCalls.at(-2)).toEqual([
        "gh",
        "pr",
        "merge",
        "9",
        "--auto",
        "--squash",
        "--repo",
        "acme/api",
      ]);

      // A thread with no PR to name, or no repo to name it in, fails before anything is asked.
      current.badge = undefined;
      const none = yield* liveThread;
      const refused = yield* none.transport("set_auto_merge").run({}).pipe(Effect.flip);
      expect(refused.message).toMatch(/No pull request found/);
      const nowhere = yield* none.transport("set_auto_merge").run({ number: 5 }).pipe(Effect.flip);
      expect(nowhere.message).toMatch(/Can't tell which repository #5 is in/);
      expect(yield* store.listRequests(none.thread.id)).toEqual([]);
      expect(ghCalls.filter(([, , verb]) => verb === "merge")).toHaveLength(2);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.live("set_auto_merge merges a clean PR at once and arms one that has to wait", () =>
    Effect.gen(function* () {
      // Clean: merged at once, pinned to the head the badge showed.
      const clean = yield* setAutoMerge(badge({ mergeState: "CLEAN", headRefOid: "abc123" }));
      expect(clean).toEqual({ number: 7, merged: true, autoMerge: false, method: "squash" });
      expect(ghCalls).toEqual([mergeCall("7", "--squash", "--match-head-commit", "abc123")]);

      // A check GitHub doesn't require still running, or a required one: armed as before.
      for (const mergeState of ["UNSTABLE", "BLOCKED"]) {
        const waiting = yield* setAutoMerge(badge({ mergeState, headRefOid: "abc123" }), (args) =>
          command(args) === "pr view" ? { ...ok, stdout: "OPEN\n" } : ok,
        );
        expect(waiting, mergeState).toEqual({
          number: 7,
          merged: false,
          autoMerge: true,
          method: "squash",
        });
        expect(ghCalls, mergeState).toEqual([
          mergeCall("7", "--auto", "--squash"),
          viewCall("state"),
        ]);
      }

      // gh read the PR as blocked and GitHub found it clean: merged instead, at the head seen.
      const refused: GhReply = {
        status: 1,
        stdout: "",
        stderr:
          "GraphQL: Pull request Pull request is in clean status (enablePullRequestAutoMerge)\n",
      };
      const raced = yield* setAutoMerge(
        badge({ mergeState: "BLOCKED", headRefOid: "abc123" }),
        (args) => (args.includes("--auto") ? refused : ok),
      );
      expect(raced).toEqual({ number: 7, merged: true, autoMerge: false, method: "squash" });
      expect(ghCalls).toEqual([
        mergeCall("7", "--auto", "--squash"),
        mergeCall("7", "--squash", "--match-head-commit", "abc123"),
      ]);
      // With no head on the badge, the merge is pinned to the one GitHub reports.
      const unseen = yield* setAutoMerge(badge(), (args) =>
        args.includes("--auto")
          ? refused
          : command(args) === "pr view"
            ? { ...ok, stdout: "def456\n" }
            : ok,
      );
      expect(unseen).toMatchObject({ merged: true });
      expect(ghCalls).toEqual([
        mergeCall("7", "--auto", "--squash"),
        viewCall("headRefOid"),
        mergeCall("7", "--squash", "--match-head-commit", "def456"),
      ]);
      // A pinned merge GitHub refuses, a moved head say, is the tool's failure.
      const moved = yield* setAutoMerge(
        badge({ mergeState: "CLEAN", headRefOid: "abc123" }),
        () => ({
          status: 1,
          stdout: "",
          stderr: "GraphQL: Head branch was modified. Review and try the merge again.\n",
        }),
      ).pipe(Effect.flip);
      expect(moved.message).toContain("Head branch was modified");
      expect(ghCalls).toHaveLength(1);

      // A repo without auto-merge: gh merges a PR it reads as mergeable itself, and the result
      // says so; one that has to wait is refused as before.
      const itself = yield* setAutoMerge(badge(), (args) =>
        command(args) === "pr view" ? { ...ok, stdout: "MERGED\n" } : ok,
      );
      expect(itself).toEqual({ number: 7, merged: true, autoMerge: false, method: "squash" });
      const notAllowed = yield* setAutoMerge(badge({ mergeState: "BLOCKED" }), (args) =>
        args.includes("--auto")
          ? {
              status: 1,
              stdout: "",
              stderr:
                "GraphQL: Auto merge is not allowed for this repository (enablePullRequestAutoMerge)\n",
            }
          : ok,
      ).pipe(Effect.flip);
      expect(notAllowed.message).toContain("Auto merge is not allowed");
      expect(ghCalls).toEqual([mergeCall("7", "--auto", "--squash")]);

      // Turning it off is one call, and never a merge.
      current.badge = badge({ mergeState: "CLEAN", headRefOid: "abc123" });
      ghCalls.length = 0;
      const off = yield* (yield* liveThread).hosted("set_auto_merge").run({ enabled: false });
      expect(off).toEqual({ number: 7, autoMerge: false });
      expect(ghCalls).toEqual([mergeCall("7", "--disable-auto")]);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});

describe.skipIf(!hasGit)("run_monitor", () => {
  it.live(
    "watches a run, and sends one message when it completes, even one it only finds done",
    () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const monitor = yield* RunMonitor;
        const fake = yield* FakeAgentControl;
        // So a completion behind a running turn queues rather than steering into it.
        yield* fake.setSteerCapability(false);
        const { thread, hosted } = yield* liveThread;
        let state = runJson(99, "in_progress");
        gh.answer = ([, path = ""]) =>
          path.includes("/jobs")
            ? {
                ...ok,
                stdout: JSON.stringify({
                  jobs: [
                    { name: "sign", conclusion: "failure" },
                    { name: "build", conclusion: "success" },
                  ],
                }),
              }
            : path.endsWith("/actions/workflows?per_page=100")
              ? { ...ok, stdout: JSON.stringify({ workflows: [{ id: 7, name: "release" }] }) }
              : path.includes("/workflows/7/runs")
                ? {
                    ...ok,
                    stdout: JSON.stringify({
                      workflow_runs: [runJson(100, "completed", "success")],
                    }),
                  }
                : { ...ok, stdout: JSON.stringify(state) };

        expect(
          yield* hosted("run_monitor").run({ run: "https://github.com/acme/web/actions/runs/99" }),
        ).toMatchObject({ watching: true, run: { repo: "acme/web", runId: 99 } });
        expect((yield* store.getThread(thread.id)).runWatches).toHaveLength(1);
        yield* monitor.poll;
        expect((yield* store.getThread(thread.id)).runWatches).toHaveLength(1);

        state = runJson(99, "completed", "failure");
        yield* monitor.poll;
        const told = yield* eventually(
          "the run's message",
          Effect.sync(() =>
            fake.sessions
              .filter((session) => session.options.threadId === thread.id)
              .flatMap((session) => session.sent.map((input) => input.text))
              .find((text) => text.includes("#99")),
          ),
        );
        expect(told).toBe(
          'Workflow run "release: v0.8.0-rc.1" (acme/web #99) completed: failure. Failed: sign. https://github.com/acme/web/actions/runs/99',
        );
        expect((yield* store.getThread(thread.id)).runWatches).toBeUndefined();

        // The latest run of a workflow that is already done is answered at once, with no watch.
        expect(yield* hosted("run_monitor").run({ workflow: "Release", repo: "acme/web" })).toEqual(
          {
            watching: false,
            completed:
              'Workflow run "release: v0.8.0-rc.1" (acme/web #100) completed: success. https://github.com/acme/web/actions/runs/100',
          },
        );
        const bad = yield* hosted("run_monitor").run({ run: "soon" }).pipe(Effect.flip);
        expect(bad.message).toContain("neither a run id nor a run's URL");
        const badStop = yield* hosted("run_monitor")
          .run({ run: "soon", enabled: false })
          .pipe(Effect.flip);
        expect(badStop.message).toContain("neither a run id nor a run's URL");

        // Queued behind a running turn when the thread is archived: taken back, and watched again.
        const runtimes = yield* ThreadRuntimes;
        state = runJson(102, "in_progress");
        yield* hosted("run_monitor").run({ run: "102", repo: "acme/web" });
        yield* runtimes.send(thread.id, { text: "keep working" });
        state = runJson(102, "completed", "success");
        yield* monitor.poll;
        yield* eventually(
          "the completion queued",
          runtimes.snapshot.pipe(
            Effect.map((all) =>
              all
                .find((summary) => summary.thread.id === thread.id)
                ?.queue.some((item) => item.input.text.includes("#102")),
            ),
          ),
        );
        yield* runtimes.updateThread(thread.id, (t) => ({ ...t, parked: true }));
        const back = yield* eventually(
          "the watch put back",
          store.getThread(thread.id).pipe(Effect.map((t) => t.runWatches?.[0])),
        );
        expect(back).toMatchObject({ repo: "acme/web", runId: 102 });
        yield* runtimes.updateThread(thread.id, (t) => ({ ...t, parked: false }));
        yield* hosted("run_monitor").run({ enabled: false });

        // Stopped, it is looked up no more.
        state = runJson(101, "queued");
        yield* hosted("run_monitor").run({ run: "101", repo: "acme/web" });
        expect(yield* hosted("run_monitor").run({ enabled: false })).toEqual({ stopped: 1 });
        const before = ghCalls.length;
        state = runJson(101, "completed", "success");
        yield* monitor.poll;
        expect(ghCalls.length).toBe(before);
        gh.answer = () => ok;
      }).pipe(Effect.scoped, Effect.provide(RunTestLayer)),
  );

  it.live("holds completions an archive can't put back as watches, and sends them on return", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const runtimes = yield* ThreadRuntimes;
      const monitor = yield* RunMonitor;
      const fake = yield* FakeAgentControl;
      yield* fake.setSteerCapability(false);
      const { thread } = yield* liveThread;
      gh.answer = ([, path = ""]) => {
        const runId = Number(/actions\/runs\/(\d+)/.exec(path)?.[1] ?? 0);
        return { ...ok, stdout: JSON.stringify(runJson(runId, "completed", "success")) };
      };
      yield* runtimes.send(thread.id, { text: "busy work" });
      yield* eventually(
        "the turn",
        runtimes.status(thread.id).pipe(Effect.map((s) => s === "running" || undefined)),
      );
      const session = yield* fake.latest(thread.id);
      // Their completions queue behind the turn, and free every slot for runs watched after.
      yield* runtimes.updateThread(thread.id, (t) => ({ ...t, runWatches: watches(1) }));
      // Polled once the monitor has heard of the watches, from the upsert.
      yield* eventually(
        "the completions queued",
        monitor.poll.pipe(
          Effect.andThen(store.listQueue(thread.id)),
          Effect.map((queue) => queue.length === MAX_RUN_WATCHES || undefined),
        ),
      );
      yield* runtimes.updateThread(thread.id, (t) => ({ ...t, runWatches: watches(101) }));

      // No room to watch them again, so the archive leaves them queued, held.
      const hub = yield* EventHub;
      const upserts = { count: 0 };
      yield* Effect.forkScoped(
        hub.serverEvents(Effect.succeed({ type: "threads.snapshot", threads: [] })).pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              if (event.type === "thread.upsert" && event.thread.id === thread.id) upserts.count++;
            }),
          ),
        ),
        { startImmediately: true },
      );
      yield* runtimes.updateThread(thread.id, (t) => ({ ...t, parked: true }));
      yield* Effect.sleep(Duration.millis(200));
      // And it writes nothing back, which it would hear again as another upsert, and so on.
      const seen = upserts.count;
      expect(seen).toBeGreaterThan(0);
      yield* Effect.sleep(Duration.millis(200));
      expect(upserts.count).toBe(seen);
      expect(yield* store.listQueue(thread.id)).toHaveLength(MAX_RUN_WATCHES);
      expect((yield* store.getThread(thread.id)).runWatches?.map((w) => w.runId)).toEqual(
        watches(101).map((w) => w.runId),
      );
      yield* session.completeTurn();
      yield* Effect.sleep(Duration.millis(100));
      expect(session.sent).toHaveLength(1);

      yield* runtimes.updateThread(thread.id, (t) => ({ ...t, parked: false }));
      const told = yield* eventually(
        "the first held completion",
        fake
          .latest(thread.id)
          .pipe(Effect.map((s) => s.sent.find((input) => input.text.includes("(acme/web #1)")))),
      );
      expect(told.text).toContain("completed: success");
      gh.answer = () => ok;
    }).pipe(Effect.scoped, Effect.provide(RunTestLayer)),
  );

  it.live(
    "looks a run up once a poll, and its failed jobs once, however many threads watch it",
    () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const monitor = yield* RunMonitor;
        const fake = yield* FakeAgentControl;
        const first = yield* liveThread;
        const second = yield* liveThread;
        let state = runJson(99, "in_progress");
        gh.answer = ([, path = ""]) =>
          path.includes("/jobs")
            ? {
                ...ok,
                stdout: JSON.stringify({ jobs: [{ name: "sign", conclusion: "failure" }] }),
              }
            : { ...ok, stdout: JSON.stringify(state) };
        for (const { hosted } of [first, second]) {
          yield* hosted("run_monitor").run({ run: "99", repo: "acme/web" });
        }
        ghCalls.length = 0;
        yield* monitor.poll;
        expect(viewsOf(99)).toBe(1);

        state = runJson(99, "completed", "failure");
        ghCalls.length = 0;
        yield* monitor.poll;
        expect(ghCalls.map((call) => call[2])).toEqual([
          "repos/acme/web/actions/runs/99",
          "repos/acme/web/actions/runs/99/jobs?per_page=100",
        ]);
        for (const { thread } of [first, second]) {
          const told = yield* eventually(
            "the run's message",
            Effect.sync(() => sentTo(fake, thread.id).find((text) => text.includes("#99"))),
          );
          expect(told).toContain("completed: failure. Failed: sign.");
          expect((yield* store.getThread(thread.id)).runWatches).toBeUndefined();
        }
        gh.answer = () => ok;
      }).pipe(Effect.scoped, Effect.provide(RunTestLayer)),
  );

  it.live("looks a shared run up from a watcher whose folder is still there", () =>
    Effect.gen(function* () {
      const monitor = yield* RunMonitor;
      const fake = yield* FakeAgentControl;
      const gone = yield* liveThread;
      const kept = yield* liveThread;
      gh.answer = () => ({ ...ok, stdout: JSON.stringify(runJson(99, "in_progress")) });
      for (const { hosted } of [gone, kept]) {
        yield* hosted("run_monitor").run({ run: "99", repo: "acme/web" });
      }
      // Deleted under its thread, which stays open: `gh` can't start there.
      removeDir(gone.thread.checkout.path);
      gh.answer = () => ({ ...ok, stdout: JSON.stringify(runJson(99, "completed", "success")) });
      ghCalls.length = 0;
      ghDirs.length = 0;
      yield* monitor.poll;
      expect(viewsOf(99)).toBe(1);
      expect(ghDirs).toEqual([kept.thread.checkout.path]);
      const told = yield* eventually(
        "the run's message",
        Effect.sync(() => sentTo(fake, kept.thread.id).find((text) => text.includes("#99"))),
      );
      expect(told).toContain("completed: success.");
      gh.answer = () => ok;
    }).pipe(Effect.scoped, Effect.provide(RunTestLayer)),
  );

  it.live("reads no thread while nothing is watched, and a watch wakes the poll loop", () =>
    Effect.gen(function* () {
      const fake = yield* FakeAgentControl;
      const { thread, hosted } = yield* liveThread;
      let state = runJson(99, "in_progress");
      gh.answer = () => ({ ...ok, stdout: JSON.stringify(state) });
      /** No read for 100 ms, ten poll intervals. */
      const quiet = Effect.gen(function* () {
        const gets = monitorReads.gets;
        yield* Effect.sleep(Duration.millis(100));
        return monitorReads.gets === gets;
      });
      // The thread's creation is read by the archive check; after that, nothing is.
      ghCalls.length = 0;
      yield* eventually("the loop idle", quiet);
      expect(yield* quiet).toBe(true);
      expect(ghCalls).toEqual([]);
      // The one read of every thread is at boot, for the watches a restart finds.
      expect(monitorReads.lists).toBe(1);

      yield* hosted("run_monitor").run({ run: "99", repo: "acme/web" });
      state = runJson(99, "completed", "success");
      const told = yield* eventually(
        "the run's message",
        Effect.sync(() => sentTo(fake, thread.id).find((text) => text.includes("#99"))),
      );
      expect(told).toContain("completed: success.");
      // The watch gone, the loop waits again, its polls having read only the thread watching.
      yield* eventually("the loop idle again", quiet);
      expect(monitorReads.lists).toBe(1);
      gh.answer = () => ok;
    }).pipe(Effect.scoped, Effect.provide(RunLoopTestLayer)),
  );
});
