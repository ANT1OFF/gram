// Which threads someone can see a PR badge or sync chip for, so a sweep can skip the rebase tier of
// threads nobody is looking at. Windows report the threads their panes show and whether their sidebar
// is collapsed to the strip.

import type { ThreadId } from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { EventHub, isThreadRemoved } from "../events/event-hub.ts";
import type { Attention } from "./poll-cadence.ts";

export interface WindowView {
  readonly threadIds: ReadonlyArray<ThreadId>;
  readonly sidebarCollapsed: boolean;
  /** On screen rather than minimised or hidden; assumed so when not said. */
  readonly visible?: boolean;
  /** Has the user's attention; assumed so when not said. */
  readonly focused?: boolean;
  /** The thread in the window's focused pane. */
  readonly focusedThreadId?: ThreadId;
}

/** Threads whose chips can be seen again: every thread when a sidebar expands. */
export type Revealed = "all" | ReadonlyArray<ThreadId>;

const allCollapsed = (windows: ReadonlyArray<WindowView>) =>
  windows.length > 0 && windows.every((w) => w.sidebarCollapsed);

/**
 * Every window's sidebar is collapsed and no pane shows the thread, so none of its git chips is on
 * screen. With no window registered (headless, tests) nothing is gated.
 */
export const rebaseGated = (windows: ReadonlyArray<WindowView>, threadId: ThreadId): boolean =>
  allCollapsed(windows) && windows.every((w) => !w.threadIds.includes(threadId));

/** What became visible between two views: all threads on an expand, else newly shown panes. */
export const newlyVisible = (
  before: ReadonlyArray<WindowView>,
  after: ReadonlyArray<WindowView>,
): Revealed => {
  if (!allCollapsed(after)) return allCollapsed(before) ? "all" : [];
  // An expanded sidebar showed every thread's chips already.
  if (!allCollapsed(before)) return [];
  const shown = new Set(before.flatMap((w) => w.threadIds));
  return [...new Set(after.flatMap((w) => w.threadIds))].filter((id) => !shown.has(id));
};

/** The threads the user is in: the focused pane of each window that has their attention. */
const focusedThreads = (windows: ReadonlyArray<WindowView>): ReadonlySet<ThreadId> =>
  new Set(
    windows.flatMap((w) =>
      w.visible !== false && w.focused !== false && w.focusedThreadId !== undefined
        ? [w.focusedThreadId]
        : [],
    ),
  );

/**
 * How closely `threadId` is being looked at. With no window registered (headless, tests) every
 * thread counts as listed, as nothing is gated then either.
 */
export const attentionOf = (windows: ReadonlyArray<WindowView>, threadId: ThreadId): Attention => {
  if (focusedThreads(windows).has(threadId)) return "focused";
  const onScreen = windows.filter((w) => w.visible !== false);
  if (onScreen.some((w) => w.threadIds.includes(threadId))) return "shown";
  if (windows.length === 0 || onScreen.some((w) => !w.sidebarCollapsed)) return "listed";
  // A window that is off screen still counts as showing its chips when it is all there is: whether
  // anyone is looking at the app at all is `AppActivity`'s to say, and it slows every sweep.
  return rebaseGated(windows, threadId) ? "hidden" : "listed";
};

export class ThreadVisibility extends Context.Service<
  ThreadVisibility,
  {
    /** Every registered window's view, after any window changes. */
    readonly update: (windows: ReadonlyArray<WindowView>) => Effect.Effect<void>;
    readonly rebaseGated: (threadId: ThreadId) => Effect.Effect<boolean>;
    /** Threads to refresh now, because their chips just came on screen. */
    readonly revealed: Stream.Stream<Revealed>;
    readonly attention: (threadId: ThreadId) => Effect.Effect<Attention>;
    /** Epoch ms the user was last in the thread; now, while they still are. */
    readonly lastFocusedAt: (threadId: ThreadId) => Effect.Effect<number | undefined>;
    /** Each thread the user moves into: a click, a pane switch, a window coming to the front. */
    readonly focusChanges: Stream.Stream<ThreadId>;
    /** Each thread the user moves out of, with when: the other side of `focusChanges`. */
    readonly focusLeaves: Stream.Stream<{ readonly threadId: ThreadId; readonly at: number }>;
  }
>()("@gram/server/ThreadVisibility") {
  static readonly layer = Layer.effect(
    ThreadVisibility,
    Effect.gen(function* () {
      let windows: ReadonlyArray<WindowView> = [];
      const reveals = yield* PubSub.unbounded<Revealed>();
      const focuses = yield* PubSub.unbounded<ThreadId>();
      const leaves = yield* PubSub.unbounded<{
        readonly threadId: ThreadId;
        readonly at: number;
      }>();
      const leftAt = new Map<ThreadId, number>();
      // A removed thread is never focused again: what it was left at goes with it, and a window
      // that still reports it, not having heard yet, can't bring it back. Ids are never reused.
      const removed = new Set<ThreadId>();
      const hub = yield* Effect.serviceOption(EventHub);
      if (Option.isSome(hub)) {
        yield* hub.value.internalEvents(isThreadRemoved, "thread visibility").pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              removed.add(event.threadId);
              leftAt.delete(event.threadId);
            }),
          ),
          Effect.forkScoped,
        );
      }
      const focusedLive = (views: ReadonlyArray<WindowView>) =>
        new Set([...focusedThreads(views)].filter((id) => !removed.has(id)));
      return {
        update: (next) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const revealed = newlyVisible(windows, next);
            const before = focusedLive(windows);
            const after = focusedLive(next);
            windows = next;
            for (const id of before) {
              if (after.has(id)) continue;
              leftAt.set(id, now);
              yield* PubSub.publish(leaves, { threadId: id, at: now });
            }
            if (revealed === "all" || revealed.length > 0) yield* PubSub.publish(reveals, revealed);
            for (const id of after) if (!before.has(id)) yield* PubSub.publish(focuses, id);
          }),
        rebaseGated: (threadId) => Effect.sync(() => rebaseGated(windows, threadId)),
        revealed: Stream.fromPubSub(reveals),
        attention: (threadId) => Effect.sync(() => attentionOf(windows, threadId)),
        lastFocusedAt: (threadId) =>
          Effect.map(Clock.currentTimeMillis, (now) =>
            focusedLive(windows).has(threadId) ? now : leftAt.get(threadId),
          ),
        focusChanges: Stream.fromPubSub(focuses),
        focusLeaves: Stream.fromPubSub(leaves),
      };
    }),
  );
}
