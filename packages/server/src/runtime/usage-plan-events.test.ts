import { describe, expect, it } from "@effect/vitest";
import type { ServerEvent } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { EventHub } from "../events/event-hub.ts";
import { FakeAgentControl } from "./fake-agent.ts";
import { RuntimeTestLayer, waitFor } from "./test-harness.ts";
import { ThreadRuntimes } from "./thread-runtimes.ts";

describe("ThreadRuntimes usage and plan events", () => {
  it.effect(
    "publishes thread.usage and thread.plan and keeps the latest usage in the snapshot",
    () =>
      Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const hub = yield* EventHub;
        const fake = yield* FakeAgentControl;
        const events: Array<ServerEvent> = [];
        yield* Effect.forkScoped(
          Stream.runForEach(
            hub.serverEvents(
              Effect.succeed<ServerEvent>({ type: "threads.snapshot", threads: [] }),
            ),
            (e) => Effect.sync(() => void events.push(e)),
          ),
        );
        yield* waitFor(
          "the subscription",
          Effect.sync(() => events.length > 0),
        );

        const thread = yield* runtimes.create({
          projectRoot: "/work/repo",
          checkout: { kind: "main", path: "/work/repo" },
          input: { text: "one" },
        });
        const session = yield* waitFor(
          "the first send",
          fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
        );
        const usage = {
          tokens: { inputTokens: 120, outputTokens: 30 },
          contextWindow: 200_000,
          contextTokens: 150,
        };
        const items = [{ content: "write tests", status: "completed" as const }];
        yield* session.emit({ type: "usage", ...usage }, { type: "plan", items });
        yield* waitFor(
          "the plan event",
          Effect.sync(() => events.some((e) => e.type === "thread.plan")),
        );

        expect(events).toContainEqual({ type: "thread.usage", threadId: thread.id, usage });
        expect(events).toContainEqual({ type: "thread.plan", threadId: thread.id, items });
        const [summary] = yield* runtimes.snapshot;
        expect(summary?.usage).toEqual(usage);
        expect(summary?.turnPlan).toEqual(items);

        // The agent's goal becomes the thread plan's, and a plan outlives the session.
        yield* session.emit({ type: "goal", objective: "Deterministic retry test" });
        yield* waitFor(
          "the goal",
          Effect.sync(() => events.some((e) => e.type === "thread.plan" && e.plan !== undefined)),
        );
        expect(events.at(-1)).toMatchObject({
          type: "thread.plan",
          items,
          plan: { goal: "Deterministic retry test", goalBy: "agent", steps: [] },
        });
        yield* session.emit({ type: "ended", reason: "exit" });
        const [ended] = yield* runtimes.snapshot;
        expect(ended).toMatchObject({
          turnPlan: items,
          plan: { goal: "Deterministic retry test" },
        });

        yield* session.emit({ type: "goal" });
        yield* waitFor(
          "the cleared goal",
          runtimes.snapshot.pipe(Effect.map(([s]) => s?.plan === undefined)),
        );
      }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("keeps the session's cost through a later turn's reports that carry none", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      const usageOf = runtimes.snapshot.pipe(Effect.map(([summary]) => summary?.usage));

      const thread = yield* runtimes.create({
        projectRoot: "/work/repo",
        checkout: { kind: "main", path: "/work/repo" },
        input: { text: "one" },
      });
      const session = yield* waitFor(
        "the first send",
        fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
      );
      yield* session.emit(
        { type: "usage", tokens: { inputTokens: 10, outputTokens: 2 }, costUsd: 0.25 },
        { type: "turnEnd", reason: "completed" },
      );
      yield* waitFor("the first turn's cost", usageOf.pipe(Effect.map((u) => u?.costUsd === 0.25)));

      yield* runtimes.send(thread.id, { text: "two" });
      yield* waitFor(
        "the second send",
        fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 2)),
      );
      const running = { inputTokens: 4, outputTokens: 1 };
      yield* session.emit({ type: "usage", tokens: running });
      yield* waitFor(
        "the mid-turn report",
        usageOf.pipe(Effect.map((u) => u?.tokens.inputTokens === 4)),
      );
      expect(yield* usageOf).toEqual({ tokens: running, costUsd: 0.25 });

      yield* session.emit({ type: "usage", tokens: running, costUsd: 0.4 });
      yield* waitFor("the second turn's cost", usageOf.pipe(Effect.map((u) => u?.costUsd === 0.4)));
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );
});
