// Condition wakes (`schedule_wake` with `condition`): a branch's new head and another thread
// finishing, for a plain thread's own wakes and a workspace's, once each, debounced, over a restart,
// on their fallback time and under the per-thread cap.
import { describe, expect, it } from "@effect/vitest";
import { type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { hasGit } from "../git/test-repo.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { WakeConditions } from "../wakes/conditions.ts";
import { ThreadWakes } from "../wakes/thread-wakes.ts";
import {
  completeTurn,
  makeWorld,
  openOrchestrator,
  openProject,
  outboxOf,
  settle,
  spawn,
  stopSilently,
  waitReal,
  waitSent,
  type World,
  withServer,
} from "./test-harness.ts";
import { inServer, sessionsOf } from "./service-kit.ts";

/** A plain thread at rest, with the session its wakes are sent to. */
const openPlain = (world: World, title: string) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    const thread = yield* runtimes.create({
      projectRoot: world.repo,
      checkout: { kind: "main", path: world.repo },
      title,
      input: { text: "hello" },
    });
    const session = yield* waitSent(thread.id, 1);
    yield* completeTurn(session);
    return { thread, session };
  });

describe.skipIf(!hasGit)("condition wakes", () => {
  it.effect(
    "a branch's new head fires a wake once, after its debounce, with the head it settled on",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const conditions = yield* WakeConditions;
          const wakes = yield* ThreadWakes;
          yield* openProject(world);
          const { thread, session } = yield* openPlain(world, "Stacked");
          world.defaultBranches.set("acme/app", "main");
          world.branchHeads.set("acme/app#main", "aaa1");
          world.branchHeads.set("acme/app#nope", null);

          const noBranch = yield* session
            .callTool("schedule_wake", {
              condition: { kind: "branchMoved", repo: "acme/app", branch: "nope" },
              note: "x",
            })
            .pipe(Effect.flip);
          expect(noBranch.message).toContain("has no branch nope");
          const both = yield* session
            .callTool("schedule_wake", {
              condition: { kind: "branchMoved", repo: "acme/app" },
              onPr: "acme/app#1",
              note: "x",
            })
            .pipe(Effect.flip);
          expect(both.message).toContain("not both");

          // Without a branch, the default one; its head is the baseline.
          const set = yield* session.callTool("schedule_wake", {
            condition: { kind: "branchMoved", repo: "acme/app" },
            note: "rebase onto main",
          });
          expect(set).toMatchObject({
            condition: { kind: "branchMoved", repo: "acme/app", branch: "main" },
            when: "acme/app main gets a new head",
          });
          expect((yield* wakes.list).wakes[0]).toMatchObject({
            condition: { kind: "branchMoved", branch: "main" },
            conditionState: { v: 1, seen: { head: "aaa1" } },
          });

          // Nothing moved: a look keeps waiting.
          yield* conditions.sweep("branchMoved");
          yield* settle;
          expect(session.sent).toHaveLength(1);

          // It moves, and moves again inside the debounce: one wake, naming the later head. (A read
          // answers for the same branch for 20 seconds.)
          yield* TestClock.adjust("21 seconds");
          world.branchHeads.set("acme/app#main", "bbb2");
          yield* conditions.sweep("branchMoved");
          yield* settle;
          expect(session.sent).toHaveLength(1);
          world.branchHeads.set("acme/app#main", "ccc3");
          yield* TestClock.adjust("31 seconds");
          const woken = yield* waitSent(thread.id, 2);
          const text = woken.sent[1]?.text ?? "";
          expect(text).toContain("for when acme/app main gets a new head fired.");
          expect(text).toContain(
            "```wake-event\ncondition: branchMoved\nrepo: acme/app\nbranch: main\nhead: ccc3\nprevious: aaa1\n```",
          );
          expect(text).toContain("Your note: rebase onto main");
          yield* settle;
          expect((yield* wakes.list).wakes).toEqual([]);

          // Gone once fired: a later move wakes nobody.
          world.branchHeads.set("acme/app#main", "ddd4");
          yield* conditions.sweep("branchMoved");
          yield* TestClock.adjust("31 seconds");
          yield* settle;
          expect(woken.sent).toHaveLength(2);
        }),
      ),
  );

  it.effect("a met look that doesn't hold through the debounce doesn't fire", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const conditions = yield* WakeConditions;
        yield* openProject(world);
        const { session } = yield* openPlain(world, "Waiting");
        world.branchHeads.set("acme/app#release", "aaa1");
        yield* session.callTool("schedule_wake", {
          condition: { kind: "branchMoved", repo: "acme/app", branch: "release" },
          note: "x",
        });
        world.branchHeads.set("acme/app#release", "bbb2");
        yield* conditions.sweep("branchMoved");
        // Force-pushed back before the debounce's look.
        world.branchHeads.set("acme/app#release", "aaa1");
        yield* TestClock.adjust("21 seconds");
        yield* settle;
        yield* TestClock.adjust("31 seconds");
        yield* settle;
        expect(session.sent).toHaveLength(1);
      }),
    ),
  );

  it.effect(
    "a condition wake outlives a restart, fires on a move made while down, and falls back on its time",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        world.branchHeads.set("acme/app#main", "aaa1");
        const first = yield* withServer(
          world,
          Effect.gen(function* () {
            yield* openProject(world);
            const moved = yield* openPlain(world, "Moved");
            yield* moved.session.callTool("schedule_wake", {
              condition: { kind: "branchMoved", repo: "acme/app", branch: "main" },
              note: "rebase",
            });
            const idle = yield* openPlain(world, "Fallback");
            world.branchHeads.set("acme/app#quiet", "q1");
            yield* idle.session.callTool("schedule_wake", {
              condition: { kind: "branchMoved", repo: "acme/app", branch: "quiet" },
              inMinutes: 30,
              note: "look anyway",
            });
            return { moved: moved.thread.id, idle: idle.thread.id };
          }),
        );
        // Main moves while the app is down.
        world.branchHeads.set("acme/app#main", "bbb2");

        yield* withServer(
          world,
          Effect.gen(function* () {
            const conditions = yield* WakeConditions;
            yield* settle;
            yield* conditions.sweep("branchMoved");
            yield* TestClock.adjust("31 seconds");
            const woken = yield* waitSent(first.moved, 1);
            expect(woken.sent[0]?.text).toContain("head: bbb2\nprevious: aaa1");

            // The quiet branch never moves: its time wakes it, saying so.
            yield* TestClock.adjust("30 minutes");
            const fallback = yield* waitSent(first.idle, 1);
            expect(fallback.sent[0]?.text).toContain(
              "for when acme/app quiet gets a new head is due: that hadn't happened by then. Your note: look anyway",
            );
          }),
        );
      }),
  );

  it.effect("condition wakes count toward the per-thread cap", () =>
    inServer((world) =>
      Effect.gen(function* () {
        yield* openProject(world);
        const { session } = yield* openPlain(world, "Capped");
        world.branchHeads.set("acme/app#main", "aaa1");
        for (let i = 0; i < 5; i++) {
          yield* session.callTool("schedule_wake", {
            condition: { kind: "branchMoved", repo: "acme/app", branch: "main" },
            note: `n${i}`,
          });
        }
        const capped = yield* session
          .callTool("schedule_wake", {
            condition: { kind: "branchMoved", repo: "acme/app", branch: "main" },
            note: "one too many",
          })
          .pipe(Effect.flip);
        expect(capped.message).toContain("5 wakes pending");
      }),
    ),
  );

  it.effect(
    "an orchestrator waits on a worker finishing: at rest after a report, once, in its digest",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const conditions = yield* WakeConditions;
          const { session, workspaceId } = yield* openOrchestrator(world);
          const orchestrator = session.options.threadId;
          const worker = yield* spawn(session, { feature: "research", title: "Research" });

          const self = yield* session
            .callTool("schedule_wake", {
              condition: { kind: "threadFinished", threadId: orchestrator },
              note: "x",
            })
            .pipe(Effect.flip);
          expect(self.message).toContain("can't wait for itself");
          const unknown = yield* session
            .callTool("schedule_wake", {
              condition: { kind: "threadFinished", threadId: "nope" },
              note: "x",
            })
            .pipe(Effect.flip);
          expect(unknown.message).toContain("No thread has the id nope");

          yield* session.callTool("schedule_wake", {
            condition: { kind: "threadFinished", threadId: worker.thread.id },
            note: "read the findings",
          });
          expect((yield* outboxOf(workspaceId)).wakes?.[0]?.conditionState?.spec).toEqual({
            kind: "threadFinished",
            threadId: worker.thread.id,
          });

          // Working, no report: nothing yet.
          yield* conditions.sweep("threadFinished");
          yield* TestClock.adjust("21 seconds");
          yield* settle;
          expect((yield* outboxOf(workspaceId)).wakes?.[0]?.conditionState?.fired).toBeUndefined();

          // A progress report, then at rest: finished, after the debounce.
          yield* worker.session.callTool("report", { state: "progress", summary: "Found three." });
          yield* completeTurn(worker.session);
          yield* conditions.sweep("threadFinished");
          yield* TestClock.adjust("21 seconds");
          yield* settle;
          yield* TestClock.adjust("60 seconds");
          const digest = yield* waitReal(
            "the orchestrator's condition wake in a digest",
            sessionsOf(orchestrator).pipe(
              Effect.map((sessions) =>
                sessions
                  .flatMap((each) => each.sent)
                  .find((input) => input.text.includes("Your note: read the findings")),
              ),
            ),
          );
          expect(digest.text).toContain(
            `fired: thread ${worker.thread.id} finishes (thread ${worker.thread.id}, title Research, outcome at rest after a progress report).`,
          );
          expect((yield* outboxOf(workspaceId)).wakes).toBeUndefined();
        }),
      ),
  );

  it.effect(
    "a worker waits on a sibling reporting done; a plain thread's wait ends on an archive",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const conditions = yield* WakeConditions;
          const runtimes = yield* ThreadRuntimes;
          const { session } = yield* openOrchestrator(world);
          const waiter = yield* spawn(session, { feature: "impl", title: "Impl" });
          const review = yield* spawn(session, { feature: "review", title: "Review" });
          const research = yield* spawn(session, { feature: "research", title: "Research" });
          yield* stopSilently(waiter.session);
          yield* stopSilently(research.session);
          const before = waiter.session.sent.length;
          yield* waiter.session.callTool("schedule_wake", {
            condition: { kind: "threadFinished", threadId: review.thread.id },
            note: "apply the review",
          });
          const plain = yield* openPlain(world, "Watching research");
          yield* plain.session.callTool("schedule_wake", {
            condition: { kind: "threadFinished", threadId: research.thread.id },
            note: "read it",
          });

          // Done fires it.
          yield* review.session.callTool("report", { state: "done", summary: "LGTM." });
          yield* completeTurn(review.session);
          yield* conditions.sweep("threadFinished");
          yield* TestClock.adjust("21 seconds");
          const told = yield* waitSent(waiter.thread.id, before + 1);
          expect(told.sent[before]?.text).toContain("outcome: reported done");
          expect(told.sent[before]?.text).toContain("Your note: apply the review");

          // Archived ends the other.
          yield* runtimes.updateThread(research.thread.id, (t) => ({ ...t, parked: true }));
          yield* conditions.sweep("threadFinished");
          yield* TestClock.adjust("21 seconds");
          const archived = yield* waitSent(plain.thread.id, 2);
          expect(archived.sent[1]?.text).toContain("outcome: archived");

          // Set on one archived already: refused.
          const late = yield* plain.session
            .callTool("schedule_wake", {
              condition: { kind: "threadFinished", threadId: research.thread.id as ThreadId },
              note: "x",
            })
            .pipe(Effect.flip);
          expect(late.message).toContain("archived already");
        }),
      ),
  );
});
