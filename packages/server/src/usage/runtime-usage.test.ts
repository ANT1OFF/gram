import type { MessageId } from "@gram/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentControl } from "../runtime/fake-agent.ts";
import { RuntimeTestLayer, waitFor } from "../runtime/test-harness.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";

const report = (inputTokens: number, outputTokens: number) => ({
  inputTokens,
  outputTokens,
  totalTokens: inputTokens + outputTokens,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
});
it.effect(
  "sums only final turn snapshots across repeated reports, counters reset on later turns and duplicate end events",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-10-12T12:00:00Z"));
      const store = yield* ThreadStore;
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      const thread = yield* runtimes.create({
        projectRoot: "/invented/runtime",
        checkout: { kind: "main", path: "/invented/runtime" },
        model: { agent: "claude", model: "requested-alias" },
        input: { text: "Synthetic first turn" },
      });
      const session = yield* waitFor(
        "first synthetic send",
        fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
      );
      const begin = (id: string, model: string) =>
        session.emit(
          {
            type: "chunk",
            messageId: id as MessageId,
            chunk: {
              type: "start",
              messageId: id as MessageId,
              messageMetadata: { agent: "claude", model },
            },
          },
          { type: "chunk", messageId: id as MessageId, chunk: { type: "text-start", id: "text" } },
          {
            type: "chunk",
            messageId: id as MessageId,
            chunk: { type: "text-delta", id: "text", delta: "Invented reply" },
          },
          { type: "chunk", messageId: id as MessageId, chunk: { type: "text-end", id: "text" } },
          { type: "chunk", messageId: id as MessageId, chunk: { type: "finish" } },
        );
      yield* begin("first", "wire-old");
      for (const inputTokens of [10, 20, 20, 40, 40])
        yield* session.emit({
          type: "usage",
          tokens: { inputTokens, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
          costUsd: 10,
        });
      yield* session.emit(
        { type: "turnEnd", reason: "completed" },
        { type: "turnEnd", reason: "completed" },
      );
      yield* waitFor(
        "first persisted snapshot",
        store.lastTurnUsage(thread.id).pipe(Effect.map((u) => u?.tokens.inputTokens === 40)),
      );
      yield* TestClock.adjust(1000);
      let data = yield* store.usageOverview({ days: 1 });
      expect(data).toMatchObject({ recordedTurns: 1, totals: { totalTokens: 42 } });
      yield* runtimes.send(thread.id, { text: "Synthetic second turn" });
      yield* waitFor(
        "second synthetic send",
        fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 2 && s)),
      );
      yield* begin("second", "wire-new");
      yield* session.emit(
        {
          type: "usage",
          tokens: { inputTokens: 3, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          costUsd: 0.1,
        },
        { type: "turnEnd", reason: "interrupted" },
      );
      yield* waitFor(
        "reset snapshot persisted",
        store.lastTurnUsage(thread.id).pipe(Effect.map((u) => u?.tokens.inputTokens === 3)),
      );
      yield* TestClock.adjust(1000);
      data = yield* store.usageOverview({ days: 1 });
      expect(data).toMatchObject({
        recordedTurns: 2,
        recordedConversations: 1,
        interruptedTurns: 1,
        totals: { totalTokens: 46 },
      });
      expect(data.rows.map((row) => row.model).toSorted()).toEqual(["wire-new", "wire-old"]);
      expect(data.rows.reduce((n, row) => n + row.totals.totalTokens, 0)).toBe(46);
    }).pipe(Effect.provide(RuntimeTestLayer)),
);

