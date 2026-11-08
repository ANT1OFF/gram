import type { AgentEvent } from "@gram/contracts";
import { describe, expect, it } from "@effect/vitest";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { sequenceEvents } from "./event-log.ts";

const status = (detail: string): AgentEvent => ({ type: "status", status: "running", detail });
const details = (events: ReadonlyArray<{ readonly seq: number; readonly event: AgentEvent }>) =>
  events.map(({ seq, event }) => [seq, event.type === "status" ? event.detail : event.type]);

describe("sequenceEvents", () => {
  it.effect("numbers events from 1 in the order the session emitted them", () =>
    Effect.gen(function* () {
      const log = yield* sequenceEvents(Stream.make(status("a"), status("b"), status("c")));
      const all = yield* Stream.runCollect(log.subscribe());
      expect(details(all)).toEqual([
        [1, "a"],
        [2, "b"],
        [3, "c"],
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("a new subscriber resumes after the last confirmed event, unconfirmed ones again", () =>
    Effect.gen(function* () {
      const log = yield* sequenceEvents(Stream.make(status("a"), status("b"), status("c")));
      const first = yield* Stream.runCollect(log.subscribe().pipe(Stream.take(2)));
      expect(details(first)).toEqual([
        [1, "a"],
        [2, "b"],
      ]);
      // Only the first was handled before the consumer stopped.
      yield* log.ack(1);
      expect(yield* log.acked).toBe(1);
      expect(details(yield* Stream.runCollect(log.subscribe()))).toEqual([
        [2, "b"],
        [3, "c"],
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("subscribes from a given seq, and an older ack changes nothing", () =>
    Effect.gen(function* () {
      const log = yield* sequenceEvents(Stream.make(status("a"), status("b"), status("c")));
      yield* Stream.runCollect(log.subscribe());
      yield* log.ack(2);
      yield* log.ack(1);
      expect(yield* log.acked).toBe(2);
      // A cursor behind what was confirmed starts at the oldest event kept.
      expect(details(yield* Stream.runCollect(log.subscribe(0)))).toEqual([[3, "c"]]);
      expect(details(yield* Stream.runCollect(log.subscribe(3)))).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("an ack confirms only events the log has read", () =>
    Effect.gen(function* () {
      const log = yield* sequenceEvents(Stream.make(status("a")));
      yield* Stream.runCollect(log.subscribe());
      yield* log.ack(99);
      expect(yield* log.acked).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("delivers live events as they come, and ends when the session's events end", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<AgentEvent, Cause.Done>();
      const log = yield* sequenceEvents(Stream.fromQueue(queue));
      const reader = yield* Stream.runCollect(log.subscribe()).pipe(Effect.forkScoped);
      yield* Queue.offer(queue, status("a"));
      yield* Queue.offer(queue, status("b"));
      yield* Queue.end(queue);
      expect(details(yield* Fiber.join(reader))).toEqual([
        [1, "a"],
        [2, "b"],
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("reads the session only as fast as a subscriber asks", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<AgentEvent, Cause.Done>();
      const log = yield* sequenceEvents(Stream.fromQueue(queue));
      yield* Queue.offerAll(queue, [status("a"), status("b")]);
      yield* Effect.yieldNow;
      // Nothing subscribed, so nothing was read.
      expect(yield* Queue.size(queue)).toBe(2);
      expect(details(yield* Stream.runCollect(log.subscribe().pipe(Stream.take(1))))).toEqual([
        [1, "a"],
      ]);
      yield* Queue.end(queue);
      expect(details(yield* Stream.runCollect(log.subscribe()))).toEqual([
        [1, "a"],
        [2, "b"],
      ]);
    }).pipe(Effect.scoped),
  );
});
