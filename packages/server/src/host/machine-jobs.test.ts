// A machine's long steps as jobs (`machine-jobs.ts`): each outlives the call that started it, is
// followed by polls shorter than the step, runs once however often it is asked for, and ends by
// itself at its budget.

import { describe, expect, it } from "@effect/vitest";
import { HostFailed, type HostId, HostUnavailable, type ThreadId } from "@gram/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { makeMachineJobs } from "./machine-jobs.ts";

const MACHINE = "m-1" as HostId;
const T1 = "t-1" as ThreadId;

describe("a machine's long step as a job", () => {
  it.effect("goes on after the call that started it is gone, and ends with its answer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const jobs = yield* makeMachineJobs();
        const release = yield* Deferred.make<void>();
        let ran = 0;
        // The caller starts it, waits a moment and gives up, as one whose deadline is short.
        const caller = yield* Effect.forkScoped(
          Effect.gen(function* () {
            const { job } = yield* jobs.start({
              kind: "resume",
              machine: MACHINE,
              budgetMs: 60_000,
              run: () =>
                Effect.sync(() => (ran += 1)).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.as({ reopened: [T1] }),
                ),
            });
            yield* Effect.never;
            return job;
          }),
        );
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(caller);
        const started = yield* jobs.start({
          kind: "resume",
          machine: MACHINE,
          budgetMs: 60_000,
          run: () => Effect.die("not run again"),
        });
        // Still running though its caller went: a second ask joins it.
        expect(started.joined).toBe(true);
        expect(started.job.state).toBe("running");
        yield* Deferred.succeed(release, undefined);
        const ended = yield* jobs.ended(started.job.id);
        expect(ended).toMatchObject({ state: "done", result: { reopened: [T1] } });
        expect(ran).toBe(1);
      }),
    ),
  );

  it.effect("is polled until done, each poll answering at the next change", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const jobs = yield* makeMachineJobs();
        const next = yield* Deferred.make<void>();
        const { job } = yield* jobs.start({
          kind: "resume",
          machine: MACHINE,
          budgetMs: 60_000,
          run: (report) =>
            Effect.gen(function* () {
              yield* report.folders([
                { threadId: T1, cwd: "/a" },
                { threadId: T1, cwd: "/b" },
              ]);
              yield* report.folder(T1, "/a", "restored");
              yield* Deferred.await(next);
              yield* report.folder(T1, "/b", "refused", "git fetch failed");
              return "resumed";
            }),
        });
        yield* Effect.yieldNow;
        let seen = jobs.get(job.id)!;
        expect(seen.state).toBe("running");
        expect(seen.progress).toEqual({ done: 1, total: 2 });
        // Waits for the next change rather than answering what was seen.
        const poll = yield* Effect.forkScoped(
          jobs.watch(job.id, { seen: seen.version, waitMs: 20_000 }),
        );
        yield* Effect.yieldNow;
        expect(poll.pollUnsafe()).toBeUndefined();
        yield* Deferred.succeed(next, undefined);
        const changed = yield* Fiber.join(poll);
        expect(changed!.version).toBeGreaterThan(seen.version);
        while (seen.state !== "done") {
          seen = (yield* jobs.watch(job.id, { seen: seen.version, waitMs: 20_000 }))!;
        }
        expect(seen.result).toBe("resumed");
        expect(seen.folders).toEqual([
          { threadId: T1, cwd: "/a", state: "restored" },
          { threadId: T1, cwd: "/b", state: "refused", note: "git fetch failed" },
        ]);
        // A poll that waits gives up at its own wait, never later.
        const blocked = yield* jobs.start({
          kind: "prepare",
          machine: MACHINE,
          budgetMs: 600_000,
          run: () => Effect.never,
        });
        const waited = yield* Effect.forkScoped(
          jobs.watch(blocked.job.id, { seen: 99, waitMs: 5_000 }),
        );
        yield* TestClock.adjust("5 seconds");
        expect((yield* Fiber.join(waited))!.state).toBe("running");
        expect(yield* jobs.watch("job_unknown")).toBeUndefined();
      }),
    ),
  );

  it.effect("runs once however often it is asked for, by key or while it runs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const jobs = yield* makeMachineJobs();
        let ran = 0;
        const release = yield* Deferred.make<void>();
        const spec = (key?: string) => ({
          kind: "resume" as const,
          machine: MACHINE,
          key,
          budgetMs: 60_000,
          run: () => Effect.sync(() => (ran += 1)).pipe(Effect.andThen(Deferred.await(release))),
        });
        const first = yield* jobs.start(spec("wake-1"));
        const again = yield* jobs.start(spec("wake-1"));
        const other = yield* jobs.start(spec("wake-2"));
        const none = yield* jobs.start(spec());
        expect([again.joined, other.joined, none.joined]).toEqual([true, true, true]);
        expect(new Set([first, again, other, none].map(({ job }) => job.id)).size).toBe(1);
        yield* Deferred.succeed(release, undefined);
        yield* jobs.ended(first.job.id);
        // Ended, and asked for by its key: its answer, not a second run.
        const after = yield* jobs.start(spec("wake-1"));
        expect(after).toMatchObject({ joined: true, job: { id: first.job.id, state: "done" } });
        expect(ran).toBe(1);
        // A new key once it has ended is a new run.
        const fresh = yield* jobs.start(spec("wake-3"));
        expect(fresh.joined).toBe(false);
        yield* jobs.ended(fresh.job.id);
        expect(ran).toBe(2);
      }),
    ),
  );

  it.effect("waits queued behind the machine's other job, and its budget starts as it runs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const jobs = yield* makeMachineJobs();
        const release = yield* Deferred.make<void>();
        const resume = yield* jobs.start({
          kind: "resume",
          machine: MACHINE,
          budgetMs: 60 * 60_000,
          run: () => Deferred.await(release),
        });
        const prepare = yield* jobs.start({
          kind: "prepare",
          machine: MACHINE,
          budgetMs: 60_000,
          run: () => Effect.succeed({ idle: true }),
        });
        yield* Effect.yieldNow;
        expect(jobs.get(prepare.job.id)!.state).toBe("queued");
        // Longer than its budget while queued: it doesn't count.
        yield* TestClock.adjust("5 minutes");
        expect(jobs.get(prepare.job.id)!.state).toBe("queued");
        yield* Deferred.succeed(release, undefined);
        expect(yield* jobs.ended(prepare.job.id)).toMatchObject({
          state: "done",
          result: { idle: true },
        });
        expect(jobs.get(resume.job.id)!.state).toBe("done");
      }),
    ),
  );

  it.effect("fails by itself once it goes its budget without progress, its step cut off", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const jobs = yield* makeMachineJobs();
        let cutOff = false;
        const { job } = yield* jobs.start({
          kind: "resume",
          machine: MACHINE,
          budgetMs: 20 * 60_000,
          run: (report) =>
            Effect.gen(function* () {
              yield* report.folders([
                { threadId: T1, cwd: "/a" },
                { threadId: T1, cwd: "/b" },
              ]);
              yield* Effect.sleep("15 minutes");
              // Progress: the budget runs again from here.
              yield* report.folder(T1, "/a", "restored");
              return yield* Effect.never;
            }).pipe(Effect.onInterrupt(() => Effect.sync(() => (cutOff = true)))),
        });
        yield* TestClock.adjust("30 minutes");
        expect(jobs.get(job.id)!.state).toBe("running");
        yield* TestClock.adjust("6 minutes");
        expect(yield* jobs.ended(job.id)).toMatchObject({
          state: "failed",
          error: { status: 502, message: "It made no progress for 20 minutes, so it was cut off." },
        });
        expect(cutOff).toBe(true);
        // A machine away is a conflict, as its synchronous route answers.
        const away = yield* jobs.start({
          kind: "prepare",
          machine: MACHINE,
          budgetMs: 60_000,
          run: () => Effect.fail(new HostUnavailable({ hostId: MACHINE, message: "away" })),
        });
        expect(yield* jobs.ended(away.job.id)).toMatchObject({
          state: "failed",
          error: { status: 409, message: "away" },
        });
        const refused = yield* jobs.start({
          kind: "prepare",
          machine: MACHINE,
          budgetMs: 60_000,
          run: () => Effect.fail(new HostFailed({ message: "refused" })),
        });
        expect(yield* jobs.ended(refused.job.id)).toMatchObject({
          state: "failed",
          error: { status: 502, message: "refused" },
        });
      }),
    ),
  );
});
