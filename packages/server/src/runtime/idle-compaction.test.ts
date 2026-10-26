import { describe, expect, it } from "@effect/vitest";
import type { AgentEvent, MessageId, TurnId, UserInput } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentControl } from "./fake-agent.ts";
import { RuntimeTestLayer, waitFor } from "./test-harness.ts";
import { ThreadRuntimes, type DeliveryRest, type ObservedTurnEnd } from "./thread-runtimes.ts";

// Synthetic: the runtime's fake agent and invented counts; no CLI, provider or login.
const messageId = "m-idle" as MessageId;
const reply = (...chunks: ReadonlyArray<unknown>): ReadonlyArray<AgentEvent> =>
  [
    { type: "chunk", messageId, chunk: { type: "start", messageId } },
    ...chunks.map((chunk) => ({ type: "chunk", messageId, chunk })),
  ] as ReadonlyArray<AgentEvent>;
const usage = {
  type: "usage",
  tokens: { inputTokens: 4, outputTokens: 90, cacheReadTokens: 300_000, cacheWriteTokens: 2_000 },
  contextTokens: 302_004,
  cacheWrites: { fiveMinute: 0, oneHour: 2_000 },
} as AgentEvent;

const start = Effect.gen(function* () {
  const runtimes = yield* ThreadRuntimes;
  const fake = yield* FakeAgentControl;
  const thread = yield* runtimes.create({
    projectRoot: "/work/repo",
    checkout: { kind: "main", path: "/work/repo" },
    input: { text: "one" },
  });
  const session = yield* waitFor(
    "the first send",
    fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
  );
  return { thread, session, runtimes };
});

const idle = (threadId: Parameters<ThreadRuntimes["Service"]["status"]>[0]) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    yield* waitFor("idle", runtimes.status(threadId).pipe(Effect.map((s) => s === "idle")));
  });

const compactionParts = (threadId: Parameters<ThreadRuntimes["Service"]["status"]>[0]) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    return (yield* store.listMessages(threadId))
      .flatMap((m) => m.parts)
      .filter((p) => p.type === "data-compaction")
      .map((p) => (p as { data: unknown }).data);
  });

/** Sends `/compact` as idle compaction's delivery would, and returns the turn's end. */
const idleCompaction = (
  agent: (session: Effect.Success<typeof start>["session"]) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const { thread, session, runtimes } = yield* start;
    yield* session.completeTurn();
    yield* idle(thread.id);
    const ends: Array<ObservedTurnEnd> = [];
    yield* runtimes.observe({ onTurnEnd: (_t, end) => Effect.sync(() => void ends.push(end)) });
    const rests: Array<DeliveryRest> = [];
    const input: UserInput = {
      text: "/compact",
      notice: { kind: "idleCompact", contextTokens: 302_004 },
    };
    yield* runtimes.requestSystemDelivery(thread.id, "idle-compact", {
      build: (_turnId: TurnId, rest) => Effect.sync(() => (rests.push(rest), input)),
      accepted: () => Effect.void,
      failed: () => Effect.void,
    });
    yield* waitFor(
      "the compact send",
      Effect.sync(() => session.sent.length === 2),
    );
    expect(session.sent[1]).toMatchObject({ text: "/compact" });
    yield* agent(session);
    yield* idle(thread.id);
    yield* waitFor(
      "the end",
      Effect.sync(() => ends.length === 1),
    );
    return { end: ends[0]!, rests, parts: yield* compactionParts(thread.id) };
  }).pipe(Effect.scoped);

