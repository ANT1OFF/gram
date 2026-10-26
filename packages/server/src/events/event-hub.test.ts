import { describe, expect, it } from "@effect/vitest";
import type { MessageId, ServerEvent, ThreadId } from "@gram/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { BACKLOG_LOG_FLOOR, type Coalescing, makeCoalescingQueue } from "./backlog.ts";
import { EventHub, isThreadRemoved, type ThreadFeedItem } from "./event-hub.ts";

const T1 = "t1" as ThreadId;
const T2 = "t2" as ThreadId;
const M = "m1" as MessageId;

const chunk = (threadId: ThreadId, seq: number): ThreadFeedItem => ({
  threadId,
  seq,
  event: {
    type: "chunk",
    messageId: M,
    chunk: { type: "text-delta", id: "t", delta: String(seq) },
  },
});

const user = { id: "u2", role: "user", parts: [{ type: "text", text: "next" }] } as never;

describe("EventHub.threadFeed", () => {
  it.effect("replays stored messages and the in-flight buffer, then goes live", () =>
    Effect.gen(function* () {
      const hub = yield* EventHub;
      const stored = { id: "u1", role: "user", parts: [] } as never;
      const replay = Effect.gen(function* () {
        // Published after the subscription but while the replay is being read: seq 1 is already in
        // the replayed buffer (a duplicate), seq 2 and 3 are new, and another thread's item is noise.
        yield* hub.publishFeed(chunk(T1, 1));
        yield* hub.publishFeed(chunk(T2, 7));
        yield* hub.publishFeed(chunk(T1, 2));
        yield* hub.publishFeed({
          threadId: T1,
          seq: 3,
          event: { type: "message", message: user, rev: 5 },
        });
        return { messages: [stored], inFlight: [chunk(T1, 1)], lastSeq: 1, rev: 4 };
      });

      const events = yield* hub.threadFeed(T1, replay).pipe(Stream.take(5), Stream.runCollect);
      expect(events).toEqual([
        { type: "messages", messages: [stored] },
        chunk(T1, 1).event,
        { type: "caughtUp", rev: 4 },
        chunk(T1, 2).event,
        { type: "message", message: user, rev: 5 },
      ]);
    }).pipe(Effect.provide(EventHub.layer)),
  );
});

describe("EventHub.serverEvents", () => {
  it.effect("keeps events published while the snapshot is built", () =>
    Effect.gen(function* () {
      const hub = yield* EventHub;
      const status: ServerEvent = { type: "thread.status", threadId: T1, status: "running" };
      const snapshot = hub
        .publish(status)
        .pipe(Effect.as<ServerEvent>({ type: "threads.snapshot", threads: [] }));
      const events = yield* hub.serverEvents(snapshot).pipe(Stream.take(2), Stream.runCollect);
      expect(events).toEqual([{ type: "threads.snapshot", threads: [] }, status]);
    }).pipe(Effect.provide(EventHub.layer)),
  );
});

/** Pulls until an item matches, returning everything pulled. */
const pullUntil = <A, E>(pull: Effect.Effect<ReadonlyArray<A>, E>, done: (item: A) => boolean) =>
  Effect.gen(function* () {
    const pulled: Array<A> = [];
    while (!pulled.some(done)) pulled.push(...(yield* pull));
    return pulled;
  });

const SNAPSHOT: ServerEvent = { type: "threads.snapshot", threads: [] };

