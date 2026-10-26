import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadStore } from "../persistence/thread-store.ts";
import { usageHandlers } from "./handler.ts";
import { UsageHistoryRoots } from "./history-roots.ts";

const NOW = Date.parse("2026-10-16T12:00:00Z");
const at = NOW - 60_000;
const timestamp = new Date(at).toISOString();
const resetsAt = NOW + 3_600_000;
const line = (value: object) => JSON.stringify(value) + "\n";

// No provider/CLI/auth layers are installed. Both roots are synthetic, never host homes.
const fixture = Effect.gen(function* () {
  const dir = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "gram-usage-sources-offline-"))),
    (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
  );
  const roots = ["claude", "codex"].map((provider) => ({
    provider: provider as "claude" | "codex",
    dir: join(dir, provider),
  }));
  yield* Effect.promise(async () => {
    for (const root of roots) await mkdir(root.dir);
    await writeFile(
      join(dir, "claude", "session.jsonl"),
      line({
        type: "assistant",
        timestamp,
        sessionId: "synthetic-session",
        uuid: "synthetic-uuid",
        message: {
          id: "synthetic-message",
          model: "synthetic-model",
          usage: {
            input_tokens: 10,
            output_tokens: 2,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          content: [{ text: "invented content must disappear" }],
        },
      }),
    );
    await writeFile(
      join(dir, "codex", "rollout-synthetic.jsonl"),
      line({ type: "session_meta", timestamp, payload: { id: "synthetic-codex" } }) +
        line({
          type: "event_msg",
          timestamp,
          payload: {
            type: "token_count",
            info: null,
            rate_limits: {
              limit_id: "codex",
              primary: { used_percent: 42, window_minutes: 300, resets_at: resetsAt / 1000 },
              secondary: null,
            },
          },
        }),
    );
  });
  yield* TestClock.setTime(NOW);
  const store = yield* ThreadStore;
  const handlers = yield* usageHandlers.pipe(
    Effect.provideService(UsageHistoryRoots, { roots: Effect.succeed(roots) }),
  );
  return { store, read: () => handlers["app.usageOverview"]({ days: 7 }) };
});

describe("local CLI usage sources", () => {
  it.effect("honors provider revocation after a warm scan and reenables metadata history", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { store, read } = yield* fixture;
        expect((yield* read()).totals.totalTokens).toBe(12);
        yield* store.updateSettings((settings) => ({
          ...settings,
          usageHistory: { claude: false, codex: false },
        }));
        const disabled = yield* read();
        expect(disabled.totals.totalTokens).toBe(0);
        expect(disabled.history?.sources).toEqual([]);
        yield* store.updateSettings((settings) => ({
          ...settings,
          usageHistory: { claude: true, codex: false },
        }));
        const enabled = yield* read();
        expect(enabled.totals.totalTokens).toBe(12);
        expect(enabled.history?.sources.map((source) => source.provider)).toEqual(["claude"]);
        expect(JSON.stringify(enabled)).not.toMatch(
          /invented content|synthetic-session|synthetic-uuid/,
        );
      }),
    ).pipe(Effect.provide(ThreadStore.layerSqlite(":memory:").pipe(Layer.orDie))),
  );
  it.effect(
    "returns local quota observations without treating them as tokens or fresh account limits",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { read } = yield* fixture;
          const data = yield* read();
          expect(data.totals.totalTokens).toBe(12);
          expect(data).toMatchObject({
            localLimitHistory: {
              observations: [
                { provider: "codex", window: "five_hour", utilization: 0.42, at, resetsAt },
              ],
              invalidReadings: 0,
              truncated: false,
            },
          });
          expect(yield* read()).toEqual(data);
        }),
      ).pipe(Effect.provide(ThreadStore.layerSqlite(":memory:").pipe(Layer.orDie))),
  );
});