for (const { fresh, input, output } of [
  { fresh: false, input: 100, output: 10 },
  { fresh: true, input: 100, output: 10 },
  { fresh: true, input: 0, output: 0 },
]) {
  const marker = fresh ? "codex-request-delta-v1" : "codex-last-request-v1";
  it.effect(
    `persists ${marker} with ${input + output} real tokens, original scope and wire model through runtime/projection/overview`,
    () =>
      Effect.gen(function* () {
        const { makeCodexMapper } = yield* Effect.promise(() => import("@gram/agents/codex"));
        const { MessageId } = yield* Effect.promise(() => import("@gram/contracts"));
        yield* TestClock.setTime(Date.parse("2026-10-12T12:00:00Z"));
        const store = yield* ThreadStore,
          runtimes = yield* ThreadRuntimes,
          fake = yield* FakeAgentControl;
        const thread = yield* runtimes.create({
          projectRoot: "/invented/provenance",
          checkout: { kind: "main", path: "/invented/provenance" },
          model: { agent: "codex", model: "selected-is-not-wire" },
          input: { text: "Invented new request" },
        });
        const session = yield* waitFor(
          "offline Codex session",
          fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
        );
        const mapper = makeCodexMapper({
          threadId: "original-wire-session",
          freshSession: fresh,
          newMessageId: () => MessageId.make("native-message"),
        });
        type Notification = Parameters<typeof mapper.map>[0];
        const native = {
          id: "native-turn",
          items: [],
          itemsView: "full",
          startedAt: 1,
          completedAt: null,
          durationMs: null,
          error: null,
        };
        const notifications = [
          {
            method: "turn/started",
            params: {
              threadId: "original-wire-session",
              turn: { ...native, status: "inProgress" },
            },
          },
          {
            method: "model/rerouted",
            params: {
              threadId: "original-wire-session",
              turnId: "native-turn",
              toModel: "actual-wire",
              fromModel: "irrelevant",
              reason: "rateLimit",
            },
          },
          {
            method: "thread/tokenUsage/updated",
            params: {
              threadId: "original-wire-session",
              turnId: "native-turn",
              tokenUsage: {
                total: fresh ? report(input, output) : report(1_000_100, 10_010),
                last: report(input, output),
                modelContextWindow: null,
                telemetryVersion: "codex-request-delta-v1",
              },
            },
          },
          {
            method: "turn/completed",
            params: { threadId: "original-wire-session", turn: { ...native, status: "completed" } },
          },
        ];
        const events = notifications.flatMap((n) => mapper.map(n as Notification));
        expect(events.find((e) => e.type === "usage")).toMatchObject({
          telemetryVersion: marker,
          ...(!fresh ? { partial: true } : {}),
          tokens: { inputTokens: input, outputTokens: output },
        });
        yield* session.emit(...events);
        const usage = yield* waitFor(
          "normalizer provenance persisted",
          store
            .lastTurnUsage(thread.id)
            .pipe(Effect.map((u) => u?.telemetryVersion === marker && u)),
        );
        expect(usage.partial).toBe(fresh ? undefined : true);
        expect(usage).toMatchObject({
          tokens: { inputTokens: input, outputTokens: output },
        });
        yield* TestClock.adjust(1000);
        const scan = { records: [], sources: [], ambiguous: 0 };
        let data = yield* store.usageOverview({ days: 1 }, scan);
        expect(data).toMatchObject({
          recordedTurns: 1,
          ...(!fresh ? { partialUsageTurns: 1 } : {}),
          totals: { totalTokens: input + output },
          history: { untrustedGramTurns: 0, unmatchedGramTurns: 1 },
        });
        expect(data.partialUsageTurns).toBe(fresh ? undefined : 1);
        expect(data.rows[0]?.model).toBe("actual-wire");
        const authoritative = {
          provider: "codex" as const,
          session: "original-wire-session",
          id: "native-turn",
          nativeIds: ["native-turn"],
          model: "historical-context",
          at: Date.parse("2026-10-12T12:00:00Z"),
          tokens: {
            inputTokens: input,
            outputTokens: output,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          trusted: true,
          complete: true,
          partial: false,
          parent: null,
          basis: "delta" as const,
        };
        data = yield* store.usageOverview({ days: 1 }, { ...scan, records: [authoritative] });
        expect(data).toMatchObject({
          recordedTurns: 1,
          totals: { totalTokens: input + output },
          history: { matchedTurns: 1, importedRecords: 0 },
        });
        // Both sources report actual models, but disagree: replacing counts cannot resolve it.
        expect(data.rows[0]?.model).toBeNull();
        expect(data.unknownModelTurns).toBe(1);
        expect(yield* store.lastTurnUsage(thread.id)).toEqual(usage); // read replacement never rewrites snapshots
        yield* store.closeThread(thread.id, Date.parse("2026-10-12T12:00:01Z"));
        expect(
          yield* store.usageOverview({ days: 1 }, { ...scan, records: [authoritative] }),
        ).toEqual(data);
      }).pipe(Effect.provide(RuntimeTestLayer)),
  );
}

for (const telemetry of ["absent", "malformed", "reset-unproven"] as const) {
  it.effect(
    `keeps ${telemetry} Codex telemetry missing through runtime/store/history overview`,
    () =>
      Effect.gen(function* () {
        const { makeCodexMapper } = yield* Effect.promise(() => import("@gram/agents/codex"));
        const { MessageId } = yield* Effect.promise(() => import("@gram/contracts"));
        yield* TestClock.setTime(Date.parse("2026-10-12T12:00:00Z"));
        const store = yield* ThreadStore,
          runtimes = yield* ThreadRuntimes,
          fake = yield* FakeAgentControl;
        const thread = yield* runtimes.create({
          projectRoot: "/invented/missing-usage",
          checkout: { kind: "main", path: "/invented/missing-usage" },
          model: { agent: "codex", model: "selected-is-not-wire" },
          input: { text: "Invented missing telemetry" },
        });
        const session = yield* waitFor(
          "offline missing telemetry send",
          fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
        );
        const mapper = makeCodexMapper({
          threadId: "captured-original",
          freshSession: false,
          newMessageId: () => MessageId.make(`missing-${telemetry}`),
        });
        type Notification = Parameters<typeof mapper.map>[0];
        const native = {
          id: "native-turn",
          items: [],
          itemsView: "full",
          startedAt: 1,
          completedAt: null,
          durationMs: null,
          error: null,
        };
        const notifications: unknown[] = [
          {
            method: "turn/started",
            params: { threadId: "captured-original", turn: { ...native, status: "inProgress" } },
          },
        ];
        if (telemetry !== "absent") {
          for (const total of telemetry === "malformed"
            ? [report(-1, -1)]
            : [report(1000, 100), report(500, 50)])
            notifications.push({
              method: "thread/tokenUsage/updated",
              params: {
                threadId: "captured-original",
                turnId: "native-turn",
                tokenUsage: { total, last: null, modelContextWindow: null },
              },
            });
        }
        notifications.push({
          method: "turn/completed",
          params: { threadId: "captured-original", turn: { ...native, status: "completed" } },
        });
        const events = notifications.flatMap((n) => mapper.map(n as Notification));
        expect(events.filter((e) => e.type === "usage")).toEqual([]);
        yield* session.emit(...events);
        yield* TestClock.adjust(1000);
        const data = yield* waitFor(
          "missing usage persisted without a fabricated zero",
          store
            .usageOverview({ days: 1 }, { records: [], sources: [], ambiguous: 0 })
            .pipe(Effect.map((d) => d.missingUsageTurns === 1 && d)),
        );
        expect(data).toMatchObject({
          recordedTurns: 0,
          missingUsageTurns: 1,
          invalidUsageTurns: 0,
          history: { untrustedGramTurns: 0, unmatchedGramTurns: 1 },
        });
        expect(yield* store.lastTurnUsage(thread.id)).toBeUndefined();
      }).pipe(Effect.provide(RuntimeTestLayer)),
  );
}
