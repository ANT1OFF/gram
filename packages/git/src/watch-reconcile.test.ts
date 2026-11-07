import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vitest";
import { Proc } from "./proc.ts";
import { RECONCILE_MS, watchGitState, type GitStateChange } from "./watch.ts";

const model = vi.hoisted(() => ({
  head: "initial",
  changedFiles: 0,
  delay: 0,
  reads: 0,
  interrupted: 0,
  release: vi.fn(),
}));

// A successful native subscription which delivers no events: FSEvents has no readiness fence,
// and can delay/drop the only event for a write or commit. No Git, provider or host config is used.
vi.mock("@parcel/watcher", () => ({
  default: {
    subscribe: async () => ({ unsubscribe: async () => model.release() }),
  },
}));
vi.mock("./exec.ts", async () => {
  const fx = await import("effect/Effect");
  return {
    tryRepoRoots: () => fx.succeed({ top: "/repo", common: "/repo/.git", gitDir: "/repo/.git" }),
  };
});
vi.mock("./git-state.ts", async () => {
  const fx = await import("effect/Effect");
  return {
    localGitState: () =>
      fx
        .gen(function* () {
          model.reads++;
          if (model.delay) yield* fx.sleep(model.delay);
          return {
            repo: true,
            worktree: false,
            head: model.head,
            changesToken: `${model.head}:${model.changedFiles}`,
            changedFiles: model.changedFiles,
            behindBase: 0,
            aheadBase: 0,
            conflicts: false,
          };
        })
        .pipe(fx.onInterrupt(() => fx.sync(() => model.interrupted++))),
  };
});

const provide = Effect.provide(
  Layer.succeed(Proc, { run: () => Effect.die("unexpected subprocess") }),
);
const start = Effect.gen(function* () {
  const changes = yield* Queue.unbounded<GitStateChange>();
  const fiber = yield* watchGitState(["/repo"], { backend: "parcel" }).pipe(
    Stream.runForEach((change) => Queue.offer(changes, change)),
    Effect.forkScoped,
  );
  expect((yield* Queue.take(changes)).state).toMatchObject({ head: "initial", changedFiles: 0 });
  return { changes, fiber };
});
const latest = (changes: Queue.Queue<GitStateChange>) =>
  Queue.poll(changes).pipe(Effect.map(Option.getOrUndefined));

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(() => Object.defineProperty(process, "platform", { value: "darwin" }));
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  model.head = "initial";
  model.changedFiles = 0;
  model.delay = 0;
  model.reads = 0;
  model.interrupted = 0;
  model.release.mockClear();
});

describe("macOS watcher reconciliation", () => {
  it.effect(
    "reports edits and commits without native events, deduplicates, and stops with its scope",
    () =>
      Effect.gen(function* () {
        const { changes, fiber } = yield* start;
        model.changedFiles = 1;
        yield* TestClock.adjust(RECONCILE_MS);
        expect((yield* latest(changes))?.state).toMatchObject({ head: "initial", changedFiles: 1 });
        model.head = "committed";
        model.changedFiles = 0;
        yield* TestClock.adjust(RECONCILE_MS);
        expect((yield* latest(changes))?.state).toMatchObject({
          head: "committed",
          changedFiles: 0,
        });
        yield* TestClock.adjust(RECONCILE_MS);
        expect(yield* latest(changes)).toBeUndefined();
        expect(model.reads).toBe(4);
        yield* Fiber.interrupt(fiber);
        expect(model.release).toHaveBeenCalledTimes(2);
        yield* TestClock.adjust(3 * RECONCILE_MS);
        expect(model.reads).toBe(4);
      }).pipe(Effect.scoped, provide),
  );

  it.effect("keeps other platforms driven by native events", () =>
    Effect.gen(function* () {
      Object.defineProperty(process, "platform", { value: "linux" });
      const { changes } = yield* start;
      model.head = "committed";
      yield* TestClock.adjust(3 * RECONCILE_MS);
      expect(yield* latest(changes)).toBeUndefined();
      expect(model.reads).toBe(1);
    }).pipe(Effect.scoped, provide),
  );

  it.effect("lets a read slower than the reconciliation interval finish", () =>
    Effect.gen(function* () {
      const { changes } = yield* start;
      model.head = "committed";
      model.delay = 2 * RECONCILE_MS;
      yield* TestClock.adjust(3 * RECONCILE_MS);
      expect((yield* latest(changes))?.state.head).toBe("committed");
      expect(model.interrupted).toBe(0);
    }).pipe(Effect.scoped, provide),
  );
});