describe("idle compaction in the runtime", () => {
  it.effect("saves the turn's TTL split and when its last main input reached the agent", () =>
    Effect.gen(function* () {
      const { thread, session } = yield* start;
      const store = yield* ThreadStore;
      const opened = (yield* store.listTurns(thread.id))[0]!.startedAt;
      yield* TestClock.adjust("3 minutes");
      yield* session.emit(
        ...reply(
          { type: "tool-input-available", toolCallId: "c1", toolName: "Read", input: {} },
          { type: "tool-output-available", toolCallId: "c1", output: "" },
        ),
        usage,
      );
      // The final answer streams later; its request started after the tool result.
      yield* TestClock.adjust("2 minutes");
      yield* session.completeTurn();
      yield* idle(thread.id);
      const saved = yield* store.lastTurnUsage(thread.id);
      expect(saved).toMatchObject({
        contextTokens: 302_004,
        cacheWrites: { fiveMinute: 0, oneHour: 2_000 },
        lastRequestAt: opened + 3 * 60_000,
      });
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("anchors a turn with no tool result at its start", () =>
    Effect.gen(function* () {
      const { thread, session } = yield* start;
      const store = yield* ThreadStore;
      const opened = (yield* store.listTurns(thread.id))[0]!.startedAt;
      yield* session.emit(usage);
      yield* TestClock.adjust("4 minutes");
      yield* session.completeTurn();
      yield* idle(thread.id);
      expect((yield* store.lastTurnUsage(thread.id))?.lastRequestAt).toBe(opened);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("marks the agent's compaction as Gram's idle one, completed", () =>
    Effect.gen(function* () {
      const { end, rests, parts } = yield* idleCompaction((session) =>
        Effect.gen(function* () {
          yield* session.emit(
            ...reply({
              type: "data-compaction",
              id: "compaction:x",
              data: { trigger: "manual", preTokens: 302_004, postTokens: 31_000, at: 1 },
            }),
          );
          yield* session.completeTurn();
        }),
      );
      expect(rests).toEqual([
        { status: "idle", background: 0, subagentsRunning: false, waiting: 0 },
      ]);
      expect(end.idleCompaction).toBe("completed");
      expect(parts).toEqual([
        {
          trigger: "manual",
          preTokens: 302_004,
          postTokens: 31_000,
          at: 1,
          reason: "idle",
          outcome: "completed",
        },
      ]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("says so when the agent ended the compaction without reporting one", () =>
    Effect.gen(function* () {
      const { end, parts } = yield* idleCompaction((session) => session.completeTurn());
      expect(end.idleCompaction).toBe("unknown");
      expect(parts).toEqual([
        expect.objectContaining({ trigger: "manual", reason: "idle", outcome: "unknown" }),
      ]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("says it failed when the compaction's turn failed", () =>
    Effect.gen(function* () {
      const { end, parts } = yield* idleCompaction((session) =>
        session.emit(
          { type: "turnEnd", reason: "error", error: "synthetic failure" } as AgentEvent,
          { type: "status", status: "idle" } as AgentEvent,
        ),
      );
      expect(end.idleCompaction).toBe("failed");
      expect(parts).toEqual([expect.objectContaining({ reason: "idle", outcome: "failed" })]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("queues a notice behind an idle compaction rather than steering it in", () =>
    Effect.gen(function* () {
      const { thread, session, runtimes } = yield* start;
      yield* session.completeTurn();
      yield* idle(thread.id);
      yield* runtimes.requestSystemDelivery(thread.id, "idle-compact", {
        build: () =>
          Effect.succeed({
            text: "/compact",
            notice: { kind: "idleCompact", contextTokens: 302_004 },
          } satisfies UserInput),
        accepted: () => Effect.void,
        failed: () => Effect.void,
      });
      yield* waitFor(
        "the compact send",
        Effect.sync(() => session.sent.length === 2),
      );
      const notice: UserInput = { text: "Review update on #7" };
      const result = yield* runtimes.sendNotice(thread.id, "review:o/r#7", notice);
      expect(result).toMatchObject({ queued: true, steered: false });
      expect(session.steered).toEqual([]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("leaves an ordinary /compact the user typed alone", () =>
    Effect.gen(function* () {
      const { thread, session, runtimes } = yield* start;
      yield* session.completeTurn();
      yield* idle(thread.id);
      yield* runtimes.send(thread.id, { text: "/compact" });
      yield* waitFor(
        "the compact send",
        Effect.sync(() => session.sent.length === 2),
      );
      yield* session.emit(
        ...reply({
          type: "data-compaction",
          id: "compaction:y",
          data: { trigger: "manual", at: 2 },
        }),
      );
      yield* session.completeTurn();
      yield* idle(thread.id);
      expect(yield* compactionParts(thread.id)).toEqual([{ trigger: "manual", at: 2 }]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );
});
