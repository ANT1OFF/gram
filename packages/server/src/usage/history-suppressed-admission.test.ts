import type { TokenUsage } from "@gram/contracts";
import { makeCodexUsageLedger } from "@gram/agents/codex";
import { expect, it } from "vitest";
import { canonicalHistory } from "./history-canonical.ts";
import { makeHistoryReducer } from "./history-records.ts";

const at = "2026-10-06T12:00:00Z";
const event = (type: string, payload: object) => ({ type, payload, timestamp: at });
const context = (turn_id: string) => event("turn_context", { turn_id, model: "actual" });
const done = (turn_id: string) => event("event_msg", { type: "task_complete", turn_id });
const native = (c: TokenUsage | undefined) =>
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
    info: { total_token_usage: native(total), last_token_usage: native(last) },
  });
const input = (n: number, cacheReadTokens = 0): TokenUsage => ({
  inputTokens: n,
  outputTokens: 0,
  cacheReadTokens,
});
const seed = (prior: TokenUsage) => {
  const ledger = makeCodexUsageLedger(true),
    reducer = makeHistoryReducer("codex");
  ledger.startTurn();
  ledger.observe(prior, prior);
  ledger.endTurn();
  ledger.startTurn();
  [
    event("session_meta", { id: "session" }),
    token(
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      },
      undefined,
    ),
    context("prior"),
    token(prior, prior),
    done("prior"),
    context("suppressed"),
  ].forEach((e) => reducer.consume(e));
  return { ledger, reducer };
};
const known = (reducer: ReturnType<typeof makeHistoryReducer>) =>
  [...canonicalHistory([...reducer.records.values()]).unique.values()].reduce(
    (n, row) => n + row.tokens.inputTokens + row.tokens.outputTokens,
    0,
  );

