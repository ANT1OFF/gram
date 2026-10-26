import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { makeMapper } from "@gram/agents/claude";
import { makeCodexMapper } from "@gram/agents/codex";
import { MessageId } from "@gram/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadStore } from "../persistence/thread-store.ts";
import { usageHandlers } from "./handler.ts";

// This deliberately stands alone: the unchanged base ignores this explicit offline root service.
// The saved before/after oracle never discovers the host's CLI, credentials or account state.
class OfflineRoots extends Context.Service<
  OfflineRoots,
  {
    readonly roots: Effect.Effect<
      readonly { readonly provider: "codex" | "claude"; readonly dir: string }[]
    >;
  }
>()("@gram/server/UsageHistoryRoots") {}

const NOW = Date.parse("2026-10-12T16:06:00Z");
type ServerNotification = Parameters<ReturnType<typeof makeCodexMapper>["map"]>[0];
const breakdown = (inputTokens: number, outputTokens: number) => ({
  totalTokens: inputTokens + outputTokens,
  inputTokens,
  outputTokens,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
});
const turn = (id: string, status: "inProgress" | "completed"): ServerNotification => ({
  method: status === "inProgress" ? "turn/started" : "turn/completed",
  params: {
    threadId: "offline-session",
    turn: {
      id,
      status,
      items: [],
      itemsView: "full",
      error: null,
      rootTurnId: id,
      startedAt: 1,
      completedAt: status === "completed" ? 2 : null,
      durationMs: status === "completed" ? 1000 : null,
    },
  },
});

const count = (input: number, output: number) => ({
  input_tokens: input,
  output_tokens: output,
  cached_input_tokens: 0,
  cache_write_input_tokens: 0,
  reasoning_output_tokens: 0,
  total_tokens: input + output,
});

it("counts only the new request when a fresh Codex mapper receives resumed cumulative telemetry", () => {
  const mapper = makeCodexMapper({
    threadId: "offline-session",
    newMessageId: () => MessageId.make("offline-reply"),
  });
  mapper.map(turn("offline-new-turn", "inProgress"));
  const update: ServerNotification = {
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "offline-session",
      turnId: "offline-new-turn",
      tokenUsage: {
        total: breakdown(1_000_100, 10_010),
        last: breakdown(100, 10),
        modelContextWindow: null,
      },
    },
  };
  mapper.map(update);
  mapper.map(update);
  const events = mapper.map(turn("offline-new-turn", "completed"));
  expect(events.find((event) => event.type === "usage")).toMatchObject({
    tokens: { inputTokens: 100, outputTokens: 10 },
  });
});

it("retains the actual Claude main-lane model reported by the assistant", () => {
  const mapper = makeMapper({ newMessageId: () => MessageId.make("offline-claude-reply") });
  const events = mapper.map({
    type: "assistant",
    uuid: "offline-uuid",
    session_id: "offline-session",
    parent_tool_use_id: null,
    message: {
      id: "offline-request",
      role: "assistant",
      model: "claude-offline-old",
      content: [{ type: "text", text: "Invented reply" }],
      usage: {
        input_tokens: 7,
        output_tokens: 2,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 3,
      },
    },
  } as unknown as SDKMessage);
  const models = events.flatMap((event) =>
    event.type === "chunk" &&
    (event.chunk.type === "start" || event.chunk.type === "message-metadata")
      ? [event.chunk.messageMetadata?.model]
      : [],
  );
  expect(models).toContain("claude-offline-old");
});

it.effect(
  "loads older available CLI usage and changing models through the production handler with explicit offline roots",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "gram-history-oracle-"))),
          (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
        );
        const codex = join(root, "custom-codex", "sessions");
        const claude = join(root, "custom-claude", "projects");
        yield* Effect.promise(async () => {
          await mkdir(codex, { recursive: true });
          await mkdir(claude, { recursive: true });
          const timestamp = "2026-10-06T12:00:00Z";
          const event = (type: string, payload: object) => ({ timestamp, type, payload });
          const token = (last: object, total: object) =>
            event("event_msg", {
              type: "token_count",
              info: { last_token_usage: last, total_token_usage: total },
            });
          const lines = [
            event("session_meta", {
              id: "offline-old-session",
              model_provider: "openai",
              source: "cli",
            }),
            event("turn_context", { turn_id: "offline-first", model: "gpt-offline-old" }),
            token(count(100, 10), count(100, 10)),
            token(count(100, 10), count(100, 10)),
            event("turn_context", { turn_id: "offline-second", model: "gpt-offline-new" }),
            token(count(80, 5), count(180, 15)),
          ];
          await writeFile(
            join(codex, "rollout-offline.jsonl"),
            lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
          );
          await writeFile(
            join(claude, "offline.jsonl"),
            JSON.stringify({
              type: "assistant",
              timestamp,
              sessionId: "offline-claude-session",
              uuid: "offline-claude-uuid",
              requestId: "offline-request",
              message: {
                id: "offline-message",
                model: "claude-offline-old",
                usage: {
                  input_tokens: 7,
                  output_tokens: 2,
                  cache_read_input_tokens: 20,
                  cache_creation_input_tokens: 3,
                },
                content: [{ type: "text", text: "Invented body must never be returned" }],
              },
            }) + "\n",
          );
        });
        yield* TestClock.setTime(NOW);
        const data = yield* Effect.gen(function* () {
          const handler = yield* usageHandlers;
          return yield* handler["app.usageOverview"]({ days: 7 });
        }).pipe(
          Effect.provideService(OfflineRoots, {
            roots: Effect.succeed([
              { provider: "codex" as const, dir: codex },
              { provider: "claude" as const, dir: claude },
            ]),
          }),
        );
        expect(data.totals.totalTokens).toBe(227);
        expect(data.rows.map((row) => row.model).toSorted()).toEqual([
          "claude-offline-old",
          "gpt-offline-new",
          "gpt-offline-old",
        ]);
        expect(data.rows.every((row) => row.day === "2026-10-06")).toBe(true);
        expect(JSON.stringify(data)).not.toContain("Invented body");
      }),
    ).pipe(Effect.provide(ThreadStore.layerSqlite(":memory:").pipe(Layer.orDie))),
);