describe("EventHub per-client buffers", () => {
  const SmallHub = EventHub.layerWith({ serverEventCapacity: 5, feedCapacity: 5 });

  it.live(
    "resync a stalled events client from a fresh snapshot instead of queueing the backlog",
    () =>
      Effect.gen(function* () {
        const hub = yield* EventHub;
        let snapshots = 0;
        const snapshot = Effect.sync((): ServerEvent => {
          snapshots++;
          return { type: "threads.snapshot", threads: [] };
        });
        const pull = yield* Stream.toPull(hub.serverEvents(snapshot));
        expect(yield* pullUntil(pull, (e) => e.type === "threads.snapshot")).toHaveLength(1);

        // The client stalls while 200 events arrive; the drain fiber keeps the backlog bounded.
        for (let i = 0; i < 200; i++) {
          yield* hub.publish({ type: "notify", kind: "info", title: String(i) });
        }
        yield* Effect.sleep("50 millis");
        const caughtUp = yield* pullUntil(pull, (e) => e.type === "threads.snapshot");
        expect(snapshots).toBe(2);
        expect(caughtUp.length).toBeLessThan(40);

        yield* hub.publish({ type: "notify", kind: "info", title: "live" });
        const live = yield* pullUntil(pull, (e) => e.type === "notify" && e.title === "live");
        expect(live.at(-1)).toMatchObject({ title: "live" });
      }).pipe(Effect.scoped, Effect.provide(SmallHub)),
  );

  it.live("gives internal subscribers every event they select, past any overflow", () =>
    Effect.gen(function* () {
      const hub = yield* EventHub;
      const removed = yield* hub
        .internalEvents(isThreadRemoved)
        .pipe(Stream.take(4), Stream.runCollect, Effect.forkScoped);
      // Subscribed once the fork has had its turn.
      yield* Effect.yieldNow;
      const ui = yield* Stream.toPull(hub.serverEvents(Effect.succeed(SNAPSHOT)));
      yield* pullUntil(ui, (e) => e.type === "threads.snapshot");
      for (let i = 0; i < 200; i++) {
        if (i % 50 === 0) {
          yield* hub.publish({ type: "thread.removed", threadId: `t${i}` as ThreadId });
        }
        yield* hub.publish({ type: "notify", kind: "info", title: String(i) });
      }
      yield* Effect.sleep("50 millis");
      // The stalled UI client overflowed and is handed a snapshot in place of the removals.
      const caughtUp = yield* pullUntil(ui, (e) => e.type === "threads.snapshot");
      expect(caughtUp.map((e) => e.type)).not.toContain("thread.removed");
      const ids = (yield* Fiber.join(removed)).map((e) => e.threadId);
      expect(ids).toEqual(["t0", "t50", "t100", "t150"]);
    }).pipe(Effect.scoped, Effect.provide(SmallHub)),
  );

  it.live("resumes with `resumed`, and resyncs a stalled client in full", () =>
    Effect.gen(function* () {
      const hub = yield* EventHub;
      const changed = { id: "a1", role: "assistant", parts: [] } as never;
      let seq = 0;
      const resume = Effect.succeed({
        messages: [changed],
        resumed: true,
        inFlight: [],
        lastSeq: 0,
        rev: 9,
      });
      const full = Effect.sync(() => ({
        messages: [user, changed],
        inFlight: [],
        lastSeq: seq,
        rev: 12,
      }));
      const pull = yield* Stream.toPull(hub.threadFeed(T1, resume, full));
      expect(yield* pullUntil(pull, (e) => e.type === "caughtUp")).toEqual([
        { type: "resumed", messages: [changed] },
        { type: "caughtUp", rev: 9 },
      ]);

      for (let i = 0; i < 200; i++) yield* hub.publishFeed(chunk(T1, ++seq));
      yield* Effect.sleep("50 millis");
      const resynced = yield* pullUntil(pull, (e) => e.type === "caughtUp");
      expect(resynced.slice(-2)).toEqual([
        { type: "messages", messages: [user, changed] },
        { type: "caughtUp", rev: 12 },
      ]);
    }).pipe(Effect.scoped, Effect.provide(SmallHub)),
  );

  it.live("replays a stalled feed client afresh, ending with caughtUp", () =>
    Effect.gen(function* () {
      const hub = yield* EventHub;
      let replays = 0;
      let seq = 0;
      const replay = Effect.sync(() => {
        replays++;
        return { messages: [], inFlight: [], lastSeq: seq, rev: 0 };
      });
      const pull = yield* Stream.toPull(hub.threadFeed(T1, replay));
      yield* pullUntil(pull, (e) => e.type === "caughtUp");

      for (let i = 0; i < 200; i++) yield* hub.publishFeed(chunk(T1, ++seq));
      yield* Effect.sleep("50 millis");
      const resynced = yield* pullUntil(pull, (e) => e.type === "caughtUp");
      expect(replays).toBe(2);
      expect(resynced.slice(-2)).toEqual([
        { type: "messages", messages: [] },
        { type: "caughtUp", rev: 0 },
      ]);
      expect(resynced.length).toBeLessThan(40);

      yield* hub.publishFeed(chunk(T1, ++seq));
      const live = yield* pullUntil(pull, (e) => e.type === "chunk");
      expect(live).toEqual([chunk(T1, seq).event]);
    }).pipe(Effect.scoped, Effect.provide(SmallHub)),
  );
});

const captureLogs = () => {
  const logged: Array<Record<string, unknown>> = [];
  const logger = Logger.make(({ message, logLevel, fiber }) => {
    logged.push({ message, logLevel, ...fiber.getRef(References.CurrentLogAnnotations) });
  });
  return { logged, layer: Logger.layer([logger]) };
};