for (const detail of ["read", "write", "reasoning", "missing"] as const) {
  for (const gap of ["none", "null", "invalid", "contradictory"] as const) {
    for (const boundary of ["same", "completed", "implicit-start"] as const) {
      it(`retains overlap admission for ${detail}/${gap}/${boundary} and recovers from a real primary change`, () => {
        const prior: TokenUsage =
          detail === "reasoning"
            ? { inputTokens: 0, outputTokens: 10, reasoningTokens: 0 }
            : detail === "write"
              ? { inputTokens: 10, outputTokens: 0, cacheWriteTokens: 0 }
              : input(10);
        const refined: TokenUsage =
          detail === "reasoning"
            ? { ...prior, reasoningTokens: 5 }
            : detail === "write"
              ? { ...prior, cacheWriteTokens: 5 }
              : detail === "missing"
                ? { inputTokens: 10, outputTokens: 0 }
                : input(10, 5);
        const { ledger, reducer } = seed(prior);
        const suppressed = ledger.observe(refined, refined);
        reducer.consume(token(refined, refined));
        if (gap === "null") {
          ledger.observe(undefined, undefined);
          reducer.consume(event("event_msg", { type: "token_count", info: null }));
        }
        if (gap === "invalid") {
          const bad = { inputTokens: -1, outputTokens: 0 };
          ledger.observe(bad, bad);
          reducer.consume(token(bad, bad));
        }
        if (gap === "contradictory") {
          ledger.observe({ inputTokens: 1, outputTokens: 0 }, input(10));
          reducer.consume(token({ inputTokens: 1, outputTokens: 0 }, input(10)));
        }
        if (boundary !== "same") {
          if (boundary === "completed") {
            ledger.endTurn();
            reducer.consume(done("suppressed"));
          }
          ledger.startTurn();
          reducer.consume(context("current"));
        } else if (gap !== "none") {
          // Restore actual native context after corrupt telemetry, not a selected model.
          reducer.consume(context("suppressed"));
        }
        const admitted = ledger.observe(undefined, refined);
        reducer.consume(token(undefined, refined));
        const repeated = ledger.observe(undefined, refined);
        reducer.consume(token(undefined, refined));
        expect({
          suppressed: suppressed.tokens,
          admitted: admitted.tokens,
          repeated: repeated.tokens,
          known: known(reducer),
        }).toEqual({ suppressed: undefined, admitted: undefined, repeated: undefined, known: 10 });
        expect(admitted.partial).toBe(true);
        expect(reducer.records.get("prior")).toMatchObject({
          session: "session",
          nativeIds: ["prior"],
          model: "actual",
          complete: true,
          tokens: prior,
        });
        const advance =
          detail === "reasoning"
            ? { ...refined, outputTokens: 20, reasoningTokens: 10 }
            : detail === "write"
              ? { ...refined, inputTokens: 20, cacheWriteTokens: 10 }
              : detail === "missing"
                ? { inputTokens: 20, outputTokens: 0 }
                : input(20, 10);
        const recovery = ledger.observe(advance, refined);
        reducer.consume(token(advance, refined));
        expect((recovery.tokens?.inputTokens ?? 0) + (recovery.tokens?.outputTokens ?? 0)).toBe(10);
        expect(known(reducer)).toBe(20);
        expect(ledger.observe(advance, refined).tokens).toBeUndefined();
        reducer.consume(token(advance, refined));
        reducer.consume(done(boundary === "same" ? "suppressed" : "current"));
        reducer.consume(token(advance, refined));
        expect(known(reducer)).toBe(20);
        expect(reducer.retainedBytes()).toBeLessThan(32 * 1024 * 1024);
      });
    }
  }
}
it("exact unchanged totals also constrain a later absent-total last without claiming an amount", () => {
  const { ledger, reducer } = seed(input(10));
  ledger.observe(input(10), input(10));
  reducer.consume(token(input(10), input(10)));
  expect(ledger.observe(undefined, input(10)).tokens).toBeUndefined();
  reducer.consume(token(undefined, input(10)));
  expect(known(reducer)).toBe(10);
});
it("overlap evidence survives explicit invalidation and equal-primary totals, with explicit zero still known", () => {
  const { ledger, reducer } = seed(input(10));
  ledger.observe(input(10, 5), input(10, 5));
  reducer.consume(token(input(10, 5), input(10, 5)));
  ledger.invalidateBaseline();
  reducer.breakContext();
  ledger.startTurn();
  expect(ledger.observe(input(10, 4), input(10, 4)).tokens).toBeUndefined();
  reducer.consume(context("after-gap"));
  reducer.consume(token(input(10, 4), input(10, 4)));
  expect(ledger.observe(undefined, { inputTokens: 0, outputTokens: 0 })).toEqual({
    tokens: { inputTokens: 0, outputTokens: 0 },
    basis: "last-request",
    partial: true,
  });
  reducer.consume(token(undefined, { inputTokens: 0, outputTokens: 0 }));
  reducer.consume(done("after-gap"));
  expect(known(reducer)).toBe(10);
  expect(reducer.records.get("after-gap")).toMatchObject({
    tokens: { inputTokens: 0, outputTokens: 0 },
    complete: true,
  });
  expect(ledger.observe(undefined, input(10, 4)).tokens).toBeUndefined();
});
it("real primary reset clears overlap admission without restoring complete cumulative continuity", () => {
  const { ledger, reducer } = seed(input(10));
  ledger.observe(input(10, 5), input(10, 5));
  reducer.consume(token(input(10, 5), input(10, 5)));
  ledger.observe(undefined, undefined);
  reducer.breakContext();
  ledger.startTurn();
  reducer.consume(context("reset"));
  expect(ledger.observe(input(3, 1), input(3, 1))).toEqual({
    tokens: input(3, 1),
    basis: "last-request",
    partial: true,
  });
  reducer.consume(token(input(3, 1), input(3, 1)));
  reducer.consume(done("reset"));
  expect(known(reducer)).toBe(13);
});
it("suppression constrains counter evidence but does not suppress independently identified per-response requests", () => {
  const { reducer } = seed(input(10));
  reducer.consume(token(input(10, 5), input(10, 5)));
  reducer.consume(token(undefined, input(10, 4)));
  const response = event("token_usage_record", {
    thread_id: "session",
    turn_id: "suppressed",
    response_id: "actual-response",
    usage: native(input(10, 5)),
    turn_token_usage: native(input(10, 5)),
  });
  reducer.consume(response);
  reducer.consume(response);
  reducer.consume(done("suppressed"));
  expect(known(reducer)).toBe(20);
  expect(
    [...canonicalHistory([...reducer.records.values()]).unique.values()].find(
      (r) => r.id === "suppressed",
    ),
  ).toMatchObject({
    tokens: input(10, 5),
    complete: true,
    nativeIds: ["suppressed"],
    model: "actual",
    session: "session",
  });
});

it("idle zero is not positive overlap evidence and first validated last remains known", () => {
  const ledger = makeCodexUsageLedger(true);
  ledger.observe({ inputTokens: 0, outputTokens: 0 }, { inputTokens: 0, outputTokens: 0 });
  ledger.startTurn();
  expect(ledger.observe(undefined, { inputTokens: 10, outputTokens: 0 })).toEqual({
    tokens: { inputTokens: 10, outputTokens: 0 },
    basis: "last-request",
    partial: true,
  });
});
it("repeated idle zero reception cannot suppress the first native partial request", () => {
  const reducer = makeHistoryReducer("codex"),
    timestamp = "2026-10-06T12:00:00Z";
  const idleToken = (total: object | undefined, last: object | undefined) => ({
    type: "event_msg",
    timestamp,
    payload: { type: "token_count", info: { total_token_usage: total, last_token_usage: last } },
  });
  const zero = { input_tokens: 0, output_tokens: 0 };
  reducer.consume({ type: "session_meta", timestamp, payload: { id: "session" } });
  reducer.consume(idleToken(zero, undefined));
  reducer.consume(idleToken(zero, zero));
  reducer.consume({
    type: "turn_context",
    timestamp,
    payload: { turn_id: "first", model: "actual" },
  });
  reducer.consume(idleToken(undefined, { input_tokens: 10, output_tokens: 0 }));
  reducer.consume({
    type: "event_msg",
    timestamp,
    payload: { type: "task_complete", turn_id: "first" },
  });
  expect(reducer.records.get("first")).toMatchObject({
    tokens: { inputTokens: 10, outputTokens: 0 },
    basis: "last-request",
    partial: true,
    complete: true,
    session: "session",
    nativeIds: ["first"],
  });
});
