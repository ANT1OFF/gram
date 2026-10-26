import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import type { MessageId } from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { ThreadStore } from "../persistence/thread-store.ts";
import { SqlClient } from "../platform/unstable.ts";
import { searchThreads } from "../search/search.ts";
import { FakeAgentControl } from "./fake-agent.ts";
import { SEARCH_REFRESH_RETRY_MS } from "./feed-writer.ts";
import { makeRuntimeTestLayer, RuntimeTestLayer, waitFor } from "./test-harness.ts";
import { ThreadRuntimes } from "./thread-runtimes.ts";

/**
 * Feed saves also measure their cost with performance.now(): a slow save spaces later saves out.
 * These tests exercise search refreshes after a save, so drive that clock with TestClock too.
 * Otherwise host load can suppress the second save before the search timer is even armed.
 */
const withSaveClock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Clock.clockWith((clock) =>
      Effect.sync(() =>
        vi
          .spyOn(performance, "now")
          .mockImplementation(() => Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000),
      ),
    ),
    () => effect,
    (spy) => Effect.sync(() => spy.mockRestore()),
  );

/** The reply's stored row as search sees it: still marked, and what the index itself matches. */
const searchState = (messageId: string, word: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{ pending: number | null }>`SELECT search_pending AS pending
      FROM messages WHERE id = ${messageId}`;
    const hits = yield* sql`SELECT rowid FROM message_search WHERE message_search MATCH ${word}`;
    return { marked: row !== undefined && row.pending !== null, indexed: hits.length > 0 };
  });

const startTurn = Effect.gen(function* () {
  const runtimes = yield* ThreadRuntimes;
  const fake = yield* FakeAgentControl;
  const thread = yield* runtimes.create({
    projectRoot: "/work/repo",
    checkout: { kind: "main", path: "/work/repo" },
  });
  yield* waitFor("idle", runtimes.status(thread.id).pipe(Effect.map((s) => s === "idle")));
  yield* runtimes.send(thread.id, { text: "go" });
  const session = yield* waitFor(
    "the send",
    fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
  );
  return { thread, session };
});

const messageId = "streaming-reply" as MessageId;

/** Two text parts of one reply, each completed, so each is saved. */
const twoParts = (first: string, second: string) =>
  [
    { type: "chunk", messageId, chunk: { type: "start", messageId } },
    { type: "chunk", messageId, chunk: { type: "text-start", id: "a" } },
    { type: "chunk", messageId, chunk: { type: "text-delta", id: "a", delta: first } },
    { type: "chunk", messageId, chunk: { type: "text-end", id: "a" } },
    { type: "chunk", messageId, chunk: { type: "text-start", id: "b" } },
    { type: "chunk", messageId, chunk: { type: "text-delta", id: "b", delta: second } },
    { type: "chunk", messageId, chunk: { type: "text-end", id: "b" } },
  ] as const;

