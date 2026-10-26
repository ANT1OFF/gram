import { makeCodexUsageLedger } from "@gram/agents/codex";
import type { TokenUsage } from "@gram/contracts";
import { expect, it } from "vitest";
import { makeHistoryReducer } from "./history-records.ts";

const at = "2026-10-06T12:00:00Z";
const event = (type: string, payload: object) => ({ type, payload, timestamp: at });
const context = (turn_id: string) => event("turn_context", { turn_id, model: "actual" });
const done = (turn_id: string) => event("event_msg", { type: "task_complete", turn_id });
const primary = (inputTokens: number, outputTokens: number): TokenUsage => ({
  inputTokens,
  outputTokens,
});
const wire = (c: TokenUsage | undefined) =>
  c === undefined
    ? undefined
    : {
        input_tokens: c.inputTokens,
        output_tokens: c.outputTokens,
        cached_input_tokens: c.cacheReadTokens,
        cache_write_input_tokens: c.cacheWriteTokens,
        reasoning_output_tokens: c.reasoningTokens,
      };
const token = (total: TokenUsage | undefined, last: TokenUsage | undefined) =>
  event("event_msg", {
    type: "token_count",
    info: { total_token_usage: wire(total), last_token_usage: wire(last) },
  });
const known = (r: ReturnType<typeof makeHistoryReducer>) =>
  [...r.records.values()].reduce(
    (n, record) => n + record.tokens.inputTokens + record.tokens.outputTokens,
    0,
  );