describe("internal backlogs", () => {
  it.live("logs a stalled internal subscriber's depth at each doubling, and its drain", () => {
    const { logged, layer } = captureLogs();
    return Effect.gen(function* () {
      const hub = yield* EventHub;
      const stalled = yield* Deferred.make<void>();
      const seen: Array<ThreadId> = [];
      yield* hub.internalEvents(isThreadRemoved, "cleanup").pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => seen.push(event.threadId)).pipe(
            Effect.andThen(Deferred.await(stalled)),
          ),
        ),
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      yield* hub.publish({ type: "thread.removed", threadId: "first" as ThreadId });
      yield* Effect.sleep("10 millis");
      expect(seen).toEqual(["first"]);
      const burst = BACKLOG_LOG_FLOOR * 2 + 100;
      for (let i = 0; i < burst; i++) {
        yield* hub.publish({ type: "thread.removed", threadId: `t${i}` as ThreadId });
      }
      const growing = { message: ["internal backlog growing"], logLevel: "Warn", queue: "cleanup" };
      expect(logged).toEqual([
        { ...growing, depth: 1_000, highWater: 1_000 },
        { ...growing, depth: 2_000, highWater: 2_000 },
      ]);

      // The drain is logged as the consumer catches up, with nothing more published.
      yield* Deferred.succeed(stalled, undefined);
      while (seen.length <= burst) yield* Effect.sleep("1 millis");
      expect(seen.at(-1)).toBe(`t${burst - 1}`);
      expect(logged.slice(2)).toEqual([
        {
          message: ["internal backlog drained"],
          logLevel: "Info",
          queue: "cleanup",
          depth: BACKLOG_LOG_FLOOR / 2 - 1,
          highWater: burst,
        },
      ]);
    }).pipe(Effect.scoped, Effect.provide(Layer.provideMerge(EventHub.layer, layer)));
  });

  type Item = { readonly kind: "upsert" | "removed"; readonly id: string; readonly v: number };
  const byId: Coalescing<Item> = {
    subjectOf: (item) => item.id,
    replaceableAs: (item) => (item.kind === "upsert" ? item.kind : undefined),
  };

  it.effect("keeps one waiting upsert per subject, and every removal, in order", () => {
    const { logged, layer } = captureLogs();
    return Effect.gen(function* () {
      const queue = yield* makeCoalescingQueue("items", byId, 4);
      for (let v = 0; v < 1_000; v++) {
        yield* queue.offer({ kind: "upsert", id: "a", v });
        yield* queue.offer({ kind: "upsert", id: "b", v });
      }
      expect(queue.depth()).toBe(2);
      yield* TestClock.adjust("30 millis");
      yield* queue.offer({ kind: "removed", id: "a", v: 0 });
      // After its removal, a's upsert queues behind it rather than joining the one before.
      yield* queue.offer({ kind: "upsert", id: "a", v: 2_000 });
      yield* queue.offer({ kind: "upsert", id: "b", v: 2_000 });
      yield* queue.offer({ kind: "removed", id: "b", v: 0 });
      yield* queue.offer({ kind: "removed", id: "a", v: 1 });
      expect(queue.depth()).toBe(6);

      const taken: Array<Item> = [];
      for (let i = 0; i < 6; i++) taken.push(yield* queue.take);
      expect(taken).toEqual([
        { kind: "upsert", id: "a", v: 999 },
        { kind: "upsert", id: "b", v: 2_000 },
        { kind: "removed", id: "a", v: 0 },
        { kind: "upsert", id: "a", v: 2_000 },
        { kind: "removed", id: "b", v: 0 },
        { kind: "removed", id: "a", v: 1 },
      ]);
      expect(queue.depth()).toBe(0);
      expect(queue.gauge.highWater).toBe(6);
      expect(logged).toEqual([
        {
          message: ["internal backlog growing"],
          logLevel: "Warn",
          queue: "items",
          depth: 4,
          highWater: 4,
          oldestAgeMs: 30,
        },
        {
          message: ["internal backlog drained"],
          logLevel: "Info",
          queue: "items",
          depth: 1,
          highWater: 6,
        },
      ]);

      // A taken upsert no longer absorbs later ones: the next is queued afresh.
      yield* queue.offer({ kind: "upsert", id: "a", v: 3_000 });
      expect(yield* queue.take).toEqual({ kind: "upsert", id: "a", v: 3_000 });
    }).pipe(Effect.provide(layer));
  });
});
