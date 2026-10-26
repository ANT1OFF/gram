import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "@effect/vitest";
import { makeMapper } from "@gram/agents/claude";
import { makeCodexMapper } from "@gram/agents/codex";
import {
  MessageId,
  type AgentEvent,
  type GramUIMessage,
  type Thread,
  type ThreadId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MessageAccumulator } from "../runtime/message-accumulator.ts";
import { ThreadStore } from "./thread-store.ts";

const apply = (acc: MessageAccumulator, events: ReadonlyArray<AgentEvent>) => {
  for (const event of events) if (event.type === "chunk") acc.apply(event.chunk);
  return acc.snapshot();
};

describe("persisted compaction results", () => {
  it.effect(
    "restores a late Claude summary, Codex's metadata-only result and an untimed marker after reopening SQLite",
    () =>
      Effect.gen(function* () {
        const dir = mkdtempSync(join(tmpdir(), "gram-compaction-result-"));
        yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(dir, { recursive: true })));
        const file = join(dir, "gram.db");
        const at = 1_790_846_290_326;
        const claude = makeMapper({
          newMessageId: () => MessageId.make("claude-result"),
          now: () => at,
        });
        const acc = new MessageAccumulator("claude-result");
        const boundary = claude.map({
          type: "system",
          subtype: "compact_boundary",
          uuid: "boundary",
          session_id: "synthetic",
          compact_metadata: { trigger: "manual", pre_tokens: 182_000, post_tokens: 24_000 },
        } as unknown as SDKMessage);
        const first = apply(acc, boundary);
        const codex = makeCodexMapper({
          newMessageId: () => MessageId.make("codex-result"),
          now: () => at,
        });
        const codexResult = apply(
          new MessageAccumulator("codex-result"),
          codex.map({
            method: "item/completed",
            params: {
              threadId: "synthetic",
              turnId: "turn",
              item: { type: "contextCompaction", id: "codex" },
              completedAtMs: at,
            },
          }),
        );
        const untimed: GramUIMessage = {
          id: "untimed-result",
          role: "assistant",
          parts: [{ type: "data-compaction", data: { trigger: "auto" } }],
        };
        const id = "compaction-thread" as ThreadId;
        const saved = yield* Effect.gen(function* () {
          const store = yield* ThreadStore;
          const project = yield* store.ensureProject({ root: "/synthetic/repo", name: "repo" });
          yield* store.insertThread({
            id,
            projectId: project.id,
            title: "Compaction result",
            userNamed: false,
            model: { agent: "claude", model: "synthetic" },
            mode: "default",
            checkout: { kind: "main", path: "/synthetic/repo" },
            labels: [],
            pinned: false,
            parked: false,
            unread: false,
            createdAt: at,
            lastActivityAt: at,
          } as Thread);
          yield* store.upsertMessage(id, first);
          const initial = yield* store.listMessages(id);
          expect(initial[0]!.parts).toContainEqual({
            type: "data-compaction",
            id: "compaction:boundary",
            data: { trigger: "manual", preTokens: 182_000, postTokens: 24_000, at },
          });
          const updated = apply(
            acc,
            claude.compacted(
              "<analysis>private notes</analysis><summary>Preserve the retry fix.</summary>",
            ),
          );
          yield* store.upsertMessage(id, updated);
          yield* store.upsertMessage(id, codexResult);
          yield* store.upsertMessage(id, untimed);
          return [updated, codexResult, untimed];
        }).pipe(Effect.provide(ThreadStore.layerSqlite(file)));
        const restored = yield* Effect.gen(function* () {
          const store = yield* ThreadStore;
          return yield* store.listMessages(id);
        }).pipe(Effect.provide(ThreadStore.layerSqlite(file)));
        expect(restored).toEqual(saved);
        const results = restored.flatMap((message) =>
          message.parts.filter((part) => part.type === "data-compaction"),
        );
        expect(results).toHaveLength(3);
        expect(results[0]!.data.summary).toBe("Preserve the retry fix.");
        expect(results[1]!.data).toEqual({ trigger: "auto", at });
        expect(results[2]!.data).toEqual({ trigger: "auto" });
        expect(JSON.stringify(restored)).not.toContain("private notes");
      }),
  );
});
