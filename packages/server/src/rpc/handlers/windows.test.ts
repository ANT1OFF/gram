import { describe, expect, it } from "@effect/vitest";
import type { ThreadId, WindowPlacements } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { AppActivity, type WindowActivity } from "../../git/activity.ts";
import { makeWindowPlacements } from "./windows.ts";

const waitUntil = (check: () => boolean) =>
  Effect.gen(function* () {
    for (let i = 0; i < 500 && !check(); i++) yield* Effect.yieldNow;
    expect(check()).toBe(true);
  });

const ids = (placements: WindowPlacements | undefined) =>
  placements?.windows.map((w) => w.windowId).toSorted() ?? [];

describe("makeWindowPlacements", () => {
  it.effect("knows a window while its watch is open, with the threads it reports", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const placements = yield* makeWindowPlacements;
        const seen: WindowPlacements[] = [];
        yield* placements.watch("w1", "Main").pipe(
          Stream.runForEach((p) => Effect.sync(() => seen.push(p))),
          Effect.forkScoped,
        );
        yield* waitUntil(() => ids(seen.at(-1)).join() === "w1");

        const second = yield* placements
          .watch("w2", "Window 2")
          .pipe(Stream.runDrain, Effect.forkScoped);
        yield* waitUntil(() => ids(seen.at(-1)).join() === "w1,w2");

        yield* placements.report("w2", ["t1" as ThreadId]);
        yield* waitUntil(
          () => seen.at(-1)?.windows.find((w) => w.windowId === "w2")?.threadIds[0] === "t1",
        );
        expect(seen.at(-1)?.windows.find((w) => w.windowId === "w2")?.name).toBe("Window 2");

        yield* Fiber.interrupt(second);
        yield* waitUntil(() => ids(seen.at(-1)).join() === "w1");
      }),
    ),
  );

  it.effect("keeps a window whose newer watch replaced an older one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const placements = yield* makeWindowPlacements;
        const seen: WindowPlacements[] = [];
        yield* placements.watch("observer", "Main").pipe(
          Stream.runForEach((p) => Effect.sync(() => seen.push(p))),
          Effect.forkScoped,
        );
        const old = yield* placements
          .watch("w2", "Window 2")
          .pipe(Stream.runDrain, Effect.forkScoped);
        yield* waitUntil(() => ids(seen.at(-1)).includes("w2"));
        yield* placements.report("w2", ["t1" as ThreadId]);
        // The reconnect's watch has registered once it has emitted its first snapshot.
        const renewed: WindowPlacements[] = [];
        yield* placements.watch("w2", "Window 2").pipe(
          Stream.runForEach((p) => Effect.sync(() => renewed.push(p))),
          Effect.forkScoped,
        );
        yield* waitUntil(() => renewed.length > 0);
        yield* Fiber.interrupt(old);
        yield* waitUntil(() => ids(seen.at(-1)).includes("w2"));
        expect(seen.at(-1)?.windows.find((w) => w.windowId === "w2")?.threadIds).toEqual(["t1"]);
      }),
    ),
  );

  it.effect("tells AppActivity whether each window is on screen and in use", () => {
    const seen: Array<ReadonlyArray<WindowActivity>> = [];
    const activity = {
      setWindows: (windows: ReadonlyArray<WindowActivity>) =>
        Effect.sync(() => void seen.push(windows)),
    } as unknown as AppActivity["Service"];
    return Effect.scoped(
      Effect.gen(function* () {
        const placements = yield* makeWindowPlacements;
        yield* placements.watch("w1", "Main").pipe(Stream.runDrain, Effect.forkScoped);
        // A window that hasn't said is assumed to be in front of the user.
        yield* waitUntil(() => seen.length > 0);
        expect(seen.at(-1)).toEqual([{ visible: true, focused: true }]);

        yield* placements.report("w1", [], { visible: true, focused: false });
        expect(seen.at(-1)).toEqual([{ visible: true, focused: false }]);
        yield* placements.report("w1", [], { visible: false, focused: false });
        expect(seen.at(-1)).toEqual([{ visible: false, focused: false }]);

        // A report that leaves presence out, as an older renderer's does, keeps what was known.
        yield* placements.report("w1", ["t1" as ThreadId], { sidebarCollapsed: true });
        expect(seen.at(-1)).toEqual([{ visible: false, focused: false }]);
      }),
    ).pipe(Effect.provideService(AppActivity, activity));
  });

  it.effect("ignores reports from a window that isn't watching", () =>
    Effect.gen(function* () {
      const placements = yield* makeWindowPlacements;
      yield* placements.report("w9", ["t1" as ThreadId]);
      const first = yield* placements.watch("w1", "Main").pipe(Stream.take(1), Stream.runCollect);
      expect(ids([...first][0])).toEqual(["w1"]);
    }),
  );
});