describe("search indexing of a streaming reply", () => {
  it.effect("indexes the first save, skips saves inside the refresh interval, and the finish", () =>
    Effect.gen(function* () {
      const { session } = yield* startTurn;
      yield* session.emit(...twoParts("flamegraph", "allocator"));
      yield* waitFor(
        "the second save",
        searchState(messageId, "allocator").pipe(Effect.map((s) => s.marked)),
      );
      // The second save came well inside `SEARCH_REFRESH_MS` of the first.
      expect(yield* searchState(messageId, "flamegraph")).toEqual({ marked: true, indexed: true });
      expect(yield* searchState(messageId, "allocator")).toEqual({ marked: true, indexed: false });

      yield* session.emit({ type: "chunk", messageId, chunk: { type: "finish" } });
      yield* waitFor(
        "the settled save",
        searchState(messageId, "allocator").pipe(Effect.map((s) => !s.marked)),
      );
      expect(yield* searchState(messageId, "allocator")).toEqual({ marked: false, indexed: true });
    }).pipe(Effect.provide(RuntimeTestLayer), withSaveClock),
  );

  it.effect("refreshes a reply that stops saving mid-stream within the refresh interval", () =>
    Effect.gen(function* () {
      const { session } = yield* startTurn;
      yield* session.emit(...twoParts("kernel", "scheduler"));
      yield* waitFor(
        "the second save",
        searchState(messageId, "scheduler").pipe(Effect.map((s) => s.marked)),
      );
      // Then nothing more: a long tool call, or a stalled stream.
      yield* TestClock.adjust("4 seconds");
      expect(yield* searchState(messageId, "scheduler")).toEqual({ marked: true, indexed: false });
      yield* TestClock.adjust("1 second");
      yield* waitFor(
        "the timed refresh",
        searchState(messageId, "scheduler").pipe(Effect.map((s) => !s.marked)),
      );
      expect(yield* searchState(messageId, "scheduler")).toEqual({ marked: false, indexed: true });
    }).pipe(Effect.provide(RuntimeTestLayer), withSaveClock),
  );

  it.effect.each([4_000, 6_000])(
    "keeps the refresh deadline when a save returns %i ms late",
    (delayMs) =>
      Effect.gen(function* () {
        const saved = yield* Deferred.make<void>();
        const store = ThreadStore.layerSqlite(":memory:").pipe(Layer.orDie);
        const delayedStore = Layer.effect(
          ThreadStore,
          Effect.map(Effect.service(ThreadStore), (inner) =>
            ThreadStore.of({
              ...inner,
              upsertMessage: (threadId, message, turnId, options) =>
                inner
                  .upsertMessage(threadId, message, turnId, options)
                  .pipe(
                    Effect.flatMap((rev) =>
                      options?.streaming === true
                        ? Deferred.succeed(saved, undefined).pipe(
                            Effect.andThen(Effect.sleep(delayMs)),
                            Effect.as(rev),
                          )
                        : Effect.succeed(rev),
                    ),
                  ),
            }),
          ),
        ).pipe(Layer.provide(store));
        const sqlOf = Layer.effect(SqlClient.SqlClient, Effect.service(SqlClient.SqlClient)).pipe(
          Layer.provide(store),
        );
        yield* Effect.gen(function* () {
          const { session } = yield* startTurn;
          yield* session.emit(...twoParts("kernel", "scheduler"));
          yield* Deferred.await(saved);
          // Returning to the writer consumes part or all of the five-second refresh interval.
          yield* TestClock.adjust(delayMs);
          if (delayMs < 5_000) {
            expect(yield* searchState(messageId, "scheduler")).toEqual({
              marked: true,
              indexed: false,
            });
            yield* TestClock.adjust(5_000 - delayMs);
          }
          yield* waitFor(
            "the refresh at the original deadline",
            searchState(messageId, "scheduler").pipe(Effect.map((s) => !s.marked)),
          );
          expect(yield* searchState(messageId, "scheduler")).toEqual({
            marked: false,
            indexed: true,
          });
        }).pipe(
          Effect.provide(
            makeRuntimeTestLayer(
              undefined,
              undefined,
              undefined,
              undefined,
              Layer.merge(delayedStore, sqlOf),
            ),
          ),
        );
      }).pipe(withSaveClock),
  );

  it.effect("retries a timed refresh that finds the write lock held", () => {
    let refused = 2;
    let tries = 0;
    const store = ThreadStore.layerSqlite(":memory:").pipe(Layer.orDie);
    // The store's own refresh, but answering "the write lock was held" to the first two tries.
    const busyStore = Layer.effect(
      ThreadStore,
      Effect.map(Effect.service(ThreadStore), (inner) =>
        ThreadStore.of({
          ...inner,
          refreshSearch: (threadId, id) =>
            Effect.suspend(() => {
              tries++;
              return refused-- > 0 ? Effect.succeed(false) : inner.refreshSearch(threadId, id);
            }),
        }),
      ),
    ).pipe(Layer.provide(store));
    const sqlOf = Layer.effect(SqlClient.SqlClient, Effect.service(SqlClient.SqlClient)).pipe(
      Layer.provide(store),
    );
    return Effect.gen(function* () {
      const { session } = yield* startTurn;
      yield* session.emit(...twoParts("kernel", "scheduler"));
      yield* waitFor(
        "the second save",
        searchState(messageId, "scheduler").pipe(Effect.map((s) => s.marked)),
      );
      yield* TestClock.adjust("5 seconds");
      yield* waitFor(
        "the first try",
        Effect.sync(() => tries === 1),
      );
      yield* TestClock.adjust(`${SEARCH_REFRESH_RETRY_MS[0]} millis`);
      yield* waitFor(
        "the second try",
        Effect.sync(() => tries === 2),
      );
      expect(yield* searchState(messageId, "scheduler")).toEqual({ marked: true, indexed: false });
      yield* TestClock.adjust(`${SEARCH_REFRESH_RETRY_MS[1]} millis`);
      yield* waitFor(
        "the third try's refresh",
        searchState(messageId, "scheduler").pipe(Effect.map((s) => !s.marked)),
      );
      expect(tries).toBe(3);
      expect(yield* searchState(messageId, "scheduler")).toEqual({ marked: false, indexed: true });
    }).pipe(
      Effect.provide(
        makeRuntimeTestLayer(
          undefined,
          undefined,
          undefined,
          undefined,
          Layer.merge(busyStore, sqlOf),
        ),
      ),
      withSaveClock,
    );
  });

  it.effect("times the refresh interval on elapsed time, not the wall clock", () =>
    Effect.gen(function* () {
      const { session } = yield* startTurn;
      yield* TestClock.setTime(10 * 3_600_000);
      const [start, textStart, firstDelta, firstEnd, ...second] = twoParts("kernel", "scheduler");
      yield* session.emit(start, textStart, firstDelta, firstEnd);
      yield* waitFor(
        "the first save",
        searchState(messageId, "kernel").pipe(Effect.map((s) => s.indexed)),
      );
      // The wall clock goes back an hour, as a time zone or NTP correction can take it.
      yield* TestClock.setTime(9 * 3_600_000);
      yield* session.emit(...second);
      yield* waitFor(
        "the second save",
        searchState(messageId, "scheduler").pipe(Effect.map((s) => s.marked)),
      );
      yield* TestClock.adjust("5 seconds");
      yield* waitFor(
        "the timed refresh",
        searchState(messageId, "scheduler").pipe(Effect.map((s) => !s.marked)),
      );
    }).pipe(Effect.provide(RuntimeTestLayer), withSaveClock),
  );

  it.effect("indexes a reply whose session crashed mid-stream when the turn closes it", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const { thread, session } = yield* startTurn;
      yield* session.emit(...twoParts("buffer", "allocator"));
      yield* waitFor(
        "the second save",
        searchState(messageId, "allocator").pipe(Effect.map((s) => s.marked)),
      );
      yield* session.end({ type: "ended", reason: "exited" });
      yield* waitFor(
        "the turn to end",
        store
          .listTurns(thread.id)
          .pipe(Effect.map((t) => t.length > 0 && t.every((x) => x.endedAt !== undefined))),
      );

      expect((yield* searchThreads({ query: "allocator" })).hits).toEqual([
        expect.objectContaining({ threadId: thread.id, messageId }),
      ]);
    }).pipe(Effect.provide(RuntimeTestLayer), withSaveClock),
  );
});
