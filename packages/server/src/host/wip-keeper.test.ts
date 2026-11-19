// When the keeper keeps a thread's work on a joined machine: after each turn, even when the next
// turn starts before that keep is due; while a long turn runs; never cutting a keep off; and what
// the thread then says of its last save.

import { describe, expect, it } from "@effect/vitest";
import type { HostId, HostStopKept, SavedDiff, Thread, ThreadId, TurnId } from "@gram/contracts";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import type { RuntimeObserver } from "../runtime/runtime-observer.ts";
import { cloneIdentityOf } from "./repos.ts";
import { makeStopMarks } from "./stop-marks.ts";
import type { KeepRequest } from "./stop.ts";
import { startWipKeeper, type WipKeeperDeps } from "./wip-keeper.ts";

const MACHINE = "m-1" as HostId;
const TURN = "turn-1" as TurnId;
const COMMIT = "a".repeat(40);
const SAVED: SavedDiff = { files: [], uncommitted: true };
const THREAD = {
  id: "t-worker" as ThreadId,
  checkout: {
    kind: "worktree",
    hostId: MACHINE,
    path: "/clones/widgets-trees/worker",
    branch: "gram/worker",
    cloneIdentity: cloneIdentityOf("https://git.example.test/acme/widgets.git")!,
  },
} as unknown as Thread;

/** A keeper over a machine whose keeps take `takes` and answer `answer`, counted. */
const keeper = (
  options: {
    readonly takes?: Duration.Input;
    readonly answer?: (request: KeepRequest) => ReadonlyArray<HostStopKept>;
  } = {},
) =>
  Effect.gen(function* () {
    let observer: RuntimeObserver = {};
    let thread = THREAD;
    const calls = { started: 0, finished: 0 };
    const answer =
      options.answer ??
      ((request: KeepRequest) =>
        request.checkouts.map((checkout) => ({
          ...checkout,
          ref: `refs/gram/wip/${checkout.threadId}`,
          commit: COMMIT,
          pushed: true,
          saved: SAVED,
        })));
    const keep = (request: KeepRequest) =>
      Effect.gen(function* () {
        calls.started += 1;
        if (options.takes !== undefined) yield* Effect.sleep(options.takes);
        calls.finished += 1;
        return answer(request);
      });
    const deps = {
      hosts: {
        connection: () => Effect.succeed({ stop: { keep } }),
        stops: makeStopMarks(),
      },
      store: {
        getSettings: Effect.succeed({ experimental: { embedding: true } }),
        getThread: () => Effect.sync(() => thread),
      },
      runtimes: {
        observe: (watching: RuntimeObserver) => Effect.sync(() => void (observer = watching)),
        updateThread: (_id: ThreadId, change: (current: Thread) => Thread) =>
          Effect.sync(() => (thread = change(thread))),
      },
    } as unknown as WipKeeperDeps;
    yield* startWipKeeper(deps);
    const end = { turnId: TURN, reason: "completed", synthesized: false, queueEmpty: true };
    return {
      calls,
      saved: () => thread.savedWork,
      start: observer.onTurnStart!(THREAD, TURN),
      end: observer.onTurnEnd!(THREAD, end as never),
    };
  });

describe("keeping a thread's work in progress", () => {
  it.effect("keeps after each of a run of short turns that follow each other closely", () =>
    Effect.gen(function* () {
      const { calls, start, end } = yield* keeper();
      // Turns of four minutes, each starting a second after the last ended.
      for (let turn = 1; turn <= 6; turn++) {
        yield* start;
        yield* TestClock.adjust("4 minutes");
        yield* end;
        yield* TestClock.adjust("1 second");
      }
      // Each turn's keep came 5 s after it ended, inside the next turn.
      yield* TestClock.adjust("5 seconds");
      expect(calls.finished).toBe(6);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps a long turn's work every few minutes, counted from the last keep", () =>
    Effect.gen(function* () {
      const { calls, start } = yield* keeper();
      yield* start;
      yield* TestClock.adjust("4 minutes");
      expect(calls.finished).toBe(0);
      yield* TestClock.adjust("1 minute");
      expect(calls.finished).toBe(1);
      yield* TestClock.adjust("10 minutes");
      expect(calls.finished).toBe(3);
    }).pipe(Effect.scoped),
  );

  it.effect("never cuts off a keep under way when the next turn starts", () =>
    Effect.gen(function* () {
      const { calls, start, end } = yield* keeper({ takes: "30 seconds" });
      yield* start;
      yield* end;
      yield* TestClock.adjust("10 seconds");
      expect(calls.started).toBe(1);
      // The next turn starts and ends while it pushes.
      yield* start;
      yield* end;
      yield* TestClock.adjust("25 seconds");
      expect(calls.finished).toBe(1);
      // The turn that ended meanwhile is kept once the first keep is done.
      yield* TestClock.adjust("1 minute");
      expect(calls).toEqual({ started: 2, finished: 2 });
    }).pipe(Effect.scoped),
  );

  it.effect("marks a save as out of date when a later keep fails, until one succeeds", () =>
    Effect.gen(function* () {
      let fail = false;
      const { saved, start, end } = yield* keeper({
        answer: (request) =>
          request.checkouts.map((checkout) =>
            fail
              ? { ...checkout, pushed: false, note: "git push failed: refused" }
              : {
                  ...checkout,
                  ref: `refs/gram/wip/${checkout.threadId}`,
                  commit: COMMIT,
                  pushed: true,
                  saved: SAVED,
                },
          ),
      });
      yield* start;
      yield* end;
      yield* TestClock.adjust("5 seconds");
      const first = saved();
      expect(first?.lastFailure).toBeUndefined();
      fail = true;
      yield* start;
      yield* TestClock.adjust("1 minute");
      yield* end;
      yield* TestClock.adjust("5 seconds");
      expect(saved()).toMatchObject({
        at: first?.at,
        lastAttemptAt: first!.at + 65_000,
        lastFailure: "git push failed: refused",
      });
      fail = false;
      yield* start;
      yield* end;
      yield* TestClock.adjust("5 seconds");
      expect(saved()?.lastFailure).toBeUndefined();
      expect(saved()?.at).toBe(first!.at + 70_000);
    }).pipe(Effect.scoped),
  );
});
