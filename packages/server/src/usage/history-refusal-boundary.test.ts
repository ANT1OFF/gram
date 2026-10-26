import { expect, it, vi } from "vitest";
import type * as Coverage from "./codex-history-coverage.ts";

const { instances } = vi.hoisted(() => ({
  instances: [] as ReturnType<typeof Coverage.makeCodexHistoryCoverage>[],
}));
vi.mock("./codex-history-coverage.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof Coverage>();
  return {
    ...actual,
    makeCodexHistoryCoverage: () => {
      const helper = actual.makeCodexHistoryCoverage();
      instances.push(helper);
      return helper;
    },
  };
});
import { makeHistoryReducer } from "./history-records.ts";
import { canonicalHistory } from "./history-canonical.ts";
import { makeCodexUsageLedger } from "@gram/agents/codex";

const old = Date.parse("2026-09-01T12:00:00Z"),
  at = Date.parse("2026-10-06T12:00:00Z");
const counts = (input_tokens: number) => ({ input_tokens, output_tokens: 0 });
const event = (type: string, payload: object, time = at) => ({
  type,
  payload,
  timestamp: new Date(time).toISOString(),
});
const context = (turn_id: string, time = at) =>
  event("turn_context", { turn_id, model: "actual" }, time);
const token = (total: number, last?: number, time = at) =>
  event(
    "event_msg",
    {
      type: "token_count",
      info: {
        total_token_usage: counts(total),
        ...(last === undefined ? {} : { last_token_usage: counts(last) }),
      },
    },
    time,
  );
const done = (turn_id: string, time = at) =>
  event("event_msg", { type: "task_complete", turn_id }, time);
const modern = (response_id: string, amount: number, total: number) =>
  event(
    "token_usage_record",
    {
      thread_id: "session",
      turn_id: "old",
      response_id,
      usage: counts(amount),
      turn_token_usage: counts(total),
    },
    old,
  );
const prepare = (last: number | undefined, includeOld: boolean, eager: boolean) => {
  const reducer = makeHistoryReducer("codex", includeOld ? -Infinity : at, Infinity);
  const rows = [
    event("session_meta", { id: "session" }, old),
    token(0, undefined, old),
    context("old", old),
    token(100, 100, old),
    modern("r1", 100, 100),
    done("old", old),
    context("new"),
    token(210, last),
    done("new"),
  ];
  for (const row of rows) {
    reducer.consume(row);
    if (eager) void reducer.records;
  }
  void reducer.records;
  return { reducer, helper: instances.at(-1)! };
};

for (const last of [10, 0, undefined])
  for (const includeOld of [false, true])
    for (const eager of [false, true])
      for (const spare of [0, 1, 2, 3, 10])
        it(`actual shared-work refusal conserves evidence last=${last}, old=${includeOld}, eager=${eager}, spare=${spare}`, () => {
          // Measure actual successful reservations on a disposable identical graph.
          // No limit, counter result or production method is replaced by the wrapper.
          const diagnostic = prepare(last, includeOld, eager);
          let available = 0;
          while (diagnostic.helper.repairBudget(1)) {
            available++;
            if (available > 50_000) throw new Error("unbounded repair budget");
          }
          expect(available).toBeLessThan(50_000);
          const { reducer, helper } = prepare(last, includeOld, eager);
          const captured = structuredClone(reducer.records.get("new")!);
          expect(captured.tokens.inputTokens).toBe(110);
          expect(helper.repairBudget(available - spare)).toBe(true);
          reducer.consume(modern("r2", 100, 200));
          for (let i = 0; i < 5; i++) {
            const selected = reducer.records.get("new");
            if (last === undefined) expect(selected).toBeUndefined();
            else {
              expect(selected).toMatchObject({
                tokens: { inputTokens: last, outputTokens: 0 },
                partial: true,
                basis: "last-request",
              });
              expect([selected?.at, selected?.session, selected?.nativeIds]).toEqual([
                captured.at,
                captured.session,
                captured.nativeIds,
              ]);
            }
            if (includeOld) expect(reducer.records.get("old")?.tokens.inputTokens).toBe(100);
          }
          reducer.consume(done("old", old));
          const canonical = [...canonicalHistory([...reducer.records.values()]).unique.values()];
          expect(canonical.reduce((n, row) => n + row.tokens.inputTokens, 0)).toBe(
            (includeOld ? 200 : 0) + (last ?? 0),
          );
          // A subsequent real request remains known even if permanent work exhaustion
          // prevents complete cumulative attribution. Closed counter replay stays refused.
          reducer.consume(context("next"));
          reducer.consume(token(220, 10));
          reducer.consume(done("next"));
          expect(reducer.records.get("next")?.tokens.inputTokens).toBe(10);
          expect(instances.at(-1)).toBe(helper);
        });

it("a smaller proved primary increment cannot inherit a larger overlapping last on auxiliary failure", () => {
  const ledger = makeCodexUsageLedger(true);
  ledger.startTurn();
  ledger.observe(
    { inputTokens: 10, outputTokens: 0, cacheReadTokens: 0 },
    { inputTokens: 10, outputTokens: 0, cacheReadTokens: 0 },
  );
  ledger.endTurn();
  ledger.startTurn();
  const report = ledger.observe(
    { inputTokens: 15, outputTokens: 0, cacheReadTokens: 7 },
    { inputTokens: 10, outputTokens: 0, cacheReadTokens: 7 },
  );
  expect(report).toEqual({
    tokens: { inputTokens: 5, outputTokens: 0 },
    basis: "delta",
    partial: true,
  });
  expect(ledger.detailConflict()).toBe(true);
});
it("primary counter recovery with missing last retains only its proved increment", () => {
  const ledger = makeCodexUsageLedger(true);
  ledger.startTurn();
  ledger.observe(
    { inputTokens: 10, outputTokens: 0, cacheReadTokens: 0 },
    { inputTokens: 10, outputTokens: 0, cacheReadTokens: 0 },
  );
  ledger.endTurn();
  ledger.startTurn();
  expect(
    ledger.observe({ inputTokens: 15, outputTokens: 0, cacheReadTokens: 7 }, undefined),
  ).toEqual({ tokens: { inputTokens: 5, outputTokens: 0 }, basis: "delta", partial: true });
});
