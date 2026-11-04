import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vitest";
import { FakeAgentControl } from "./fake-agent.ts";
import { RuntimeTestLayer, waitFor } from "./test-harness.ts";
import { ThreadRuntimes } from "./thread-runtimes.ts";
import { TurnActivity } from "./turn-activity.ts";

describe("runtime turn activity", () => {
  it.effect("reports both threads' actual turns through completion and interruption", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const agents = yield* FakeAgentControl;
      const activity = yield* TurnActivity;
      const started = vi.spyOn(activity, "start");
      const ended = vi.spyOn(activity, "end");
      const threads = yield* Effect.all(
        [0, 1].map(() =>
          runtimes.create({
            projectRoot: "/work/repo",
            checkout: { kind: "main", path: "/work/repo" },
          }),
        ),
      );
      for (const thread of threads) {
        yield* waitFor("idle", runtimes.status(thread.id).pipe(Effect.map((s) => s === "idle")));
        yield* runtimes.send(thread.id, { text: "work" });
      }
      expect(started).toHaveBeenCalledTimes(2);
      expect(ended).not.toHaveBeenCalled();
      const session = yield* agents.latest(threads[0]!.id);
      yield* session.emit(
        { type: "turnEnd", reason: "completed" },
        { type: "status", status: "idle" },
      );
      yield* waitFor(
        "first end",
        Effect.sync(() => ended.mock.calls.length === 1),
      );
      expect(ended.mock.calls[0]).toEqual(started.mock.calls[0]);
      yield* runtimes.interrupt(threads[1]!.id);
      yield* waitFor(
        "last end",
        Effect.sync(() => ended.mock.calls.length === 2),
      );
      expect(ended.mock.calls[1]).toEqual(started.mock.calls[1]);
    }).pipe(Effect.scoped, Effect.provide(RuntimeTestLayer)),
  );
});
