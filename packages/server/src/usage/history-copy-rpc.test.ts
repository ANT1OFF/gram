import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadStore } from "../persistence/thread-store.ts";
import { SqlClient } from "../platform/unstable.ts";
import { usageHandlers } from "./handler.ts";
import { UsageHistoryRoots } from "./history-roots.ts";
const at = "2026-10-06T12:00:00Z",
  time = Date.parse(at),
  e = (type: string, payload: object) => ({ type, payload, timestamp: at }),
  c = (input_tokens: number, cache = false) => ({
    input_tokens,
    output_tokens: 0,
    ...(cache ? { cached_input_tokens: 0, cache_write_input_tokens: 0 } : {}),
  });
const modes = ["larger", "covered"];
const rows = (mode: string, second: boolean) => {
  const cache = mode === "cache",
    expected = (second && mode === "larger") || mode === "covered" ? c(20, cache) : c(10, cache);
  if (second && cache) expected.cached_input_tokens = 5;
  return [
    e("session_meta", { id: "owner" }),
    e("turn_context", { turn_id: "native", model: "actual" }),
    e("token_usage_record", {
      thread_id: "owner",
      turn_id: "native",
      response_id: "r1",
      usage: c(10, cache),
      ...(second && mode === "missing" ? {} : { turn_token_usage: expected }),
    }),
    ...(second && mode === "covered"
      ? [
          e("token_usage_record", {
            thread_id: "owner",
            turn_id: "native",
            response_id: "r2",
            usage: c(10),
            turn_token_usage: c(20),
          }),
        ]
      : []),
    e("event_msg", { type: "task_complete", turn_id: "native" }),
  ];
};

for (const mode of modes)
  for (const reversed of [false, true])
    it.effect(
      `four-source READ partition retains independent requirements mode=${mode} reversed=${reversed}`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const dir = yield* Effect.acquireRelease(
              Effect.promise(() => mkdtemp(join(tmpdir(), "review-5981-copy-rpc-"))),
              (d) => Effect.promise(() => rm(d, { recursive: true, force: true })),
            );
            const order = reversed ? [true, false, true, false] : [false, true, false, true];
            for (let i = 0; i < 4; i++)
              yield* Effect.promise(() =>
                writeFile(
                  join(dir, `rollout-${i}.jsonl`),
                  rows(mode, order[i]!)
                    .map((x) => JSON.stringify(x) + "\n")
                    .join(""),
                ),
              );
            yield* TestClock.setTime(Date.parse("2026-10-12T12:00:00Z"));
            const sql = yield* SqlClient.SqlClient;
            const stored =
              '{"tokens":{"inputTokens":5,"outputTokens":0},"telemetryVersion":"codex-request-delta-v1"}';
            yield* sql`INSERT INTO projects (id,root,name) VALUES ('p','/invented','Invented')`;
            yield* sql`INSERT INTO threads (id,project_id,created_at,last_activity_at,data) VALUES ('t','p',1,1,'{}')`;
            yield* sql`INSERT INTO turns (id,thread_id,started_at,ended_at,reason,usage) VALUES ('gram','t',${time},${time + 1},'completed',${stored})`;
            const message = JSON.stringify({
              metadata: {
                agent: "codex",
                model: "actual",
                agentSessionId: "owner",
                agentMessageIds: ["native"],
              },
              parts: [],
            });
            yield* sql`INSERT INTO messages (thread_id,id,seq,role,turn_id,message) VALUES ('t','main',1,'assistant','gram',${message})`;
            const h = yield* usageHandlers.pipe(
              Effect.provideService(UsageHistoryRoots, {
                roots: Effect.succeed([{ provider: "codex" as const, dir }]),
              }),
            );
            const results = [];
            for (let i = 0; i < 3; i++) results.push(yield* h["app.usageOverview"]({ days: 7 }));
            expect(
              (yield* sql<{ usage: string }>`SELECT usage FROM turns WHERE id='gram'`)[0]!.usage,
            ).toBe(stored);
            for (const x of results) {
              expect(x.history?.selectedGramTurns).toBe(1);
              expect(x.history?.unmatchedGramTurns).toBe(mode === "covered" ? 0 : 1);
              expect(x.history?.untrustedGramTurns).toBe(0);
              expect(x.history?.ambiguousGramTurns).toBe(0);
              expect(x.history?.importedRecords).toBe(0);
              expect(JSON.stringify(x)).not.toContain("expectedTurnTokens");
              expect(JSON.stringify(x)).not.toContain("cacheIncomplete");
              expect(JSON.stringify(x)).not.toContain("fileIdentity");
              expect(x.history?.matchedTurns).toBe(
                mode === "identical" || mode === "covered" ? 1 : 0,
              );
              expect(x.totals.totalTokens).toBe(
                mode === "covered" ? 20 : mode === "identical" ? 10 : 5,
              );
              expect(JSON.stringify(x)).not.toContain(dir);
              expect(JSON.stringify(x)).not.toContain("responseRequirements");
            }
          }),
        ).pipe(Effect.provide(ThreadStore.layerSqlite(":memory:").pipe(Layer.orDie))),
    );