const seed = () => {
  const ledger = makeCodexUsageLedger(true),
    reducer = makeHistoryReducer("codex");
  const zero = { ...primary(0, 0), cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
  const prior = { ...primary(10, 10), cacheReadTokens: 0, reasoningTokens: 0 };
  const stable = { ...prior, cacheReadTokens: 5, reasoningTokens: 5 };
  ledger.startTurn();
  ledger.observe(prior, prior);
  ledger.endTurn();
  ledger.startTurn();
  [
    event("session_meta", { id: "session" }),
    token(zero, undefined),
    context("prior"),
    token(prior, prior),
    done("prior"),
    context("suppressed"),
    token(stable, stable),
  ].forEach((e) => reducer.consume(e));
  expect(ledger.observe(stable, stable).tokens).toBeUndefined();
  return { ledger, reducer, stable };
};
for (const gap of ["null", "invalid", "contradictory", "discard"] as const) {
  for (const growth of [primary(5, 10), primary(5, 0), primary(0, 10)]) {
    for (const candidate of [
      "smaller",
      "equal",
      "over-input",
      "over-output",
      "missing",
      "zero",
    ] as const) {
      it(`quantitative ${gap}/${JSON.stringify(growth)}/${candidate} preserves gap uncertainty and later recovery`, () => {
        const { ledger, reducer } = seed();
        if (gap === "null") {
          ledger.observe(undefined, undefined);
          reducer.consume(token(undefined, undefined));
        }
        if (gap === "invalid") {
          const bad = primary(-1, 0);
          ledger.observe(bad, bad);
          reducer.consume(token(bad, bad));
        }
        if (gap === "contradictory") {
          ledger.observe(primary(1, 1), primary(10, 10));
          reducer.consume(token(primary(1, 1), primary(10, 10)));
        }
        if (gap === "discard") {
          ledger.invalidateBaseline();
          reducer.breakContext();
        }
        ledger.endTurn();
        ledger.startTurn();
        reducer.consume(context("current"));
        const total = {
          ...primary(10 + growth.inputTokens, 10 + growth.outputTokens),
          cacheReadTokens: 7,
          reasoningTokens: 7,
        };
        const last =
          candidate === "missing"
            ? undefined
            : candidate === "zero"
              ? primary(0, 0)
              : candidate === "smaller"
                ? primary(Math.max(0, growth.inputTokens - 2), Math.max(0, growth.outputTokens - 2))
                : candidate === "equal"
                  ? growth
                  : candidate === "over-input"
                    ? primary(growth.inputTokens + 1, Math.max(0, growth.outputTokens - 1))
                    : primary(Math.max(0, growth.inputTokens - 1), growth.outputTokens + 1);
        const supported =
          last !== undefined &&
          last.inputTokens <= growth.inputTokens &&
          last.outputTokens <= growth.outputTokens;
        const report = ledger.observe(total, last);
        reducer.consume(token(total, last));
        expect(report).toEqual(
          supported ? { tokens: last, basis: "last-request", partial: true } : { partial: true },
        );
        expect(known(reducer)).toBe(20 + (supported ? last!.inputTokens + last!.outputTokens : 0));
        expect(reducer.records.get("prior")).toMatchObject({
          tokens: { inputTokens: 10, outputTokens: 10 },
          nativeIds: ["prior"],
          session: "session",
          model: "actual",
          complete: true,
        });
        expect(ledger.observe(total, last).tokens).toBeUndefined();
        reducer.consume(token(total, last));
        const replay = last ?? primary(10, 10);
        expect(ledger.observe(undefined, replay).tokens).toBeUndefined();
        reducer.consume(token(undefined, replay));
        // Both continued cumulative evidence and the old admission constraint must stay separate.
        ledger.endTurn();
        ledger.startTurn();
        reducer.consume(done("current"));
        reducer.consume(context("recovery"));
        const actualLast = primary(5, 2),
          actualTotal = primary(total.inputTokens + 5, total.outputTokens + 2);
        expect(ledger.observe(actualTotal, actualLast)).toEqual({
          tokens: actualLast,
          basis: "last-request",
          partial: true,
        });
        reducer.consume(token(actualTotal, actualLast));
        reducer.consume(done("recovery"));
        expect(known(reducer)).toBe(27 + (supported ? last!.inputTokens + last!.outputTokens : 0));
        expect(reducer.records.get("recovery")).toMatchObject({
          tokens: actualLast,
          basis: "last-request",
          partial: true,
          nativeIds: ["recovery"],
          session: "session",
          model: "actual",
          complete: true,
        });
        expect(reducer.retainedBytes()).toBeLessThan(32 * 1024 * 1024);
      });
    }
  }
}
it("a valid no-gap delta smaller than last retains overlap evidence across a later gap", () => {
  const ledger = makeCodexUsageLedger(true);
  ledger.startTurn();
  ledger.observe(primary(10, 0), primary(10, 0));
  ledger.endTurn();
  ledger.startTurn();
  expect(ledger.observe(primary(15, 0), primary(10, 0))).toEqual({
    tokens: primary(5, 0),
    basis: "delta",
    partial: false,
  });
  ledger.observe(undefined, undefined);
  ledger.endTurn();
  ledger.startTurn();
  expect(ledger.observe(primary(20, 0), primary(10, 0))).toEqual({ partial: true });
  expect(ledger.observe(undefined, primary(10, 0))).toEqual({ partial: true });
  expect(ledger.observe(primary(25, 0), primary(5, 0))).toEqual({
    tokens: primary(5, 0),
    basis: "last-request",
    partial: true,
  });
});
it("a monotonic output increase cannot certify input last merely by matching total token growth", () => {
  const { ledger, reducer } = seed();
  ledger.observe(undefined, undefined);
  reducer.consume(token(undefined, undefined));
  ledger.endTurn();
  ledger.startTurn();
  reducer.consume(context("current"));
  expect(ledger.observe(primary(10, 20), primary(10, 0))).toEqual({ partial: true });
  reducer.consume(token(primary(10, 20), primary(10, 0)));
  reducer.consume(done("current"));
  expect(known(reducer)).toBe(20);
});
it("observed primary decrease is reset evidence, distinct from an unproved hidden reset on growth", () => {
  const { ledger } = seed();
  ledger.observe(undefined, undefined);
  ledger.endTurn();
  ledger.startTurn();
  expect(ledger.observe(primary(3, 1), primary(3, 1))).toEqual({
    tokens: primary(3, 1),
    basis: "last-request",
    partial: true,
  });
});
