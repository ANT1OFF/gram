// The user's snooze (`thread.snooze`): kept on the thread, timed on the wakes' alarms, back unread
// at its time or sooner when the thread asks something, and armed again after a restart.
import { describe, expect, it } from "@effect/vitest";
import type { RequestId, ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { hasGit } from "../git/test-repo.ts";
import {
  completeTurn,
  makeWorld,
  settle,
  waitReal,
  waitSent,
  withServer,
} from "../orchestration/test-harness.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import type { World } from "../orchestration/test-harness.ts";
import { DAY_MS } from "../zone-time.ts";
import { ThreadWakes } from "./thread-wakes.ts";

/** 23:30 UTC on Friday 6 November 2026: the snoozes below cross midnight into Saturday. */
const FRIDAY_LATE = Date.UTC(2026, 10, 6, 23, 30);
/** 09:00 UTC on Saturday 7 November 2026. */
const SATURDAY_NINE = Date.UTC(2026, 10, 7, 9, 0);

const plainThread = (world: World) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    const thread = yield* runtimes.create({
      projectRoot: world.repo,
      checkout: { kind: "main", path: world.repo },
      title: "Snoozing",
      input: { text: "hello" },
    });
    const session = yield* waitSent(thread.id, 1);
    yield* completeTurn(session);
    // Viewed: nothing is unread before the snooze ends.
    yield* runtimes.updateThread(thread.id, (t) => ({ ...t, unread: false }));
    return { threadId: thread.id, session };
  });

const threadOf = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    return yield* store.getThread(threadId);
  });

describe.skipIf(!hasGit)("thread snooze", () => {
  it.effect("survives a restart and comes back unread at its time, across midnight", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      yield* TestClock.setTime(FRIDAY_LATE);
      const snoozedId = yield* withServer(
        world,
        Effect.gen(function* () {
          const { threadId } = yield* plainThread(world);
          const wakes = yield* ThreadWakes;
          const snoozed = yield* wakes.snooze(threadId, SATURDAY_NINE);
          expect(snoozed.snoozedUntil).toBe(SATURDAY_NINE);
          expect((yield* threadOf(threadId)).snoozedUntil).toBe(SATURDAY_NINE);
          // Past midnight and short of nine, it stays away.
          yield* TestClock.adjust("1 hour");
          yield* settle;
          expect((yield* threadOf(threadId)).snoozedUntil).toBe(SATURDAY_NINE);
          return threadId;
        }),
      );

      // The app is down past nine: the restart brings it back at once.
      yield* TestClock.setTime(SATURDAY_NINE + 5 * 60_000);
      yield* withServer(
        world,
        Effect.gen(function* () {
          const back = yield* waitReal(
            "the snooze to end",
            threadOf(snoozedId).pipe(
              Effect.map((t) => (t.snoozedUntil === undefined ? t : undefined)),
            ),
          );
          expect(back.unread).toBe(true);
        }),
      );
    }),
  );

  it.effect("a restart before its time arms it again, to fire at that time", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      yield* TestClock.setTime(FRIDAY_LATE);
      const snoozedId = yield* withServer(
        world,
        Effect.gen(function* () {
          const { threadId } = yield* plainThread(world);
          yield* (yield* ThreadWakes).snooze(threadId, SATURDAY_NINE);
          return threadId;
        }),
      );
      yield* withServer(
        world,
        Effect.gen(function* () {
          yield* settle;
          yield* TestClock.adjust("9 hours");
          yield* settle;
          expect((yield* threadOf(snoozedId)).snoozedUntil).toBe(SATURDAY_NINE);
          yield* TestClock.adjust("30 minutes");
          const back = yield* waitReal(
            "the snooze to end",
            threadOf(snoozedId).pipe(
              Effect.map((t) => (t.snoozedUntil === undefined ? t : undefined)),
            ),
          );
          expect(back.unread).toBe(true);
        }),
      );
    }),
  );

  it.effect("comes back early when the thread asks something, and Unsnooze ends it", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      yield* TestClock.setTime(FRIDAY_LATE);
      yield* withServer(
        world,
        Effect.gen(function* () {
          const wakes = yield* ThreadWakes;
          const { threadId, session } = yield* plainThread(world);
          yield* wakes.snooze(threadId, SATURDAY_NINE);
          yield* session.emit({
            type: "request",
            request: { kind: "question", id: "req-1" as RequestId, questions: [] },
          });
          const back = yield* waitReal(
            "the question to end the snooze",
            threadOf(threadId).pipe(
              Effect.map((t) => (t.snoozedUntil === undefined ? t : undefined)),
            ),
          );
          expect(back.unread).toBe(true);
          // Its alarm went with it: the old time passing changes nothing.
          const runtimes = yield* ThreadRuntimes;
          yield* runtimes.updateThread(threadId, (t) => ({ ...t, unread: false }));
          yield* TestClock.setTime(SATURDAY_NINE + 60_000);
          yield* settle;
          expect((yield* threadOf(threadId)).unread).toBe(false);

          // Unsnooze: back now, without being marked unread.
          yield* wakes.snooze(threadId, SATURDAY_NINE + 3_600_000);
          const unsnoozed = yield* wakes.snooze(threadId, undefined);
          expect(unsnoozed.snoozedUntil).toBeUndefined();
          yield* TestClock.adjust("2 hours");
          yield* settle;
          const after = yield* threadOf(threadId);
          expect(after.snoozedUntil).toBeUndefined();
          expect(after.unread).toBe(false);
        }),
      );
    }),
  );

  it.effect("refuses a time already past or too far ahead", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      yield* TestClock.setTime(FRIDAY_LATE);
      yield* withServer(
        world,
        Effect.gen(function* () {
          const wakes = yield* ThreadWakes;
          const { threadId } = yield* plainThread(world);
          const past = yield* wakes.snooze(threadId, FRIDAY_LATE - 1).pipe(Effect.flip);
          expect(past.message).toContain("already passed");
          const far = yield* wakes.snooze(threadId, FRIDAY_LATE + 91 * DAY_MS).pipe(Effect.flip);
          expect(far.message).toContain("at most 90 days");
          expect((yield* threadOf(threadId)).snoozedUntil).toBeUndefined();
        }),
      );
    }),
  );
});
