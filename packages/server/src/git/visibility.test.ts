import { describe, expect, it } from "@effect/vitest";
import type { ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Duration from "effect/Duration";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import { EventHub } from "../events/event-hub.ts";
import {
  attentionOf,
  newlyVisible,
  rebaseGated,
  ThreadVisibility,
  type WindowView,
} from "./visibility.ts";

/** Yields until `done` holds, for the hub's subscriber fiber to take what was published. */
const waitUntil = (done: Effect.Effect<boolean>) =>
  Effect.gen(function* () {
    for (let i = 0; i < 100; i++) {
      if (yield* done) return;
      yield* Effect.yieldNow;
    }
    expect(yield* done).toBe(true);
  });

const A = "t-a" as ThreadId;
const B = "t-b" as ThreadId;
const view = (sidebarCollapsed: boolean, ...threadIds: ThreadId[]): WindowView => ({
  threadIds,
  sidebarCollapsed,
});

describe("rebaseGated", () => {
  it("gates a thread only when every sidebar is collapsed and no pane shows it", () => {
    expect(rebaseGated([], A)).toBe(false);
    expect(rebaseGated([view(false)], A)).toBe(false);
    expect(rebaseGated([view(true)], A)).toBe(true);
    expect(rebaseGated([view(true, A)], A)).toBe(false);
    expect(rebaseGated([view(true, B), view(true)], A)).toBe(true);
    expect(rebaseGated([view(true, B), view(false)], A)).toBe(false);
    expect(rebaseGated([view(true), view(true, A)], A)).toBe(false);
  });
});

describe("newlyVisible", () => {
  it("reveals every thread on an expand, and newly shown panes while collapsed", () => {
    expect(newlyVisible([view(true)], [view(false)])).toBe("all");
    expect(newlyVisible([view(true, A)], [view(true, A, B)])).toEqual([B]);
    expect(newlyVisible([view(false, A)], [view(true, A)])).toEqual([]);
    expect(newlyVisible([view(false)], [view(true, A, B)])).toEqual([]);
    expect(newlyVisible([view(false)], [view(false, A)])).toEqual([]);
    expect(newlyVisible([view(true, A)], [view(true)])).toEqual([]);
    expect(newlyVisible([], [view(true)])).toEqual([]);
  });
});

describe("ThreadVisibility", () => {
  it.effect("tracks the latest views and streams what they reveal", () =>
    Effect.gen(function* () {
      const visibility = yield* ThreadVisibility;
      const reveals = yield* visibility.revealed.pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;

      yield* visibility.update([view(true)]);
      expect(yield* visibility.rebaseGated(A)).toBe(true);
      yield* visibility.update([view(true, A)]);
      expect(yield* visibility.rebaseGated(A)).toBe(false);
      yield* visibility.update([view(false, A)]);
      expect(yield* visibility.rebaseGated(B)).toBe(false);

      expect([...(yield* Fiber.join(reveals))]).toEqual([[A], "all"]);
    }).pipe(Effect.scoped, Effect.provide(ThreadVisibility.layer)),
  );
});

/** A window the user is in, showing `threadIds` with `focusedThreadId` in its focused pane. */
const inFront = (focusedThreadId: ThreadId, ...threadIds: ThreadId[]): WindowView => ({
  threadIds,
  sidebarCollapsed: false,
  focusedThreadId,
});

describe("attentionOf", () => {
  it("ranks the focused pane over a shown pane over a sidebar row", () => {
    const windows = [inFront(A, A, B)];
    expect(attentionOf(windows, A)).toBe("focused");
    expect(attentionOf(windows, B)).toBe("shown");
    expect(attentionOf(windows, "t-c" as ThreadId)).toBe("listed");
  });

  it("takes the focused pane of a window nobody is in to be merely shown", () => {
    expect(attentionOf([{ ...inFront(A, A), focused: false }], A)).toBe("shown");
    expect(attentionOf([{ ...inFront(A, A), visible: false }], A)).toBe("listed");
  });

  it("hides what no chip shows, and lists everything when no window is known", () => {
    expect(attentionOf([view(true, B)], A)).toBe("hidden");
    expect(attentionOf([], A)).toBe("listed");
  });
});

describe("ThreadVisibility focus", () => {
  it.effect("announces each thread the user moves into, once", () =>
    Effect.gen(function* () {
      const visibility = yield* ThreadVisibility;
      const moves = yield* visibility.focusChanges.pipe(
        Stream.take(3),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      yield* visibility.update([inFront(A, A, B)]);
      // The same thread again, with something else about the window changed: not a move.
      yield* visibility.update([{ ...inFront(A, A, B), sidebarCollapsed: true }]);
      yield* visibility.update([inFront(B, A, B)]);
      // Coming back to the window is a move into whatever it shows.
      yield* visibility.update([{ ...inFront(B, A, B), focused: false }]);
      yield* visibility.update([inFront(B, A, B)]);
      expect([...(yield* Fiber.join(moves))]).toEqual([A, B, B]);
    }).pipe(Effect.scoped, Effect.provide(ThreadVisibility.layer)),
  );

  it.effect("remembers when the user was last in a thread", () =>
    Effect.gen(function* () {
      const visibility = yield* ThreadVisibility;
      expect(yield* visibility.lastFocusedAt(A)).toBeUndefined();
      yield* TestClock.adjust(Duration.seconds(100));
      yield* visibility.update([inFront(A, A, B)]);
      yield* TestClock.adjust(Duration.seconds(50));
      // Still in it: now.
      expect(yield* visibility.lastFocusedAt(A)).toBe(150_000);
      yield* visibility.update([inFront(B, A, B)]);
      yield* TestClock.adjust(Duration.seconds(500));
      expect(yield* visibility.lastFocusedAt(A)).toBe(150_000);
      expect(yield* visibility.lastFocusedAt(B)).toBe(650_000);
    }).pipe(Effect.provide(ThreadVisibility.layer)),
  );

  it.effect("forgets when the user left a thread once the thread is removed", () =>
    Effect.gen(function* () {
      const visibility = yield* ThreadVisibility;
      const hub = yield* EventHub;
      yield* visibility.update([inFront(A, A, B)]);
      yield* visibility.update([inFront(B, A, B)]);
      expect(yield* visibility.lastFocusedAt(A)).toBe(0);
      // The layer's subscriber is a fiber of its own; let it subscribe first.
      for (let i = 0; i < 5; i++) yield* Effect.yieldNow;
      yield* hub.publish({ type: "thread.removed", threadId: A });
      yield* waitUntil(visibility.lastFocusedAt(A).pipe(Effect.map((at) => at === undefined)));
      expect(yield* visibility.lastFocusedAt(B)).toBe(0);
    }).pipe(
      Effect.scoped,
      Effect.provide(ThreadVisibility.layer.pipe(Layer.provideMerge(EventHub.layer))),
    ),
  );

  it.effect("keeps a removed thread forgotten when a late window update leaves it", () =>
    Effect.gen(function* () {
      const visibility = yield* ThreadVisibility;
      const hub = yield* EventHub;
      const leaves = yield* visibility.focusLeaves.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );
      for (let i = 0; i < 5; i++) yield* Effect.yieldNow;
      yield* visibility.update([inFront(A, A, B)]);
      // Removed while its window still has it in front, and the window hasn't said otherwise yet.
      yield* hub.publish({ type: "thread.removed", threadId: A });
      for (let i = 0; i < 5; i++) yield* Effect.yieldNow;
      yield* visibility.update([inFront(B, B)]);
      expect(yield* visibility.lastFocusedAt(A)).toBeUndefined();
      // Nor does it come back into focus, or announce a move out of it.
      yield* visibility.update([inFront(A, A, B)]);
      yield* visibility.update([inFront(B, A, B)]);
      expect(yield* visibility.lastFocusedAt(A)).toBeUndefined();
      expect(yield* visibility.lastFocusedAt(B)).toBe(0);
      yield* visibility.update([inFront(A, A, B)]);
      expect([...(yield* Fiber.join(leaves))]).toEqual([{ threadId: B, at: 0 }]);
    }).pipe(
      Effect.scoped,
      Effect.provide(ThreadVisibility.layer.pipe(Layer.provideMerge(EventHub.layer))),
    ),
  );

  it.effect("announces each thread the user moves out of, with when", () =>
    Effect.gen(function* () {
      const visibility = yield* ThreadVisibility;
      const leaves = yield* visibility.focusLeaves.pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      yield* visibility.update([inFront(A, A, B)]);
      yield* TestClock.adjust(Duration.seconds(10));
      yield* visibility.update([inFront(B, A, B)]);
      yield* TestClock.adjust(Duration.seconds(5));
      // A window going to the back leaves its thread too.
      yield* visibility.update([{ ...inFront(B, A, B), focused: false }]);
      expect([...(yield* Fiber.join(leaves))]).toEqual([
        { threadId: A, at: 10_000 },
        { threadId: B, at: 15_000 },
      ]);
    }).pipe(Effect.scoped, Effect.provide(ThreadVisibility.layer)),
  );
});
