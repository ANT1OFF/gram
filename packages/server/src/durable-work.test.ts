import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { makeDurableWork } from "./durable-work.ts";
import {
  callerPerson,
  currentCaller,
  recordActor,
  RoutedFor,
  type RecordedActor,
} from "./host/ownership.ts";

interface Job {
  readonly id: string;
  readonly owed: boolean;
  /** Who it was saved for (`recordActor`). */
  readonly actor?: RecordedActor;
  readonly result?: string;
}

/** A store of saved intents and a log of what `perform` was asked, for one test. */
const harness = (perform: (job: Job, retry: boolean) => Effect.Effect<string | undefined>) => {
  const saved = new Map<string, Job>();
  const calls: Array<{ readonly id: string; readonly retry: boolean }> = [];
  const work = makeDurableWork<string, Job, string>({
    lockKey: (id) => id,
    read: (id) => Effect.sync(() => saved.get(id)),
    owed: (job) => job.owed,
    actor: (job) => Effect.succeed(job.actor),
    perform: (job, retry) =>
      Effect.suspend(() => {
        calls.push({ id: job.id, retry });
        return perform(job, retry);
      }),
    markDone: (job, result) =>
      Effect.sync(() => {
        const done = { ...job, owed: false, result };
        saved.set(job.id, done);
        return done;
      }),
  });
  const save = (id: string, actor?: RecordedActor) =>
    saved.set(id, { id, owed: true, ...(actor === undefined ? {} : { actor }) });
  return { work, saved, calls, save };
};

it.effect("performs saved work once and marks it done only when it says so", () =>
  Effect.gen(function* () {
    let fail = true;
    const { work, saved, calls, save } = harness(() => Effect.succeed(fail ? undefined : "sent"));
    save("a");
    // A failed attempt leaves the intent owed.
    expect(yield* work.attempt("a", false)).toEqual({ id: "a", owed: true });
    fail = false;
    expect(yield* work.attempt("a", false)).toEqual({ id: "a", owed: false, result: "sent" });
    // Done work is never done again, and an unknown key does nothing.
    yield* work.attempt("a", true);
    expect(yield* work.attempt("missing", false)).toBeUndefined();
    expect(calls).toEqual([
      { id: "a", retry: false },
      { id: "a", retry: false },
    ]);
    expect(saved.get("a")?.result).toBe("sent");
  }),
);

it.effect("retries what is still saved at start, telling the work it may have happened", () =>
  Effect.gen(function* () {
    const { work, calls, save } = harness((job) =>
      Effect.succeed(job.id === "stuck" ? undefined : "sent"),
    );
    save("a");
    save("stuck");
    save("b");
    const settled: Array<string> = [];
    yield* work.resume(["a", "stuck", "b"], (job) => Effect.sync(() => void settled.push(job.id)));
    expect(calls.map((call) => call.retry)).toEqual([true, true, true]);
    // `settled` hears only what the attempt finished.
    expect(settled).toEqual(["a", "b"]);
  }),
);

it.effect("runs one attempt per key at a time, so a retry never repeats the one it races", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const { work, calls, save } = harness(() =>
      Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.as("sent"),
      ),
    );
    save("a");
    const first = yield* work.attempt("a", false).pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    const second = yield* work.attempt("a", true).pipe(Effect.forkScoped);
    yield* Effect.yieldNow;
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(first);
    expect((yield* Fiber.join(second))?.owed).toBe(false);
    expect(calls).toHaveLength(1);
  }).pipe(Effect.scoped),
);

// The durable-intent choke point (`host/ownership.ts`): an attempt runs as who the work was saved
// for, whichever fiber makes it. A retry at start, with no caller, is never the server's own.
it.effect("runs every attempt as the actor the intent was saved with, a retry included", () =>
  Effect.gen(function* () {
    const seen: Array<string | undefined | "server"> = [];
    const { work, save } = harness(() =>
      Effect.gen(function* () {
        seen.push((yield* currentCaller) === undefined ? "server" : yield* callerPerson);
        return "done";
      }),
    );
    // Saved in Ada's call, attempted in Grace's, and resumed at start with no caller at all.
    save("ada-job", yield* recordActor.pipe(Effect.provideService(RoutedFor, { person: "ada" })));
    yield* work
      .attempt("ada-job", false)
      .pipe(Effect.provideService(RoutedFor, { person: "grace" }));
    save("ada-retry", { person: "ada" });
    save("unsigned", {});
    save("server", yield* recordActor);
    yield* work.resume(["ada-retry", "unsigned", "server"]);
    expect(seen).toEqual(["ada", "ada", undefined, "server"]);
  }),
);
