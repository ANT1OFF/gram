import { makeCodexMapper } from "@gram/agents/codex";
import { MessageId, ThreadId, TurnId, type Thread } from "@gram/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadStore } from "../persistence/thread-store.ts";
import { usageHandlers } from "./handler.ts";
import { UsageHistoryRoots } from "./history-roots.ts";
const NOW = Date.parse("2026-10-12T12:00:00Z");
const count = (input: number, output: number) => ({
  input_tokens: input,
  output_tokens: output,
  cached_input_tokens: 0,
  cache_write_input_tokens: 0,
  reasoning_output_tokens: 0,
});
const wire = (input: number, output: number) => ({
  inputTokens: input,
  outputTokens: output,
  totalTokens: input + output,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
});

for (const telemetry of [
  "known",
  "missing",
  "conflicting-model",
  "zero",
  "invalid",
  "untrusted",
  "incomplete-context",
  "missing-id",
  "wrong-session",
  "mixed-main",
  "missing-main-model",
  "duplicate-main",
  "full-covered",
  "full-zero",
] as const) {
  it.effect(
    `retains actual CLI model/known contribution independently of partial counters for ${telemetry}`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "gram-model-join-offline-"))),
            (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
          );
          const at = NOW - 1000,
            timestamp = new Date(at).toISOString();
          const record = (type: string, payload: object) => ({ type, timestamp, payload });
          yield* Effect.promise(() =>
            writeFile(
              join(root, "rollout-context.jsonl"),
              [
                record("session_meta", { id: "original-session" }),
                ...(telemetry.startsWith("full-")
                  ? [
                      record("event_msg", {
                        type: "token_count",
                        info: { total_token_usage: count(50, 5) },
                      }),
                    ]
                  : []),
                record("turn_context", { turn_id: "native-turn", model: "actual-context-model" }),
                record("event_msg", {
                  type: "token_count",
                  info: {
                    total_token_usage: telemetry === "full-zero" ? count(50, 5) : count(150, 15),
                    last_token_usage: telemetry === "full-zero" ? count(0, 0) : count(100, 10),
                  },
                }),
                ...(telemetry === "incomplete-context"
                  ? []
                  : [record("event_msg", { type: "task_complete", turn_id: "native-turn" })]),
              ]
                .map((value) => JSON.stringify(value))
                .join("\n") + "\n",
            ),
          );
          yield* TestClock.setTime(NOW);
          const store = yield* ThreadStore;
          const project = yield* store.ensureProject({
            root: "/invented/model-join",
            name: "Invented",
          });
          const thread: Thread = {
            id: ThreadId.make("gram-thread"),
            projectId: project.id,
            title: "Invented model join",
            model: { agent: "codex", model: "selected-never-actual" },
            userNamed: false,
            mode: "default",
            checkout: { kind: "main", path: "/invented/model-join" },
            labels: [],
            pinned: false,
            parked: false,
            unread: false,
            createdAt: 1,
            lastActivityAt: 1,
          };
          yield* store.insertThread(thread);
          const turnId = TurnId.make("gram-turn");
          yield* store.startTurn(thread.id, turnId, at);
          const mapper = makeCodexMapper({
            threadId: "original-session",
            freshSession: true,
            newMessageId: () => MessageId.make("main"),
          });
          type Notification = Parameters<typeof mapper.map>[0];
          const events = mapper.map({
            method: "turn/started",
            params: {
              threadId: "original-session",
              turn: {
                id: "native-turn",
                rootTurnId: null,
                items: [],
                itemsView: "full",
                status: "inProgress",
                error: null,
                startedAt: null,
                completedAt: null,
                durationMs: null,
              },
            },
          } as Notification);
          if (telemetry !== "missing")
            events.push(
              ...mapper.map({
                method: "thread/tokenUsage/updated",
                params: {
                  threadId: "original-session",
                  turnId: "native-turn",
                  tokenUsage: {
                    total:
                      telemetry === "zero" || telemetry === "full-zero"
                        ? wire(0, 0)
                        : wire(150, 15),
                    last:
                      telemetry === "zero" || telemetry === "full-zero"
                        ? wire(0, 0)
                        : wire(100, 10),
                    modelContextWindow: null,
                  },
                },
              } as Notification),
            );
          if (telemetry === "conflicting-model")
            events.push(
              ...mapper.map({
                method: "model/rerouted",
                params: {
                  threadId: "original-session",
                  turnId: "native-turn",
                  fromModel: "actual-context-model",
                  toModel: "other-wire-model",
                  reason: "highRiskCyberActivity",
                },
              } as Notification),
            );
          const metadata = Object.assign(
            {},
            ...events.flatMap((event) =>
              event.type === "chunk" &&
              (event.chunk.type === "start" || event.chunk.type === "message-metadata")
                ? [event.chunk.messageMetadata]
                : [],
            ),
          );
          if (telemetry === "missing-id") metadata.agentMessageIds = ["native-turn", "unavailable"];
          if (telemetry === "wrong-session") metadata.agentSessionId = "other-session";
          if (telemetry === "mixed-main" || telemetry === "missing-main-model")
            metadata.model = "original-model-one";
          yield* store.upsertMessage(
            thread.id,
            {
              id: "main",
              role: "assistant",
              parts: [{ type: "text", text: "Invented ignored body" }],
              metadata,
            },
            turnId,
          );
          if (["mixed-main", "missing-main-model", "duplicate-main"].includes(telemetry))
            yield* store.upsertMessage(
              thread.id,
              {
                id: "another-main",
                role: "assistant",
                parts: [],
                metadata: {
                  ...metadata,
                  ...(telemetry === "mixed-main"
                    ? { model: "original-model-two" }
                    : telemetry === "missing-main-model"
                      ? { model: undefined }
                      : {}),
                },
              },
              turnId,
            );
          const usageEvent = events.find((event) => event.type === "usage");
          let usage =
            usageEvent === undefined
              ? undefined
              : {
                  tokens: usageEvent.tokens,
                  ...(usageEvent.telemetryVersion === undefined
                    ? {}
                    : { telemetryVersion: usageEvent.telemetryVersion }),
                  ...(usageEvent.partial === undefined ? {} : { partial: usageEvent.partial }),
                };
          if (telemetry === "invalid") usage = { tokens: { inputTokens: -1, outputTokens: 15 } };
          if (telemetry === "untrusted")
            usage = { tokens: { inputTokens: 1_000_150, outputTokens: 10_015 } };
          yield* store.endTurn(turnId, {
            endedAt: NOW - 500,
            reason: "completed",
            ...(usage === undefined ? {} : { usage }),
          });
          const data = yield* Effect.gen(function* () {
            const handler = yield* usageHandlers;
            return yield* handler["app.usageOverview"]({ days: 7 });
          }).pipe(
            Effect.provideService(UsageHistoryRoots, {
              roots: Effect.succeed([{ provider: "codex" as const, dir: root }]),
            }),
          );
          const imported = ["missing", "invalid", "untrusted", "wrong-session"].includes(telemetry);
          const full = telemetry.startsWith("full-");
          const total =
            telemetry === "wrong-session"
              ? 275
              : telemetry === "zero" || telemetry === "full-zero"
                ? 0
                : imported || full
                  ? 110
                  : 165;
          expect(data.totals.totalTokens).toBe(total);
          expect(data.recordedTurns).toBe(telemetry === "wrong-session" ? 2 : 1);
          expect(data.rows[0]?.model).toBe(
            [
              "conflicting-model",
              "incomplete-context",
              "missing-id",
              "wrong-session",
              "mixed-main",
              "missing-main-model",
            ].includes(telemetry)
              ? null
              : "actual-context-model",
          );
          expect(data.history?.matchedTurns).toBe(full ? 1 : 0);
          expect(data.history?.importedRecords).toBe(imported ? 1 : 0);
          expect(data.history?.untrustedGramTurns).toBe(
            ["invalid", "untrusted"].includes(telemetry) ? 1 : 0,
          );
          expect(data.unknownModelTurns).toBe(
            [
              "conflicting-model",
              "incomplete-context",
              "missing-id",
              "wrong-session",
              "mixed-main",
              "missing-main-model",
            ].includes(telemetry)
              ? 1
              : 0,
          );
          expect(data.missingUsageTurns).toBe(telemetry === "missing" ? 1 : 0);
          expect(yield* store.lastTurnUsage(thread.id)).toEqual(usage);
          expect(JSON.stringify(data)).not.toContain("selected-never-actual");
          for (const privateField of [
            "fileIdentity",
            "model_conflict",
            "model_witness",
            "modelConflict",
            "modelWitness",
            root,
          ])
            expect(JSON.stringify(data)).not.toContain(privateField);
        }),
      ).pipe(Effect.provide(ThreadStore.layerSqlite(":memory:").pipe(Layer.orDie))),
  );
}
