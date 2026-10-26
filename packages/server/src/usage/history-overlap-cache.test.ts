import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { mkdtemp, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadStore } from "../persistence/thread-store.ts";
import { usageHandlers } from "./handler.ts";
import { UsageHistoryRoots } from "./history-roots.ts";
const e = (type: string, payload: object) => ({ type, payload, timestamp: "2026-10-06T12:00:00Z" }),
  c = (n: number, detail: object = {}) => ({ input_tokens: n, output_tokens: 0, ...detail }),
  text = (a: object[]) => a.map((x) => JSON.stringify(x) + "\n").join("");
it.effect(
  "retaining old cache minima beside a stronger request with unknown cache cannot certify a full split",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "usage-cache-minimum-"))),
            (d) => Effect.promise(() => rm(d, { recursive: true, force: true })),
          ),
          file = join(dir, "rollout-minimum.jsonl");
        yield* Effect.promise(() =>
          writeFile(
            file,
            text([
              e("session_meta", { id: "owner" }),
              e("event_msg", {
                type: "token_count",
                info: {
                  total_token_usage: c(0, { cached_input_tokens: 0, cache_write_input_tokens: 0 }),
                },
              }),
              e("turn_context", { turn_id: "native", model: "actual" }),
              e("event_msg", {
                type: "token_count",
                info: {
                  total_token_usage: c(20, { cached_input_tokens: 5, cache_write_input_tokens: 0 }),
                },
              }),
            ]),
          ),
        );
        yield* TestClock.setTime(Date.parse("2026-10-12T12:00:00Z"));
        const h = yield* usageHandlers.pipe(
          Effect.provideService(UsageHistoryRoots, {
            roots: Effect.succeed([{ provider: "codex" as const, dir }]),
          }),
        );
        const warm = yield* h["app.usageOverview"]({ days: 7 });
        expect(warm.totals.uncachedInputTokens).toBe(15);
        yield* Effect.promise(() =>
          appendFile(
            file,
            text([
              e("token_usage_record", {
                thread_id: "owner",
                turn_id: "native",
                response_id: "r1",
                usage: c(25),
                turn_token_usage: c(30),
              }),
              e("event_msg", { type: "task_complete", turn_id: "native" }),
            ]),
          ),
        );
        const results = [];
        for (let i = 0; i < 3; i++) results.push(yield* h["app.usageOverview"]({ days: 7 }));
        for (const x of results) {
          expect(x.totals.totalTokens).toBe(25);
          expect(x.totals.cacheReadTokens).toBe(5);
          expect(x.totals.uncachedInputTokens).toBe(0);
          expect(x.totals.unclassifiedInputTokens).toBe(20);
          expect(x.incompleteCacheTurns).toBe(1);
          expect(JSON.stringify(x)).not.toContain("cacheIncomplete");
          expect(JSON.stringify(x)).not.toContain("cache_incomplete");
        }
      }),
    ).pipe(Effect.provide(ThreadStore.layerSqlite(":memory:").pipe(Layer.orDie))),
);
