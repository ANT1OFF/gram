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
const counts = {
  input_tokens: 100,
  output_tokens: 10,
  cached_input_tokens: 0,
  cache_write_input_tokens: 0,
  reasoning_output_tokens: 0,
};
const timestamp = "2026-10-06T12:00:00Z";
const record = (type: string, payload: object) => ({ type, timestamp, payload });
const fixture = (native: boolean) =>
  [
    record("session_meta", { id: "private-session-scope" }),
    record("turn_context", {
      model: "actual-model",
      ...(native ? { turn_id: "private-native-turn" } : {}),
    }),
    record("event_msg", {
      type: "token_count",
      info: { total_token_usage: counts, last_token_usage: counts },
    }),
  ]
    .map((value) => JSON.stringify(value))
    .join("\n") + "\n";

it.effect(
  "omits an idless copied same-session amount through the production reader/handler instead of counting it twice",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "gram-origin-causal-offline-"))),
          (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
        );
        yield* Effect.promise(async () => {
          await writeFile(join(root, "rollout-identified.jsonl"), fixture(true));
          await writeFile(join(root, "rollout-partial-copy.jsonl"), fixture(false));
        });
        yield* TestClock.setTime(Date.parse("2026-10-12T12:00:00Z"));
        const data = yield* Effect.gen(function* () {
          const handler = yield* usageHandlers;
          return yield* handler["app.usageOverview"]({ days: 7 });
        }).pipe(
          Effect.provideService(UsageHistoryRoots, {
            roots: Effect.succeed([{ provider: "codex" as const, dir: root }]),
          }),
        );
        expect(data.totals.totalTokens).toBe(110);
        expect(data).toMatchObject({
          recordedTurns: 1,
          partialUsageTurns: 1,
          history: { importedRecords: 1, omittedRecords: 1, ambiguousRecords: 3 },
        });
        expect(data.rows[0]?.model).toBe("actual-model");
        expect(JSON.stringify(data)).not.toMatch(
          /fileIdentity|private-session-scope|private-native-turn|fingerprint/,
        );
        expect(JSON.stringify(data)).not.toContain(root);
      }),
    ).pipe(Effect.provide(ThreadStore.layerSqlite(":memory:").pipe(Layer.orDie))),
);
